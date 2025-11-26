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
      id: 1,
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
    throw pluginError('Simulation RPC execution failed', {
      code: 'SIMULATION_RPC_FAILURE',
      status: HTTP_STATUS.BAD_REQUEST,
      details: {
        rpcCode: code,
        message,
        description: description || data,
      },
    });
  }

  try {
    // Format simulation result for SDK's assembleTransaction
    const simResult = {
      id: String(rpcResponse.id ?? '1'),
      ...(rpcResponse.result as object),
    } as rpc.Api.RawSimulateTransactionResponse;
    console.debug(`[channels] Simulation result:`, JSON.stringify(simResult, null, 2));

    // Use SDK's assembleTransaction to apply simulation results
    const prepared = rpc.assembleTransaction(transaction, simResult).build() as Transaction;

    const resourceFee = prepared.toEnvelope().v1().tx().ext().sorobanData()?.resourceFee();
    console.debug(`[channels] Simulation complete: resourceFee=${resourceFee}`);
    return prepared;
  } catch (err: any) {
    throw pluginError('Simulation result processing failed', {
      code: 'SIMULATION_FAILED',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
