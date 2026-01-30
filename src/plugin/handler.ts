/**
 * handler.ts
 *
 * Main handler for the channel accounts plugin.
 * Orchestrates the transaction processing pipeline using channel accounts with fee bumping.
 */

import { PluginContext, pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginAPI, Relayer } from '@openzeppelin/relayer-sdk';
import { PoolLock, ChannelPool, AcquireOptions } from './pool';
import { loadConfig, getNetworkPassphrase } from './config';
import { ChannelAccountsResponse } from './types';
import { validateAndParseRequest } from './validation';
import { isManagementRequest, handleManagement } from './management';
import { signWithChannelAndFund, submitWithFeeBumpAndWait } from './submit';
import { HTTP_STATUS } from './constants';
import { Transaction, xdr } from '@stellar/stellar-sdk';
import { simulateAndBuildWithChannel } from './simulation';
import { calculateMaxFee, getContractIdFromFunc } from './fee';
import { validateExistingTransactionForSubmitOnly } from './tx';
import { FeeTracker } from './fee-tracking';

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

async function handleXdrSubmit(
  xdrStr: string,
  fundRelayer: Relayer,
  fundAddress: string,
  network: 'testnet' | 'mainnet',
  networkPassphrase: string,
  api: PluginAPI,
  pool: ChannelPool,
  acquireOptions: AcquireOptions,
  tracker?: FeeTracker
): Promise<ChannelAccountsResponse> {
  const tx = new Transaction(xdrStr, networkPassphrase);

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
    const updatedOptions: AcquireOptions = { ...acquireOptions, contractId };
    return handleFuncAuthSubmit(
      extracted.func,
      extracted.auth,
      api,
      pool,
      fundRelayer,
      fundAddress,
      network,
      networkPassphrase,
      updatedOptions,
      tracker
    );
  }

  const validated = validateExistingTransactionForSubmitOnly(tx);
  const maxFee = calculateMaxFee(validated, acquireOptions.limitedContracts);
  await tracker?.checkBudget(maxFee);
  return submitWithFeeBumpAndWait(fundRelayer, validated.toXDR(), network, maxFee, api, tracker);
}

async function handleFuncAuthSubmit(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  api: PluginAPI,
  pool: ChannelPool,
  fundRelayer: Relayer,
  fundAddress: string,
  network: 'testnet' | 'mainnet',
  networkPassphrase: string,
  acquireOptions: AcquireOptions,
  tracker?: FeeTracker
): Promise<ChannelAccountsResponse> {
  let poolLock: PoolLock | undefined;
  try {
    poolLock = await pool.acquire(acquireOptions);
    const channelRelayer = api.useRelayer(poolLock.relayerId);
    const channelInfo = await channelRelayer.getRelayer();
    console.log(`[channels] Acquired channel: ${poolLock.relayerId}`);
    if (!channelInfo || !channelInfo.address) {
      throw pluginError('Channel relayer not found', {
        code: 'RELAYER_UNAVAILABLE',
        status: HTTP_STATUS.BAD_GATEWAY,
        details: { relayerId: poolLock.relayerId },
      });
    }
    const channelStatus = await channelRelayer.getRelayerStatus();
    if (channelStatus.network_type !== 'stellar') {
      throw pluginError('Channel relayer network type must be stellar', {
        code: 'UNSUPPORTED_NETWORK',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { network_type: channelStatus.network_type, relayerId: poolLock.relayerId },
      });
    }

    const built = await simulateAndBuildWithChannel(
      func,
      auth,
      { address: channelInfo.address, sequence: channelStatus.sequence_number },
      fundAddress,
      fundRelayer,
      networkPassphrase
    );

    const signedTx = await signWithChannelAndFund(
      built,
      channelRelayer,
      fundRelayer,
      channelInfo.address,
      fundAddress,
      networkPassphrase
    );

    const maxFee = calculateMaxFee(signedTx, acquireOptions.limitedContracts);
    await tracker?.checkBudget(maxFee);
    return await submitWithFeeBumpAndWait(fundRelayer, signedTx.toXDR(), network, maxFee, api, tracker);
  } finally {
    if (poolLock) {
      await pool.release(poolLock);
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

  // 4. Branch by request type
  if (request.type === 'xdr') {
    console.log(`[channels] Flow: XDR submit-only`);
    return await handleXdrSubmit(
      request.xdr,
      fundRelayer as Relayer,
      fundInfo.address,
      config.network,
      networkPassphrase,
      api,
      pool,
      acquireOptions,
      tracker
    );
  }

  // Extract contractId for func+auth flow
  const contractId = getContractIdFromFunc(request.func);
  const funcAcquireOptions: AcquireOptions = { ...acquireOptions, contractId };

  console.log(`[channels] Flow: func+auth with channel account`);
  return await handleFuncAuthSubmit(
    request.func,
    request.auth,
    api,
    pool,
    fundRelayer as Relayer,
    fundInfo.address,
    config.network,
    networkPassphrase,
    funcAcquireOptions,
    tracker
  );
}

/**
 * Main plugin handler exported for OpenZeppelin Relayer
 */
export async function handler(context: PluginContext): Promise<any> {
  return channelAccounts(context);
}
