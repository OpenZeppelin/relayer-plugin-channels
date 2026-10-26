/**
 * handler.ts
 *
 * Main handler for the channel accounts plugin.
 * Orchestrates the transaction processing pipeline using channel accounts with fee bumping.
 */

import { PluginContext, pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginAPI, PluginKVStore, Relayer, StellarTransactionResponse } from '@openzeppelin/relayer-sdk';
import { PoolLock, ChannelPool, AcquireOptions } from './pool';
import { loadConfig, getNetworkPassphrase, ChannelAccountsConfig } from './config';
import { ChannelAccountsResponse } from './types';
import { validateAndParseRequest } from './validation';
import { isManagementRequest, handleManagement } from './management';
import {
  isSendRejected,
  isTransactionNotFound,
  notSubmittedError,
  isNotSubmitted,
  onchainFailedError,
  RELAYER_IN_PROGRESS_MESSAGE,
  RELAYER_TRANSACTION_GONE_MESSAGE,
  sendFeeBump,
  signWithChannelAndFund,
  submitWithFeeBumpAndWait,
  SubmitContext,
} from './submit';
import { HTTP_STATUS, IDEMPOTENCY, POOL, RELAYER_INFO_CACHE_TTL_SECONDS } from './constants';
import { Transaction, xdr } from '@stellar/stellar-sdk';
import { simulateTransaction, buildWithChannel } from './simulation';
import { calculateMaxFee, getContractIdFromFunc, InclusionFees, getContractIdFromTransaction } from './fee';
import {
  parseFundRelayerOverrides,
  resolveInclusionFees,
  resolveTimeouts,
  resolveTransactionParams,
} from './fund-relayer-config';
import { validateExistingTransactionForSubmitOnly } from './tx';
import { FeeTracker } from './fee-tracking';
import { getSequence, commitSequence, clearSequence } from './sequence';
import {
  describeStoredTransaction,
  effectiveIdempotencyTtlSec,
  FeeBumpPayload,
  feeMarkerTtlSec,
  fundRelayerIdempotencyKey,
  getIdempotencyKey,
  idempotencyFeeKey,
  idempotencyRecordKey,
  idempotencyScope,
  IdempotencyReservation,
  inProgressError,
  markSendRejected,
  outcomeUnknownError,
  recordIdempotentTransaction,
  releaseIdempotencyKey,
  requestFingerprint,
  sendFailedError,
  hasStoredTransactionExpired,
  reserveIdempotencyKey,
  storeIdempotentPayload,
} from './idempotency';

/** Subset of relayer metadata used by the plugin (address + network_type). */
type CachedRelayerInfo = { address: string; network_type: string };
type CacheEntry = { info: CachedRelayerInfo; expiresAt: number };

/**
 * In-memory cache for relayer info. Avoids a remote API call (getRelayer → HTTP GET)
 * on every request while a channel lock is held. Keyed by `${network}:${relayerId}`.
 * Entries expire after RELAYER_INFO_CACHE_TTL_SECONDS; stale entries are evicted on miss.
 */
const relayerInfoCache = new Map<string, CacheEntry>();

/** @internal Exported for test isolation only. */
export function clearRelayerInfoCache(): void {
  relayerInfoCache.clear();
}

/**
 * Return cached relayer info or fetch from the API and cache the result.
 * Returns null if the relayer has no address (misconfigured).
 */
export async function getCachedRelayerInfo(
  network: string,
  relayerId: string,
  relayer: Relayer
): Promise<CachedRelayerInfo | null> {
  const cacheKey = `${network}:${relayerId}`;
  const cached = relayerInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  // Evict stale entry so it doesn't linger in memory
  if (cached) relayerInfoCache.delete(cacheKey);

  const info = await relayer.getRelayer();
  if (!info?.address) return null;
  const entry: CachedRelayerInfo = { address: info.address, network_type: info.network_type };
  relayerInfoCache.set(cacheKey, { info: entry, expiresAt: Date.now() + RELAYER_INFO_CACHE_TTL_SECONDS * 1000 });
  return entry;
}

