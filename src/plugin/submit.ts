/**
 * submit.ts
 *
 * Signing and submission logic for channel account transactions.
 */

import { Transaction, xdr } from '@stellar/stellar-sdk';
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

export interface SubmitContext {
  contractId?: string;
  isLimited?: boolean;
}

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
  tracker?: FeeTracker,
  context?: SubmitContext
): Promise<ChannelAccountsResponse> {
  // Submit with fee bump
  console.debug(`[channels] Sending fee bump tx: network=${network}, maxFee=${maxFee}, xdr_len=${signedXdr.length}`);
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
      const rawReason = final.status_reason || 'Transaction failed';
      const decoded = decodeTransactionResult(rawReason);
      const contractType = context?.isLimited ? 'limited' : 'default';
      const base = `[channels] Transaction failed: contractId=${context?.contractId ?? 'unknown'}, contractType=${contractType}, maxFee=${maxFee}`;
      if (decoded && isTxInsufficientFeeError(decoded.resultCode)) {
        const feeInfo =
          decoded.feeCharged != null
            ? `, requiredFee=${decoded.feeCharged}, shortfall=${decoded.feeCharged - maxFee}`
            : '';
        console.error(`${base}, reason=txInsufficientFee${feeInfo}`);
      } else if (decoded) {
        console.error(`${base}, reason=${decoded.resultCode}`);
      } else {
        console.error(`${base}, reason=${rawReason}`);
      }
      const reason = sanitizeReason(rawReason);
      throw pluginError(reason, {
        code: 'ONCHAIN_FAILED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: {
          status: String(final.status),
          reason,
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

/** Try to extract the transaction result code from the reason string.
 *  Supports two formats:
 *  1. Relayer status_reason: "Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxFailed."
 *  2. Submission errors with trailing base64 XDR (includes feeCharged)
 */
export function decodeTransactionResult(reason: string): { feeCharged?: number; resultCode: string } | null {
  // Format 1: relayer status_reason with human-readable result code
  const reasonMatch = reason.match(/Specific XDR reason:\s*(\w+)/);
  if (reasonMatch) {
    return { resultCode: reasonMatch[1] };
  }

  // Format 2: trailing base64 XDR
  try {
    const match = reason.match(/([A-Za-z0-9+/=]{20,})$/);
    if (!match) return null;
    const result = xdr.TransactionResult.fromXDR(match[1], 'base64');
    let resultCode = result.result().switch().name;

    // Unwrap fee bump inner failure to get the actual result code
    if (resultCode === 'txFeeBumpInnerFailed') {
      try {
        const innerResult = result.result().innerResultPair().result();
        resultCode = innerResult.result().switch().name;
      } catch {
        // keep outer result code if unwrap fails
      }
    }

    return {
      feeCharged: Number(result.feeCharged().toBigInt()),
      resultCode,
    };
  } catch {
    return null;
  }
}

/** Check if the result code indicates an insufficient fee error (case-insensitive). */
function isTxInsufficientFeeError(resultCode: string | undefined): boolean {
  return resultCode?.toLowerCase() === 'txinsufficientfee';
}

/** Strip provider wrapper text, extract last segment (e.g., "TxInsufficientBalance") */
export function sanitizeReason(reason: string): string {
  const segments = reason.split(/:\s*/);
  const last = segments[segments.length - 1]?.trim();
  if (last && last.length > 2 && !last.toLowerCase().includes('provider')) {
    return last;
  }
  return reason.length > 100 ? reason.slice(0, 100) + '...' : reason;
}
