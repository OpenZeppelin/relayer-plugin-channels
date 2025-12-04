/**
 * submit.ts
 *
 * Signing and submission logic for channel account transactions.
 */

import { Transaction } from '@stellar/stellar-sdk';
import {
  pluginError,
  Relayer,
  SignTransactionResponseStellar,
  StellarTransactionResponse,
  PluginAPI,
} from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import { ChannelAccountsResponse } from './types';
import { FeeTracker } from './fee-tracking';

/**
 * Sign transaction with both channel and fund relayers
 * - First sign with channel account
 * - Then sign with fund account
 * - Both signatures are added to the transaction
 */
export async function signWithChannelAndFund(
  transaction: Transaction,
  channelRelayer: Relayer,
  _fundRelayer: Relayer,
  channelAddress: string,
  _fundAddress: string,
  networkPassphrase: string
): Promise<Transaction> {
  const txXdr = transaction.toXDR();
  console.debug(`[channels] Signing transaction with channel (${channelAddress})`);

  // Get signatures from both accounts sequentially
  // Channel signs first
  const channelSignResult = await channelRelayer.signTransaction({
    unsigned_xdr: txXdr,
  });

  if (!isSignTransactionResponseStellar(channelSignResult)) {
    throw pluginError('Invalid channel signature response', {
      code: 'INVALID_SIGNATURE',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }

  // Add both signatures to the transaction
  const signedTx = new Transaction(txXdr, networkPassphrase);
  signedTx.addSignature(channelAddress, channelSignResult.signature);
  console.debug(`[channels] Transaction signed: ${signedTx.signatures.length} signature(s) added`);

  return signedTx;
}

/**
 * Submit transaction with fee bump and wait for confirmation
 */
export async function submitWithFeeBumpAndWait(
  fundRelayer: Relayer,
  signedXdr: string,
  network: 'testnet' | 'mainnet',
  maxFee: number,
  api: PluginAPI,
  tracker?: FeeTracker
): Promise<ChannelAccountsResponse> {
  // Submit with fee bump
  console.debug(
    `[channels] Sending fee bump tx: network=${network}, maxFee=${maxFee}, xdr_len=${signedXdr.length}`
  );
  const payload = {
    network,
    transaction_xdr: signedXdr,
    fee_bump: true,
    max_fee: maxFee,
  } as const;
  console.debug(`[channels] Relayer payload: ${JSON.stringify(payload)}`);
  const submission = await fundRelayer.sendTransaction(payload);

  // Wait for confirmation
  try {
    const final = (await api.transactionWait(submission, {
      interval: 500,
      timeout: 25000,
    })) as StellarTransactionResponse;

    // Check if transaction actually succeeded
    if (final.status === 'failed') {
      // Record fee on on-chain failure (transaction was still submitted and consumed fees)
      if (tracker) {
        await tracker.recordUsage(maxFee);
      }
      throw pluginError(final.status_reason || 'Transaction failed', {
        code: 'ONCHAIN_FAILED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: {
          status: String(final.status),
          reason: final.status_reason ?? null,
          id: final.id,
          hash: final.hash ?? null,
        },
      });
    }

    // Record fee on success
    if (tracker) {
      await tracker.recordUsage(maxFee);
    }

    return {
      transactionId: final.id,
      status: final.status,
      hash: final.hash ?? null,
    };
  } catch (error: any) {
    // If it's already a pluginError with ONCHAIN_FAILED, rethrow it
    if (error.code === 'ONCHAIN_FAILED') {
      throw error;
    }

    // Otherwise, it's a timeout - don't track fees (status unknown)
    throw pluginError('Transaction wait timeout. It may still submit.', {
      code: 'WAIT_TIMEOUT',
      status: HTTP_STATUS.GATEWAY_TIMEOUT,
      details: {
        id: submission.id,
        hash: submission.hash ?? null,
      },
    });
  }
}

/**
 * Type guard for SignTransactionResponseStellar
 */
function isSignTransactionResponseStellar(data: unknown): data is SignTransactionResponseStellar {
  return data !== null && typeof data === 'object' && 'signature' in data && 'signedXdr' in data;
}