interface PipelineContext {
  api: PluginAPI;
  kv: PluginKVStore;
  pool: ChannelPool;
  fundRelayer: Relayer;
  fundAddress: string;
  network: 'testnet' | 'mainnet';
  networkPassphrase: string;
  acquireOptions: AcquireOptions;
  fees: InclusionFees;
  tracker: FeeTracker | undefined;
  config: ChannelAccountsConfig;
  startTime: number;
  /** Called with the exact payload before it is sent */
  beforeSubmit?: (payload: FeeBumpPayload) => Promise<void>;
  /** Called once the fund relayer has created the transaction */
  onSubmitted?: (transactionId: string) => Promise<void>;
  /** Fund relayer idempotency key for the send */
  fundRelayerIdempotencyKey?: string;
  /** Called when the fund relayer answered the send with an error (see isSendRejected) */
  onSendRejected?: () => Promise<void>;
  /** When set, the fee is recorded once per transaction under this marker key */
  feeMarkerKey?: string;
  /** How long the fee marker is kept */
  feeMarkerTtlSec?: number;
}

function getApiKey(headers: Record<string, string[]>, headerName: string): string | undefined {
  const values = headers[headerName];
  return values?.[0]?.trim() || undefined;
}

/**
 * Compute how long a channel lock should be extended based on remaining tx validity.
 * The tx maxTime was set to ~(txBuildTime + maxTimeBoundOffsetSeconds) at build time.
 * We add one ledger cooldown as margin for the tx to finalize after expiry.
 */
function computeExtendTtlSec(txBuildTime: number, maxTimeBoundOffsetSeconds: number): number {
  const txExpiryMs = txBuildTime + maxTimeBoundOffsetSeconds * 1000;
  const remainingMs = txExpiryMs - Date.now() + POOL.CHANNEL_COOLDOWN_MS;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Extracts func and auth from an unsigned Soroban transaction.
 * Returns null if the transaction is not a single invokeHostFunction operation.
 */
export function extractFuncAuthFromUnsignedXdr(
  tx: Transaction
): { func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] } | null {
  const ops = tx.operations;
  if (ops.length !== 1) {
    return null;
  }

  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    return null;
  }
  const rawOp = envelope.v1.tx.operations[0].body;

  if (rawOp.type !== 'invokeHostFunction') {
    return null;
  }

  const invokeHostFn = rawOp.invokeHostFunctionOp;
  return {
    func: invokeHostFn.hostFunction,
    auth: [...invokeHostFn.auth],
  };
}

