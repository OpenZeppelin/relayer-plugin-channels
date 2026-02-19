/**
 * handler.ts
 *
 * Main handler for the channel accounts plugin.
 * Orchestrates the transaction processing pipeline using channel accounts with fee bumping.
 */

import { PluginContext, pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginAPI, PluginKVStore, Relayer } from '@openzeppelin/relayer-sdk';
import { PoolLock, ChannelPool, AcquireOptions } from './pool';
import { loadConfig, getNetworkPassphrase, type ChannelAccountsConfig } from './config';
import { ChannelAccountsResponse } from './types';
import { validateAndParseRequest } from './validation';
import { isManagementRequest, handleManagement } from './management';
import { signWithChannelAndFund, submitWithFeeBumpAndWait, SubmitContext } from './submit';
import { HTTP_STATUS } from './constants';
import { Transaction, xdr } from '@stellar/stellar-sdk';
import { simulateTransaction, buildWithChannel } from './simulation';
import { calculateMaxFee, getContractIdFromFunc, InclusionFees, getContractIdFromTransaction } from './fee';
import { validateExistingTransactionForSubmitOnly } from './tx';
import { FeeTracker } from './fee-tracking';
import { getSequence, commitSequence, clearSequence } from './sequence';

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
}

function getApiKey(headers: Record<string, string[]>, headerName: string): string | undefined {
  const values = headers[headerName];
  return values?.[0]?.trim() || undefined;
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

async function handleXdrSubmit(xdrStr: string, ctx: PipelineContext): Promise<ChannelAccountsResponse> {
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
    return handleFuncAuthSubmit(extracted.func, extracted.auth, { ...ctx, acquireOptions: updatedOptions });
  }

  const validated = validateExistingTransactionForSubmitOnly(tx);
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
    ctx.tracker,
    submitContext
  );
}

async function handleFuncAuthSubmit(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  ctx: PipelineContext
): Promise<ChannelAccountsResponse> {
  // Simulate once — used for both read-only detection and transaction assembly
  const simulation = await simulateTransaction(func, auth, ctx.fundAddress, ctx.fundRelayer, ctx.networkPassphrase);

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
  try {
    poolLock = await ctx.pool.acquire(ctx.acquireOptions);
    const channelRelayer = ctx.api.useRelayer(poolLock.relayerId);
    const channelInfo = await channelRelayer.getRelayer();
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
    const built = buildWithChannel(
      func,
      auth,
      { address: channelInfo.address, sequence },
      ctx.networkPassphrase,
      simulation.rawSimResult,
      ctx.config.minSignatureExpirationLedgerBuffer
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
        ctx.tracker,
        submitContext
      );
      if (result.status === 'confirmed') {
        await commitSequence(ctx.kv, ctx.network, channelInfo.address, sequence);
      } else {
        await clearSequence(ctx.kv, ctx.network, channelInfo.address);
      }
      return result;
    } catch (error: any) {
      await clearSequence(ctx.kv, ctx.network, channelInfo.address);
      throw error;
    }
  } finally {
    if (poolLock) {
      await ctx.pool.release(poolLock);
    }
  }
}

async function channelAccounts(context: PluginContext): Promise<ChannelAccountsResponse> {
  const { api, kv, params, headers } = context;

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

  // 1. Validate and parse request (xdr OR func+auth)
  const request = validateAndParseRequest(params);
  console.debug(
    `[channels] Request type: ${request.type}, auth entries: ${request.type === 'func-auth' ? request.auth.length : 'N/A'}`
  );

  // 2. Get fund relayer
  const fundRelayer = api.useRelayer(config.fundRelayerId);
  const fundInfo = await fundRelayer.getRelayer();
  if (!fundInfo || !fundInfo.address) {
    throw pluginError('Fund relayer not found', {
      code: 'RELAYER_UNAVAILABLE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { relayerId: config.fundRelayerId },
    });
  }
  if (fundInfo.network_type !== 'stellar') {
    throw pluginError('Fund relayer network type must be stellar', {
      code: 'UNSUPPORTED_NETWORK',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { network_type: fundInfo.network_type, relayerId: config.fundRelayerId },
    });
  }

  // 3. Build acquire options for contract capacity limits
  const acquireOptions: AcquireOptions = {
    limitedContracts: config.limitedContracts,
    capacityRatio: config.contractCapacityRatio,
  };

  const fees: InclusionFees = {
    inclusionFeeDefault: config.inclusionFeeDefault,
    inclusionFeeLimited: config.inclusionFeeLimited,
  };

  // 4. Build pipeline context
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
    config,
  };

  // 5. Branch by request type
  if (request.type === 'xdr') {
    console.log(`[channels] Flow: XDR submit-only`);
    return await handleXdrSubmit(request.xdr, ctx);
  }

  // Extract contractId for func+auth flow
  const contractId = getContractIdFromFunc(request.func);
  const funcAcquireOptions: AcquireOptions = { ...acquireOptions, contractId };

  console.log(`[channels] Flow: func+auth with channel account`);
  return await handleFuncAuthSubmit(request.func, request.auth, { ...ctx, acquireOptions: funcAcquireOptions });
}

/**
 * Main plugin handler exported for OpenZeppelin Relayer
 */
export async function handler(context: PluginContext): Promise<any> {
  return channelAccounts(context);
}
