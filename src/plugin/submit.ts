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
import { HTTP_STATUS, TIMEOUT, POLLING } from './constants';
import type { ChannelAccountsConfig } from './config';
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
  const txXdr = transaction.toXdr();
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
  startTime: number,
  tracker?: FeeTracker,
  context?: SubmitContext,
  skipWait?: boolean,
  config?: Pick<ChannelAccountsConfig, 'globalTimeoutMs' | 'pollingTimeoutMs'>
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

  // skipWait: return immediately after sendTransaction without waiting for confirmation
  if (skipWait) {
    console.debug(`[channels] skipWait enabled, returning pending result immediately`);
    // The final state is not known here, so the whole bid is debited
    await tracker?.recordUsage(maxFee);
    return {
      transactionId: submission.id,
      status: 'pending',
      hash: submission.hash ?? null,
    };
  }

  // Compute dynamic timeout from remaining global budget
  const globalTimeout = config?.globalTimeoutMs ?? TIMEOUT.DEFAULT_GLOBAL_TIMEOUT_MS;
  const pollingTimeout = config?.pollingTimeoutMs ?? POLLING.DEFAULT_TIMEOUT_MS;
  const elapsedMs = Date.now() - startTime;
  const remainingMs = globalTimeout - TIMEOUT.BUFFER_MS - elapsedMs;
  if (remainingMs <= 0) {
    // Already sent: the transaction may still land, so the whole bid is debited
    await tracker?.recordUsage(maxFee);
    throw pluginError('No time remaining for transaction wait', {
      code: 'WAIT_TIMEOUT',
      status: HTTP_STATUS.GATEWAY_TIMEOUT,
      details: {
        id: submission.id,
        hash: submission.hash ?? null,
        elapsedMs,
      },
    });
  }
  const timeout = Math.min(remainingMs, pollingTimeout);
  console.debug(`[channels] Transaction wait: elapsed=${elapsedMs}ms, timeout=${timeout}ms`);

  // Wait for a final state
  let final: StellarTransactionResponse;
  try {
    final = (await api.transactionWait(submission, {
      interval: POLLING.INTERVAL_MS,
      timeout,
    })) as StellarTransactionResponse;
  } catch {
    // Final state unknown: the transaction may still land, so the whole bid is debited
    await tracker?.recordUsage(maxFee);
    throw pluginError('Transaction wait timeout. It may still submit.', {
      code: 'WAIT_TIMEOUT',
      status: HTTP_STATUS.GATEWAY_TIMEOUT,
      details: {
        id: submission.id,
        hash: submission.hash ?? null,
      },
    });
  }

  if (final.status === 'expired') {
    console.error(`[channels] Transaction expired: id=${final.id}, hash=${final.hash ?? 'none'}`);
    // The Relayer expires a transaction by the clock, without a final answer from the chain. One the
    // network had accepted (it has a hash) may have landed just before, so its whole bid is debited.
    if (final.hash) {
      await tracker?.recordUsage(maxFee);
    }
    throw pluginError('Transaction expired: it was not seen in a ledger before its time bounds passed', {
      code: 'TRANSACTION_EXPIRED',
      status: HTTP_STATUS.BAD_REQUEST,
      details: {
        status: String(final.status),
        reason: final.status_reason ?? null,
        id: final.id,
        hash: final.hash ?? null,
      },
    });
  }

  if (final.status === 'failed') {
    const rawReason = final.status_reason || 'Transaction failed';
    const decoded = decodeTransactionResult(rawReason);
    const reason = sanitizeReason(rawReason);
    const contractType = context?.isLimited ? 'limited' : 'default';
    const base = `[channels] Transaction failed: contractId=${context?.contractId ?? 'unknown'}, contractType=${contractType}, maxFee=${maxFee}`;
    if (decoded && isTxInsufficientFeeError(decoded.resultCode)) {
      const feeInfo = decoded.feeCharged
        ? `, requiredFee=${decoded.feeCharged}, shortfall=${decoded.feeCharged - maxFee}`
        : '';
      console.error(`${base}, reason=txInsufficientFee${feeInfo}`);
    } else {
      console.error(`${base}, reason=${rawReason}`);
    }

    if (rejectedBeforeLedger(final)) {
      // Nothing happened on chain and no fee was charged
      throw pluginError(reason, {
        code: 'TRANSACTION_REJECTED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: {
          status: String(final.status),
          reason,
          id: final.id,
          hash: null,
          resultCode: decoded?.resultCode ?? null,
        },
      });
    }

    // A failed transaction still pays a fee. The Relayer does not report how much, so the whole bid is debited.
    await tracker?.recordUsage(maxFee);
    const labUrl = final.hash ? buildStellarLabTransactionUrl(network, final.hash) : null;
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

  await tracker?.recordUsage(chargedFee(final, maxFee));

  return {
    transactionId: final.id,
    status: final.status,
    hash: final.hash ?? null,
  };
}

/** Reason the Relayer gives a transaction that a ledger included and that failed there. */
const ONCHAIN_FAILURE_REASON = /^Transaction failed on-chain\b/;

/**
 * Reasons the Relayer gives a transaction that the network never accepted:
 * it could not prepare it, or the RPC answered the submission with an error.
 */
const NOT_ACCEPTED_REASON = /^(?:Preparation failed:|Submission failed:.*\bTransaction submission error:)/;

/**
 * Tells whether a failed transaction is known to have never reached a ledger:
 * the network never accepted it (no hash) and the Relayer's reason is a
 * definite refusal.
 *
 * Any other failure keeps ONCHAIN_FAILED and is debited, since it may have
 * cost a fee: one with a hash was accepted at some point, and a submission
 * the RPC never answered (a provider error) may still have gone through.
 */