async function handleXdrSubmit(
  xdrStr: string,
  ctx: PipelineContext,
  skipWait?: boolean
): Promise<ChannelAccountsResponse> {
  const tx = new Transaction(xdrStr, ctx.networkPassphrase);

  // Unsigned XDR: extract func+auth and route through channel path
  if (tx.signatures.length === 0) {
    const extracted = extractFuncAuthFromUnsignedXdr(tx);
    if (!extracted) {
      throw pluginError('Unsigned XDR must contain exactly one invokeHostFunction operation', {
        code: 'INVALID_UNSIGNED_XDR',
        status: HTTP_STATUS.BAD_REQUEST,
        details: {
          operationCount: tx.operations.length,
          operationType: tx.operations[0]?.type,
        },
      });
    }

    console.log(`[channels] Unsigned XDR detected, extracting func+auth and routing through channel path`);
    // Update acquireOptions with contractId from extracted func
    const contractId = getContractIdFromFunc(extracted.func);
    const updatedOptions: AcquireOptions = { ...ctx.acquireOptions, contractId };
    return handleFuncAuthSubmit(extracted.func, extracted.auth, { ...ctx, acquireOptions: updatedOptions }, skipWait);
  }

  const validated = validateExistingTransactionForSubmitOnly(tx, ctx.config);
  // Under an Idempotency-Key a stored transaction is resent until it lands or
  // expires; one that never expires would keep its key retrying for ever
  if (ctx.fundRelayerIdempotencyKey && !(Number(validated.timeBounds?.maxTime ?? 0) > 0)) {
    throw pluginError('A signed XDR sent with an Idempotency-Key must set timeBounds.maxTime', {
      code: 'TIMEBOUNDS_REQUIRED',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }
  const maxFee = calculateMaxFee(validated, ctx.acquireOptions.limitedContracts, ctx.fees);
  const contractId = getContractIdFromTransaction(validated);
  await ctx.tracker?.checkBudget(maxFee);
  const submitContext: SubmitContext = {
    contractId,
    isLimited: contractId ? ctx.acquireOptions.limitedContracts.has(contractId) : false,
    beforeSubmit: ctx.beforeSubmit,
    onSubmitted: ctx.onSubmitted,
    onSendRejected: ctx.onSendRejected,
    fundRelayerIdempotencyKey: ctx.fundRelayerIdempotencyKey,
    feeMarkerKey: ctx.feeMarkerKey,
    feeMarkerTtlSec: ctx.feeMarkerTtlSec,
  };
  return submitWithFeeBumpAndWait(
    ctx.fundRelayer,
    validated.toXdr(),
    ctx.network,
    maxFee,
    ctx.api,
    ctx.startTime,
    ctx.tracker,
    submitContext,
    skipWait,
    ctx.config
  );
}

async function handleFuncAuthSubmit(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  ctx: PipelineContext,
  skipWait?: boolean
): Promise<ChannelAccountsResponse> {
  // Simulate once — used for both read-only detection and transaction assembly
  const simulation = await simulateTransaction(
    func,
    auth,
    ctx.fundAddress,
    ctx.fundRelayer,
    ctx.networkPassphrase,
    ctx.config.maxTimeBoundOffsetSeconds
  );

  if (simulation.isReadOnly) {
    console.log(`[channels] Read-only call detected, returning simulation result`);
    return {
      transactionId: null,
      status: 'readonly',
      hash: null,
      returnValue: simulation.returnValue,
      latestLedger: simulation.latestLedger,
    };
  }

  let poolLock: PoolLock | undefined;
  let needsCooldown = false;
  try {
    poolLock = await ctx.pool.acquire(ctx.acquireOptions);
    const channelRelayer = ctx.api.useRelayer(poolLock.relayerId);
    const channelInfo = await getCachedRelayerInfo(ctx.network, poolLock.relayerId, channelRelayer);
    console.log(`[channels] Acquired channel: ${poolLock.relayerId}`);
    if (!channelInfo || !channelInfo.address) {
      throw pluginError('Channel relayer not found', {
        code: 'RELAYER_UNAVAILABLE',
        status: HTTP_STATUS.BAD_GATEWAY,
        details: { relayerId: poolLock.relayerId },
      });
    }
    if (channelInfo.network_type !== 'stellar') {
      throw pluginError('Channel relayer network type must be stellar', {
        code: 'UNSUPPORTED_NETWORK',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { network_type: channelInfo.network_type, relayerId: poolLock.relayerId },
      });
    }

    const sequence = await getSequence(
      ctx.kv,
      ctx.network,
      channelRelayer,
      channelInfo.address,
      ctx.config.sequenceNumberCacheMaxAgeMs
    );

    // Assemble the transaction using the cached simulation result — no second RPC call
    const txBuildTime = Date.now();
    const built = buildWithChannel(
      func,
      auth,
      { address: channelInfo.address, sequence },
      ctx.networkPassphrase,
      simulation.rawSimResult,
      ctx.config.minSignatureExpirationLedgerBuffer,
      ctx.config.maxTimeBoundOffsetSeconds
    );
    console.debug(
      `[channels] After assembly: built.fee=${built.fee}, minResourceFee=${simulation.rawSimResult.minResourceFee}`
    );

    const signedTx = await signWithChannelAndFund(
      built,
      channelRelayer,
      ctx.fundRelayer,
      channelInfo.address,
      ctx.fundAddress,
      ctx.networkPassphrase
    );

    const maxFee = calculateMaxFee(signedTx, ctx.acquireOptions.limitedContracts, ctx.fees);
    console.debug(`[channels] After signing: signedTx.fee=${signedTx.fee}, maxFee=${maxFee}`);
    const contractId = getContractIdFromFunc(func);
    await ctx.tracker?.checkBudget(maxFee);
    // Track the send so a failure after it started keeps the channel locked
    // while the transaction may be pending on this channel's sequence (the
    // reply was lost, or bookkeeping failed after it was accepted).
    //
    // Without an Idempotency-Key a fund relayer error frees the channel,
    // although the Relayer may have stored the transaction and submit it
    // later. Holding the channel on every error would exhaust the pool during
    // a relayer outage. On the channel a wrong guess only makes the next
    // transaction share the sequence, so one of the two fails; but a caller
    // who resubmits after the error can execute twice, which is what an
    // Idempotency-Key prevents.
    //
    // Under a key the channel is kept: a repeat resends the stored transaction
    // on this channel's sequence, so releasing it would let another request
    // build on the same sequence. The cost is that during a fund relayer
    // outage each keyed request holds its channel until its transaction
    // expires, so keyed traffic can use up the pool.
    const resendable = ctx.fundRelayerIdempotencyKey !== undefined;
    // Set once the payload store is attempted: a write that lands but throws
    // leaves a payload a repeat will resend on this channel's sequence
    let payloadStoreStarted = false;
    let sendStarted = false;
    let sendRejected = false;
    const submitContext: SubmitContext = {
      contractId,
      isLimited: contractId ? ctx.acquireOptions.limitedContracts.has(contractId) : false,
      beforeSubmit: async (payload) => {
        // Hold the channel until the transaction expires before sending, so it
        // stays locked however long the send takes or if its reply is lost,
        // and never for less than the usual lock TTL, which covers the wait.
        // A lock that cannot be confirmed means another request may use this
        // sequence.
        const held = await ctx.pool.renewLock(
          poolLock!,
          Math.max(ctx.config.lockTtlSeconds, computeExtendTtlSec(txBuildTime, ctx.config.maxTimeBoundOffsetSeconds))
        );
        if (!held) {
          throw pluginError('Could not confirm the channel account lock before sending', {
            code: 'CHANNEL_LOCK_LOST',
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            details: { relayerId: poolLock!.relayerId },
          });
        }
        payloadStoreStarted = true;
        await ctx.beforeSubmit?.(payload);
        sendStarted = true;
      },
      onSubmitted: ctx.onSubmitted,
      onSendRejected: async () => {
        sendRejected = true;
        await ctx.onSendRejected?.();
      },
      fundRelayerIdempotencyKey: ctx.fundRelayerIdempotencyKey,
      feeMarkerKey: ctx.feeMarkerKey,
      feeMarkerTtlSec: ctx.feeMarkerTtlSec,
    };
    try {
      const result = await submitWithFeeBumpAndWait(
        ctx.fundRelayer,
        signedTx.toXdr(),
        ctx.network,
        maxFee,
        ctx.api,
        ctx.startTime,
        ctx.tracker,
        submitContext,
        skipWait,
        ctx.config
      );
      if (result.status === 'pending' || result.status === 'sent' || result.status === 'submitted') {
        const extendSec = computeExtendTtlSec(txBuildTime, ctx.config.maxTimeBoundOffsetSeconds);
        console.log(`[channels]: extending lock (${extendSec}s) and clearing sequence`);
        await ctx.pool.extendLock(poolLock!, extendSec);
        await clearSequence(ctx.kv, ctx.network, channelInfo.address);
        poolLock = undefined; // skip release in finally
      } else if (result.status === 'confirmed') {
        await commitSequence(ctx.kv, ctx.network, channelInfo.address, sequence);
      } else {
        // Unknown status — uncertain outcome → release with cooldown
        await clearSequence(ctx.kv, ctx.network, channelInfo.address);
        needsCooldown = true;
      }
      return result;
    } catch (error: any) {
      await clearSequence(ctx.kv, ctx.network, channelInfo.address);

      // Once the send has started, only an on-chain failure, a transaction the
      // Relayer failed before submitting, or a rejected send that will not be
      // resent, is a known outcome
      const settled = error.code === 'ONCHAIN_FAILED' || error.code === 'TRANSACTION_NOT_SUBMITTED';
      const outcomeUnknown =
        error.code === 'WAIT_TIMEOUT' ||
        (sendStarted && (!sendRejected || resendable) && !settled) ||
        (resendable && payloadStoreStarted && !sendStarted);
      if (outcomeUnknown && poolLock) {
        const extendSec = computeExtendTtlSec(txBuildTime, ctx.config.maxTimeBoundOffsetSeconds);
        console.log(`[channels] Extending lock for unknown submission outcome (${extendSec}s)`);
        await ctx.pool.extendLock(poolLock, extendSec);
        poolLock = undefined; // skip release in finally
      } else if (error.code === 'ONCHAIN_FAILED') {
        // Sequence was consumed (tx landed on chain) — cooldown prevents
        // next acquirer from hitting stale RPC and reusing old sequence
        needsCooldown = true;
      }
      throw error;
    }
  } finally {
    if (poolLock) {
      if (needsCooldown) {
        await ctx.pool.releaseWithCooldown(poolLock);
      } else {
        await ctx.pool.release(poolLock);
      }
    }
  }
}

/**
 * Charges a transaction sent under an Idempotency-Key against the API key's
 * fee budget, once across the original request and all repeats.
 */
async function chargeIdempotentFeeOnce(
  tracker: FeeTracker | undefined,
  reservation: IdempotencyReservation,
  maxFee: number | undefined,
  final: { status: string; hash?: string | null; status_reason?: string | null }
): Promise<void> {
  // Only a final transaction that reached the network has used its fee, as
  // for a request without a key
  const charged = final.status === 'confirmed' || (final.status === 'failed' && !isNotSubmitted(final));
  if (!tracker || maxFee === undefined || !charged) return;
  await tracker.recordUsageOnce(maxFee, idempotencyFeeKey(reservation), feeMarkerTtlSec(reservation));
}

/**
 * The response for a transaction found under an Idempotency-Key: a failure is
 * reported as the first request would have.
 */
function idempotentResult(
  final: { id: string; status: string; hash?: string | null; status_reason?: string | null },
  network: 'testnet' | 'mainnet'
): ChannelAccountsResponse {
  if (final.status === 'failed') {
    throw isNotSubmitted(final) ? notSubmittedError(final) : onchainFailedError(final, network);
  }
  return { transactionId: final.id, status: final.status, hash: final.hash ?? null };
}

async function channelAccounts(context: PluginContext): Promise<ChannelAccountsResponse> {
  const startTime = Date.now();
  const { api, kv, params, headers, config: pluginConfig } = context;

  // Management branch: handle and return immediately
  if (isManagementRequest(params)) {
    return await handleManagement(context);
  }

  // Load config and initialize per-request dependencies
  const config = loadConfig();
  const pool = new ChannelPool(config.network, kv, config.lockTtlSeconds);
  const networkPassphrase = getNetworkPassphrase(config.network);

  // Fee tracking setup
  let tracker: FeeTracker | undefined;
  const apiKey = getApiKey(headers, config.apiKeyHeader);

  // If default limit is set, require API key
  if (config.feeLimit !== undefined && !apiKey) {
    throw pluginError('API key required', {
      code: 'API_KEY_REQUIRED',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Create tracker if API key is present (for tracking and custom limits)
  if (apiKey) {
    tracker = new FeeTracker({
      kv,
      network: config.network,
      apiKey,
      defaultLimit: config.feeLimit,
      resetPeriodMs: config.feeResetPeriodMs,
    });
  }

  // Validate and parse request (xdr OR func+auth)
  const request = validateAndParseRequest(params);
  console.debug(
    `[channels] Request type: ${request.type}, auth entries: ${request.type === 'func-auth' ? request.auth.length : 'N/A'}`
  );

  // Get fund relayer (use alternative fund relayer when requested)
  let fundRelayerId = config.fundRelayerId;
  if (request.fundRelayerId) {
    if (!config.allowedFundRelayerIds.has(request.fundRelayerId)) {
      throw pluginError(`Fund relayer '${request.fundRelayerId}' is not in the allowed list`, {
        code: 'CONFIG_MISSING',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { fundRelayerId: request.fundRelayerId },
      });
    }
    fundRelayerId = request.fundRelayerId;
  }
  const fundRelayer = api.useRelayer(fundRelayerId);

  // 2a. Handle get-transaction early — no pool, channel, or simulation needed
  if (request.type === 'get-transaction') {
    const res = await (fundRelayer as Relayer).getTransaction({ transactionId: request.transactionId });
    const stellar = res as { id: string; status: string; hash?: string };
    return {
      transactionId: stellar.id,
      status: stellar.status,
      hash: stellar.hash ?? null,
    };
  }

  // Submissions only: validate the Idempotency-Key header before any work
  const idempotencyKey = getIdempotencyKey(headers);
  const scope = idempotencyKey ? idempotencyScope(headers, apiKey) : undefined;

  // 3. Resolve per-fund-relayer overrides and fetch fund relayer info in parallel
  const fundOverrides = parseFundRelayerOverrides(pluginConfig, fundRelayerId);
  const [fundInfo, fees] = await Promise.all([
    getCachedRelayerInfo(config.network, fundRelayerId, fundRelayer as Relayer),
    resolveInclusionFees(fundOverrides, config, fundRelayer as Relayer, kv),
  ]);
  if (!fundInfo || !fundInfo.address) {
    throw pluginError('Fund relayer not found', {
      code: 'RELAYER_UNAVAILABLE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { relayerId: fundRelayerId },
    });
  }
  if (fundInfo.network_type !== 'stellar') {
    throw pluginError('Fund relayer network type must be stellar', {
      code: 'UNSUPPORTED_NETWORK',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { network_type: fundInfo.network_type, relayerId: fundRelayerId },
    });
  }

  // 4. Build acquire options and resolve remaining overrides
  const acquireOptions: AcquireOptions = {
    limitedContracts: config.limitedContracts,
    capacityRatio: config.contractCapacityRatio,
  };
  const timeouts = resolveTimeouts(fundOverrides, config);
  const txParams = resolveTransactionParams(fundOverrides, config);
  const effectiveConfig: ChannelAccountsConfig = {
    ...config,
    globalTimeoutMs: timeouts.globalTimeoutMs,
    pollingTimeoutMs: timeouts.pollingTimeoutMs,
    maxTimeBoundOffsetSeconds: txParams.maxTimeBoundOffsetSeconds,
    minSignatureExpirationLedgerBuffer: txParams.minSignatureExpirationLedgerBuffer,
  };

  // 5. Build pipeline context
  const ctx: PipelineContext = {
    api,
    kv,
    pool,
    fundRelayer: fundRelayer as Relayer,
    fundAddress: fundInfo.address,
    network: config.network,
    networkPassphrase,
    acquireOptions,
    fees,
    tracker,
    config: effectiveConfig,
    startTime,
  };

  // 6. Branch by request type
  const submit = (pipeline: PipelineContext): Promise<ChannelAccountsResponse> => {
    if (request.type === 'xdr') {
      console.log(`[channels] Flow: XDR submit-only`);
      return handleXdrSubmit(request.xdr, pipeline, request.skipWait);
    }

    // Extract contractId for func+auth flow
    const contractId = getContractIdFromFunc(request.func);
    const funcAcquireOptions: AcquireOptions = { ...acquireOptions, contractId };

    console.log(`[channels] Flow: func+auth with channel account`);
    return handleFuncAuthSubmit(
      request.func,
      request.auth,
      { ...pipeline, acquireOptions: funcAcquireOptions },
      request.skipWait
    );
  };

  if (!idempotencyKey) {
    return await submit(ctx);
  }

  // 7. Idempotent submission: return the transaction an earlier request with
  // this key created, resend the payload it stored if its reply was lost, or
  // reserve the key and store the payload before sending.
  // Until it sends, a reservation is in flight for at most the request budget;
  // the record must outlive that and the send reply window
  const reservationWindowMs =
    effectiveConfig.globalTimeoutMs + effectiveConfig.maxTimeBoundOffsetSeconds * 1000 + POOL.CHANNEL_COOLDOWN_MS;
  const sendWindowMs = IDEMPOTENCY.SEND_REPLY_WINDOW_MS;
  const reserved = await reserveIdempotencyKey(
    kv,
    idempotencyRecordKey(config.network, scope!, idempotencyKey),
    requestFingerprint(request, fundRelayerId),
    {
      reservationWindowMs,
      sendWindowMs,
      ttlSec: effectiveIdempotencyTtlSec(
        config.idempotencyKeyTtlSeconds,
        Math.ceil((reservationWindowMs + sendWindowMs) / 1000)
      ),
    }
  );

  if (reserved.kind === 'existing') {
    console.log(`[channels] Idempotency-Key matched transaction ${reserved.transactionId}`);
    let existing: StellarTransactionResponse;
    try {
      existing = (await (fundRelayer as Relayer).getTransaction({
        transactionId: reserved.transactionId,
      })) as StellarTransactionResponse;
    } catch (error) {
      // Pruned by the Relayer after it became final: the outcome cannot be read
      if (isTransactionNotFound(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        throw outcomeUnknownError('gone', reason, { transactionId: reserved.transactionId, ...reserved.transaction });
      }
      throw error;
    }
    // The first request may have ended before charging (e.g. its wait failed)
    await chargeIdempotentFeeOnce(tracker, reserved.reservation, reserved.maxFee, existing);
    return idempotentResult(existing, config.network);
  }

  if (reserved.kind === 'unresolved') {
    // The earlier send's reply was lost. Resend the identical payload under the
    // same fund relayer key: the fund relayer returns the transaction it
    // created, or creates it if it holds none. Nothing is rebuilt.
    console.log(`[channels] Idempotency-Key has an unconfirmed send, resending the stored transaction`);
    let submission;
    try {
      submission = await sendFeeBump(
        fundRelayer as Relayer,
        reserved.payload,
        fundRelayerIdempotencyKey(reserved.reservation)
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The fund relayer is still creating the transaction for the key
      if (reason.includes(RELAYER_IN_PROGRESS_MESSAGE)) throw inProgressError();
      // The fund relayer holds the key but not its transaction
      const stored = describeStoredTransaction(reserved.payload, networkPassphrase);
      if (reason.includes(RELAYER_TRANSACTION_GONE_MESSAGE)) {
        throw outcomeUnknownError('gone', reason, { ...stored });
      }
      // An answered error does not show whether the original send created a
      // transaction, so the key and payload are kept for the next repeat.
      // Once the stored transaction has expired its outcome is final, so the
      // caller is told how to check it instead of retrying forever.
      if (isSendRejected(error)) {
        await markSendRejected(kv, reserved.reservation);
        if (hasStoredTransactionExpired(stored)) throw outcomeUnknownError('expired', reason, { ...stored });
        throw sendFailedError(reason, stored);
      }
      throw error;
    }
    await recordIdempotentTransaction(
      kv,
      reserved.reservation,
      reserved.payload.max_fee,
      submission.id,
      describeStoredTransaction(reserved.payload, networkPassphrase)
    );
    // The fund relayer may return the transaction the original send created,
    // in any state: report it as the existing-transaction path does, and charge
    // it once it is final (a later repeat charges one still pending)
    const final = { ...submission, status: submission.status ?? 'pending' };
    await chargeIdempotentFeeOnce(tracker, reserved.reservation, reserved.payload.max_fee, final);
    return idempotentResult(final, config.network);
  }

  const { reservation } = reserved;
  let sentPayload: FeeBumpPayload | undefined;
  let sendRejected = false;
  try {
    const result = await submit({
      ...ctx,
      beforeSubmit: async (payload) => {
        await storeIdempotentPayload(kv, reservation, payload);
        sentPayload = payload;
      },
      onSubmitted: async (transactionId) => {
        await recordIdempotentTransaction(
          kv,
          reservation,
          sentPayload!.max_fee,
          transactionId,
          describeStoredTransaction(sentPayload!, networkPassphrase)
        );
      },
      // The reply arrived, so a repeat need not wait out the send window. The
      // key is kept: the error does not show that no transaction was stored,
      // and only the identical stored payload is sent again
      onSendRejected: async () => {
        sendRejected = true;
        await markSendRejected(kv, reservation);
      },
      fundRelayerIdempotencyKey: fundRelayerIdempotencyKey(reservation),
      feeMarkerKey: idempotencyFeeKey(reservation),
      feeMarkerTtlSec: feeMarkerTtlSec(reservation),
    });
    // Read-only calls send nothing
    if (!sentPayload) await releaseIdempotencyKey(kv, reservation);
    return result;
  } catch (error) {
    // Once the payload is stored a transaction may exist, so the key is kept
    if (!sentPayload) await releaseIdempotencyKey(kv, reservation);
    // Tell the caller to retry this key rather than start another
    if (sendRejected) {
      const reason = error instanceof Error ? error.message : String(error);
      throw sendFailedError(reason, describeStoredTransaction(sentPayload!, networkPassphrase));
    }
    throw error;
  }
}

/**
 * Main plugin handler exported for OpenZeppelin Relayer
 */
export async function handler(context: PluginContext): Promise<any> {
  return channelAccounts(context);
}
