/**
 * simulation.ts
 *
 * Build and simulate a Soroban transaction using a channel account as the source
 * and the fund account as the operation source. Returns an unsigned inner
 * transaction with sorobanData and correct fee set to the resource fee.
 */

import { Account, Operation, SorobanRpc, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
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
  rpc: SorobanRpc.Server,
  networkPassphrase: string,
): Promise<Transaction> {
  const now = Math.floor(Date.now() / 1000);
  console.log(`[channels] Building tx: channel=${channel.address}, seq=${channel.sequence}, auth_count=${auth?.length ?? 0}`);

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
      }),
    )
    .build();

  // Prepare transaction (attaches sorobanData/resources, preserves provided auth)
  try {
    const prepared = await rpc.prepareTransaction(transaction);
    const resourceFee = prepared.toEnvelope().v1().tx().ext().sorobanData()?.resourceFee();
    console.log(`[channels] Simulation complete: resourceFee=${resourceFee}`);
    return prepared as Transaction;
  } catch (e: any) {
    throw pluginError('Simulation failed', {
      code: 'SIMULATION_FAILED',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { error: e instanceof Error ? e.message : String(e) },
    });
  }
}