function rejectedBeforeLedger(final: { hash?: string | null; status_reason?: string | null }): boolean {
  return !final.hash && NOT_ACCEPTED_REASON.test(final.status_reason ?? '');
}

/**
 * The fee to debit for a transaction that did not fail. For a confirmed
 * transaction the Relayer replaces `fee` with the fee the ledger charged; in
 * any other state, or when it reports no usable value, the bid is debited.
 */
function chargedFee(final: { status?: unknown; fee?: unknown }, maxFee: number): number {
  const fee = final.fee;
  const isCharged = final.status === 'confirmed' && typeof fee === 'number' && Number.isSafeInteger(fee) && fee > 0;
  return isCharged ? fee : maxFee;
}

/**
 * Type guard for SignTransactionResponseStellar
 */
function isSignTransactionResponseStellar(data: unknown): data is SignTransactionResponseStellar {
  return data !== null && typeof data === 'object' && 'signature' in data && 'signedXdr' in data;
}

/** Try to decode a transaction result XDR from the reason string */
export function decodeTransactionResult(reason: string): DecodedTransactionResult | null {
  const fromReasonText = extractResultCodeFromReasonText(reason);
  if (fromReasonText) {
    return {
      feeCharged: 0,
      resultCode: fromReasonText,
    };
  }

  try {
    const match = reason.match(/([A-Za-z0-9+/=]{20,})$/);
    if (!match) return null;
    const result = xdr.TransactionResult.fromXdr(match[1], 'base64');
    const outerResultCode = result.result.type;
    let resultCode: string = outerResultCode;

    // Unwrap fee bump inner failure to get the actual result code
    if (outerResultCode === 'txFeeBumpInnerFailed') {
      try {
        const outer = result.result;
        if (outer.type !== 'txFeeBumpInnerFailed') throw new Error('unreachable');
        const innerResultCode = outer.innerResultPair.result.result.type;
        resultCode = `${outerResultCode}:${innerResultCode}`;
      } catch {
        // keep outer result code if unwrap fails
      }
    }

    return {
      feeCharged: Number(result.feeCharged),
      resultCode,
    };
  } catch {
    return null;
  }
}

function extractResultCodeFromReasonText(reason: string): string | null {
  // Relayer 1.5.0+: "Transaction failed on-chain. reason=X inner=Y op=Z contract_error=E".
  // Anchored, since contract_error carries text the contract chose.
  const onchain = reason.match(/^Transaction failed on-chain\. reason=([A-Za-z0-9_]+)(?: inner=([A-Za-z0-9_]+))?/);
  if (onchain) {
    // The Relayer writes "unknown" when the RPC returned no result to read
    if (onchain[1] === 'unknown') return null;
    return onchain[2] ? `${onchain[1]}:${onchain[2]}` : onchain[1];
  }

  // Rejected at submission: "... Transaction submission error: TxBadAuth"
  const rejected = reason.match(/\bTransaction submission error:\s*(Tx[A-Za-z]+)$/);
  if (rejected) return rejected[1];

  // Relayer before 1.5.0
  const outerMatch = reason.match(/\bSpecific XDR reason:\s*([A-Za-z0-9_]+)\b/i);
  if (!outerMatch?.[1]) return null;

  const innerMatch = reason.match(/\bInner result:\s*([A-Za-z0-9_]+)\b/i);
  return innerMatch?.[1] ? `${outerMatch[1]}:${innerMatch[1]}` : outerMatch[1];
}

/** Check if the result code indicates an insufficient fee error (case-insensitive). */
function isTxInsufficientFeeError(resultCode: string | undefined): boolean {
  return resultCode?.toLowerCase() === 'txinsufficientfee';
}

export function buildStellarLabTransactionUrl(network: 'testnet' | 'mainnet', txHash: string): string {
  const isMainnet = network === 'mainnet';
  const networkId = isMainnet ? 'mainnet' : 'testnet';
  const label = isMainnet ? 'Mainnet' : 'Testnet';
  const horizonUrl = isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
  const rpcUrl = isMainnet ? 'https://mainnet.sorobanrpc.com' : 'https://soroban-testnet.stellar.org';
  const passphrase = isMainnet ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015';

  // Stellar Lab expects protocol values encoded as https://// in query params.
  // txHash is intentionally left unencoded because it is a hex string.
  const horizonParam = horizonUrl.replace('https://', 'https:////');
  const rpcParam = rpcUrl.replace('https://', 'https:////');
  const passphraseParam = passphrase.replace(/ /g, '%20').replace(/;/g, '%3B');

  return `https://lab.stellar.org/transaction/dashboard?$=network$id=${networkId}&label=${label}&horizonUrl=${horizonParam}&rpcUrl=${rpcParam}&passphrase=${passphraseParam}&txDashboard$transactionHash=${txHash};;`;
}

/**
 * Reduce a Relayer failure reason to a message for the client.
 *
 * An on-chain failure reason and the text of a validation error describe the
 * transaction, so they are kept whole (e.g. "max_fee (100203) is insufficient.
 * Required fee-bump fee: 20000000"). Any other reason is cut to its last
 * segment (e.g. "TxInsufficientBalance"), dropping the layers in front of it.
 */
export function sanitizeReason(reason: string): string {
  if (ONCHAIN_FAILURE_REASON.test(reason)) return reason;

  const validation = reason.match(
    /^(?:(?:Preparation|Submission) failed: )?(?:Transaction|Stellar) validation error: (.+)$/s
  );
  if (validation) return validation[1].trim();

  const segments = reason.split(/:\s*/);
  const last = segments[segments.length - 1]?.trim();
  if (last && last.length > 2 && !last.toLowerCase().includes('provider')) {
    return last;
  }
  return reason.length > 100 ? reason.slice(0, 100) + '...' : reason;
}
