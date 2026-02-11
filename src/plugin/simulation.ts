/**
 * simulation.ts
 *
 * Build and simulate a Soroban transaction using a channel account as the source
 * and the fund account as the operation source. Returns an unsigned inner
 * transaction with sorobanData and correct fee set to the resource fee.
 */

import { Account, Operation, rpc, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { JsonRpcResponseNetworkRpcResult, pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, SIMULATION } from './constants';

export interface ChannelAccount {
  address: string;
  sequence: string; // from relayer status
}

export async function simulateAndBuildWithChannel(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] | undefined,
  channel: ChannelAccount,
  _fundAddress: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<Transaction> {
  const now = Math.floor(Date.now() / 1000);
  console.debug(
    `[channels] Building tx: channel=${channel.address}, seq=${channel.sequence}, auth_count=${auth?.length ?? 0}`
  );

  // Build inner transaction (source = channel, op source = fund)
  const transaction = new TransactionBuilder(new Account(channel.address, channel.sequence), {
    fee: SIMULATION.DEFAULT_FEE,
    networkPassphrase,
    timebounds: { minTime: SIMULATION.MIN_TIME_BOUND, maxTime: now + SIMULATION.MAX_TIME_BOUND_OFFSET_SECONDS },
  })
    .addOperation(
      Operation.invokeHostFunction({
        func,
        auth,
        // No explicit source: default to transaction source (channel account)
      })
    )
    .build();

  let rpcResponse: JsonRpcResponseNetworkRpcResult;
  try {
    rpcResponse = await relayer.rpc({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e8).toString(),
      method: 'simulateTransaction',
      params: {
        transaction: transaction.toXDR(),
      },
    });
  } catch (err: any) {
    throw pluginError('Simulation network request failed', {
      code: 'SIMULATION_NETWORK_ERROR',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  if (rpcResponse.error) {
    const { code, message, description, data } = rpcResponse.error as any;
    console.error(`[channels] RPC error: code=${code}, message=${message}, detail=${description || data}`);
    throw pluginError('Simulation RPC failed', {
      code: 'SIMULATION_RPC_FAILURE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: 'RPC provider error' },
    });
  }

  const simResult = {
    id: String(rpcResponse.id ?? '1'),
    ...(rpcResponse.result as object),
  } as rpc.Api.RawSimulateTransactionResponse;

  if ('error' in simResult && simResult.error) {
    console.error(`[channels] Simulation error: ${simResult.error}`);
    throw pluginError('Simulation failed', {
      code: 'SIMULATION_FAILED',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { error: parseSimulationError(simResult.error) },
    });
  }

  try {
    // Use SDK's assembleTransaction to apply simulation results
    const prepared = rpc.assembleTransaction(transaction, simResult).build() as Transaction;

    const resourceFee = prepared.toEnvelope().v1().tx().ext().sorobanData()?.resourceFee();
    console.debug(`[channels] Simulation complete: resourceFee=${resourceFee}`);
    return prepared;
  } catch (err: any) {
    console.error(`[channels] Assembly error: ${err instanceof Error ? err.message : String(err)}`);
    throw pluginError('Simulation failed', {
      code: 'SIMULATION_FAILED',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export interface ReadOnlyCheckResult {
  isReadOnly: boolean;
  /** base64-encoded xdr.ScVal return value, present when isReadOnly is true */
  returnValue?: string;
  /** latest ledger at simulation time */
  latestLedger: number;
}

/**
 * Simulate a transaction to detect if it is a read-only call.
 * Uses a throwaway source account (sequence "0") since simulateTransaction
 * does not validate sequence numbers. This avoids acquiring a channel pool slot.
 *
 * A call is read-only when:
 * 1. Zero auth entries — no one needs to authorize anything
 * 2. Zero read-write footprint entries — no ledger state will be modified
 */
export async function simulateReadOnlyCheck(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] | undefined,
  sourceAddress: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<ReadOnlyCheckResult> {
  const now = Math.floor(Date.now() / 1000);

  const transaction = new TransactionBuilder(new Account(sourceAddress, '0'), {
    fee: SIMULATION.DEFAULT_FEE,
    networkPassphrase,
    timebounds: { minTime: SIMULATION.MIN_TIME_BOUND, maxTime: now + SIMULATION.MAX_TIME_BOUND_OFFSET_SECONDS },
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .build();

  let rpcResponse: JsonRpcResponseNetworkRpcResult;
  try {
    rpcResponse = await relayer.rpc({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e8).toString(),
      method: 'simulateTransaction',
      params: { transaction: transaction.toXDR() },
    });
  } catch (err: any) {
    throw pluginError('Simulation network request failed', {
      code: 'SIMULATION_NETWORK_ERROR',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: err instanceof Error ? err.message : String(err) },
    });
  }

  if (rpcResponse.error) {
    const { code, message, description, data } = rpcResponse.error as any;
    console.error(`[channels] RPC error: code=${code}, message=${message}, detail=${description || data}`);
    throw pluginError('Simulation RPC failed', {
      code: 'SIMULATION_RPC_FAILURE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: 'RPC provider error' },
    });
  }

  const simResult = {
    id: String(rpcResponse.id ?? '1'),
    ...(rpcResponse.result as object),
  } as rpc.Api.RawSimulateTransactionResponse;

  if ('error' in simResult && simResult.error) {
    console.error(`[channels] Simulation error: ${simResult.error}`);
    throw pluginError('Simulation failed', {
      code: 'SIMULATION_FAILED',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { error: parseSimulationError(simResult.error) },
    });
  }

  // Read-only detection
  const results = simResult.results;
  const hasAuth = (results?.[0]?.auth?.length ?? 0) > 0;

  let hasReadWrite = false;
  if (simResult.transactionData) {
    try {
      const sorobanData = xdr.SorobanTransactionData.fromXDR(simResult.transactionData, 'base64');
      hasReadWrite = sorobanData.resources().footprint().readWrite().length > 0;
    } catch {
      // If we can't parse transactionData, treat as not read-only (safe fallback)
      hasReadWrite = true;
    }
  }

  const isReadOnly = !hasAuth && !hasReadWrite;

  if (isReadOnly) {
    console.log(`[channels] Read-only call detected via simulation`);
  }

  return {
    isReadOnly,
    returnValue: isReadOnly ? results?.[0]?.xdr : undefined,
    latestLedger: simResult.latestLedger,
  };
}

/** Extract human-readable message + error type from simulation error diagnostic events */
export function parseSimulationError(error: string): string {
  const firstLine = error.split('\n')[0]?.trim() || 'Simulation failed';
  const errorType = firstLine.match(/Error\(([^)]+)\)/)?.[1];

  const arrayMatch = error.match(/data:\s*\["((?:[^"\\]|\\.)*)"/);
  if (arrayMatch?.[1] && arrayMatch[1].length > 3) {
    return errorType ? `${arrayMatch[1]} (${errorType})` : arrayMatch[1];
  }

  const stringMatch = error.match(/data:\s*"((?:[^"\\]|\\.)*)"/);
  if (stringMatch?.[1] && stringMatch[1].length > 3) {
    return errorType ? `${stringMatch[1]} (${errorType})` : stringMatch[1];
  }

  return firstLine;
}
