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

interface DecodedTransactionResult {
  feeCharged: number;
  resultCode: string;
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
      const labUrl = final.hash ? buildStellarLabTransactionUrl(network, final.hash) : null;
      const contractType = context?.isLimited ? 'limited' : 'default';
      const base = `[channels] Transaction failed: contractId=${context?.contractId ?? 'unknown'}, contractType=${contractType}, maxFee=${maxFee}`;
      if (decoded?.resultCode === 'txInsufficientFee') {
        console.error(
          `${base}, reason=txInsufficientFee, requiredFee=${decoded.feeCharged}, shortfall=${decoded.feeCharged - maxFee}`
        );
      } else if (decoded) {
        console.error(`${base}, reason=${decoded.resultCode}`);
      } else {
        console.error(`${base}, reason=${rawReason}`);
      }
      const reason = sanitizeReason(rawReason);
      const reasonWithLab = labUrl ? `${reason}. Debug in Stellar Lab (click "Load Transaction"): ${labUrl}` : reason;
      throw pluginError(reasonWithLab, {
        code: 'ONCHAIN_FAILED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: {
          status: String(final.status),
          reason,
          id: final.id,
          hash: final.hash ?? null,
          resultCode: decoded?.resultCode ?? null,
          labUrl: labUrl ? `Debug this failure in Stellar Lab (click "Load Transaction"): ${labUrl}` : null,
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

/** Try to decode a transaction result XDR from the reason string */
export function decodeTransactionResult(reason: string): DecodedTransactionResult | null {
  try {
    const match = reason.match(/([A-Za-z0-9+/=]{20,})$/);
    if (!match) return null;
    const result = xdr.TransactionResult.fromXDR(match[1], 'base64');
    const outerResultCode = String(result.result().switch().name);
    let resultCode = outerResultCode;

    // Unwrap fee bump inner failure to get the actual result code
    if (outerResultCode === 'txFeeBumpInnerFailed') {
      try {
        const innerResult = result.result().innerResultPair().result();
        const innerResultCode = String(innerResult.result().switch().name);
        resultCode = `${outerResultCode}:${innerResultCode}`;
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

export function buildStellarLabTransactionUrl(network: 'testnet' | 'mainnet', txHash: string): string {
  const isMainnet = network === 'mainnet';
  const networkId = isMainnet ? 'mainnet' : 'testnet';
  const label = isMainnet ? 'Mainnet' : 'Testnet';
  const horizonUrl = isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
  const rpcUrl = isMainnet ? 'https://mainnet.sorobanrpc.com' : 'https://soroban-testnet.stellar.org';
  const passphrase = isMainnet
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

  // Stellar Lab expects protocol values encoded as https://// in query params.
  // txHash is intentionally left unencoded because it is a hex string.
  const horizonParam = horizonUrl.replace('https://', 'https:////');
  const rpcParam = rpcUrl.replace('https://', 'https:////');
  const passphraseParam = passphrase.replace(/ /g, '%20').replace(/;/g, '%3B');

  return `https://lab.stellar.org/transaction/dashboard?$=network$id=${networkId}&label=${label}&horizonUrl=${horizonParam}&rpcUrl=${rpcParam}&passphrase=${passphraseParam}&txDashboard$transactionHash=${txHash};;`;
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
