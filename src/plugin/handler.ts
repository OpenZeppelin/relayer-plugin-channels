/**
 * handler.ts
 *
 * Main handler for the channel accounts plugin.
 * Orchestrates the transaction processing pipeline using channel accounts with fee bumping.
 */

import { PluginContext, pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginAPI, PluginKVStore, Relayer } from '@openzeppelin/relayer-sdk';
import { PoolLock, ChannelPool, AcquireOptions } from './pool';
import { loadConfig, getNetworkPassphrase, ChannelAccountsConfig } from './config';
import { ChannelAccountsResponse } from './types';
import { validateAndParseRequest } from './validation';
import { isManagementRequest, handleManagement } from './management';
import { signWithChannelAndFund, submitWithFeeBumpAndWait, SubmitContext } from './submit';
import { HTTP_STATUS, POOL, RELAYER_INFO_CACHE_TTL_SECONDS } from './constants';
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
  const rawOp = envelope.v1().tx().operations()[0].body();

  if (rawOp.switch() !== xdr.OperationType.invokeHostFunction()) {
    return null;
  }

  const invokeHostFn = rawOp.invokeHostFunctionOp();
  return {
    func: invokeHostFn.hostFunction(),
    auth: invokeHostFn.auth(),
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
  const maxFee = calculateMaxFee(validated, ctx.acquireOptions.limitedContracts, ctx.fees);
  const contractId = getContractIdFromTransaction(validated);
  await ctx.tracker?.checkBudget(maxFee);
  const submitContext: SubmitContext = {
    contractId,
    isLimited: contractId ? ctx.acquireOptions.limitedContracts.has(contractId) : false,
  };
  return submitWithFeeBumpAndWait(
    ctx.fundRelayer,
    validated.toXDR(),
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
    const submitContext: SubmitContext = {
      contractId,
      isLimited: contractId ? ctx.acquireOptions.limitedContracts.has(contractId) : false,
    };
    try {
      const result = await submitWithFeeBumpAndWait(
        ctx.fundRelayer,
        signedTx.toXDR(),
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

      if (error.code === 'WAIT_TIMEOUT' && poolLock) {
        const extendSec = computeExtendTtlSec(txBuildTime, ctx.config.maxTimeBoundOffsetSeconds);
        console.log(`[channels] Extending lock for WAIT_TIMEOUT (${extendSec}s)`);
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

  const fundInfo = await getCachedRelayerInfo(config.network, fundRelayerId, fundRelayer as Relayer);
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

  // 3. Build acquire options for contract capacity limits
  const acquireOptions: AcquireOptions = {
    limitedContracts: config.limitedContracts,
    capacityRatio: config.contractCapacityRatio,
  };

  // 4. Resolve per-fund-relayer overrides from plugin config
  const fundOverrides = parseFundRelayerOverrides(pluginConfig, fundRelayerId);
  const fees = await resolveInclusionFees(fundOverrides, config, fundRelayer as Relayer, kv);
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
  if (request.type === 'xdr') {
    console.log(`[channels] Flow: XDR submit-only`);
    return await handleXdrSubmit(request.xdr, ctx, request.skipWait);
  }

  // Extract contractId for func+auth flow
  const contractId = getContractIdFromFunc(request.func);
  const funcAcquireOptions: AcquireOptions = { ...acquireOptions, contractId };

  console.log(`[channels] Flow: func+auth with channel account`);
  return await handleFuncAuthSubmit(
    request.func,
    request.auth,
    { ...ctx, acquireOptions: funcAcquireOptions },
    request.skipWait
  );
}

/**
 * Main plugin handler exported for OpenZeppelin Relayer
 */
export async function handler(context: PluginContext): Promise<any> {
  return channelAccounts(context);
}
