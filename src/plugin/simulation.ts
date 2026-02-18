/**
 * simulation.ts
 *
 * Simulate a Soroban transaction once (using a throwaway source account) and
 * reuse the result to both detect read-only calls and assemble the final
 * transaction with the real channel account.  This avoids a redundant network
 * round-trip to the RPC node.
 */

import { Account, Operation, rpc, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { JsonRpcResponseNetworkRpcResult, pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, SIMULATION } from './constants';

export interface ChannelAccount {
  address: string;
  sequence: string; // from KV cache or chain
}

export interface SimulationResult {
  /** Whether the call is read-only (no auth + no read-write footprint). */
  isReadOnly: boolean;
  /** base64-encoded xdr.ScVal return value, present when isReadOnly is true. */
  returnValue?: string;
  /** Latest ledger at simulation time. */
  latestLedger?: number;
  /** Raw simulation response — used by buildWithChannel to assemble the tx. */
  rawSimResult: rpc.Api.RawSimulateTransactionResponse;
}

interface SimulationFailure {
  code: string;
  message: string;
}

/**
 * Simulate a transaction to obtain the full simulation response and detect
 * whether the call is read-only.
 *
 * Uses a throwaway source account (sequence "0") because `simulateTransaction`
 * does not validate sequence numbers.  This lets us simulate before acquiring a
 * channel pool slot.
 *
 * A call is read-only when:
 * 1. Zero auth entries — no one needs to authorize anything
 * 2. Zero read-write footprint entries — no ledger state will be modified
 */
export async function simulateTransaction(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] | undefined,
  sourceAddress: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<SimulationResult> {
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
      // Enforce mode validates auth entry signatures during simulation.
      params: { transaction: transaction.toXDR(), authMode: SIMULATION.SIMULATION_AUTH_MODE },
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
    const parsedError = parseSimulationError(simResult.error);
    const failure = classifySimulationFailure(simResult.error, parsedError);
    console.error(`[channels] Simulation error: ${simResult.error}`);
    throw pluginError(failure.message, {
      code: failure.code,
      status: HTTP_STATUS.BAD_REQUEST,
      details: { error: parsedError, authMode: SIMULATION.SIMULATION_AUTH_MODE },
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
    rawSimResult: simResult,
  };
}

/**
 * Build and assemble a transaction using a channel account and an already-
 * obtained simulation result.  No additional network calls are made.
 */
export function buildWithChannel(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] | undefined,
  channel: ChannelAccount,
  networkPassphrase: string,
  simResult: rpc.Api.RawSimulateTransactionResponse
): Transaction {
  const now = Math.floor(Date.now() / 1000);
  console.debug(
    `[channels] Building tx: channel=${channel.address}, seq=${channel.sequence}, auth_count=${auth?.length ?? 0}`
  );

  // Build inner transaction (source = channel)
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

  try {
    // Use SDK's assembleTransaction to apply the cached simulation results
    const prepared = rpc.assembleTransaction(transaction, simResult).build() as Transaction;

    const resourceFee = prepared.toEnvelope().v1().tx().ext().sorobanData()?.resourceFee();
    console.debug(`[channels] Assembly complete: resourceFee=${resourceFee}`);
    return prepared;
  } catch (err: any) {
    console.error(`[channels] Assembly error: ${err instanceof Error ? err.message : String(err)}`);
    throw pluginError('Transaction assembly failed', {
      code: 'ASSEMBLY_FAILED',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
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

function classifySimulationFailure(rawError: string, parsedError: string): SimulationFailure {
  const isEnforcedAuthValidation =
    SIMULATION.SIMULATION_AUTH_MODE === 'enforce' &&
    (/\bError\(Auth,/i.test(rawError) ||
      /\brequire_auth\b/i.test(rawError) ||
      /\binvalid\s+signature\b/i.test(rawError) ||
      /\bsignature\s+has\s+expired\b/i.test(rawError) ||
      /\bsignature\s+expired\b/i.test(rawError) ||
      /\bsignature\s+verification\s+failed\b/i.test(rawError) ||
      /\bbad[_\s]?signature\b/i.test(rawError) ||
      /\btx_bad_auth\b/i.test(rawError) ||
      /\bbad[_\s]?auth\b/i.test(rawError));

  if (isEnforcedAuthValidation) {
    return {
      code: 'SIMULATION_SIGNED_AUTH_VALIDATION_FAILED',
      message: `Signed auth entry validation failed in enforce simulation: ${parsedError}`,
    };
  }

  return {
    code: 'SIMULATION_FAILED',
    message: 'Simulation failed',
  };
}
