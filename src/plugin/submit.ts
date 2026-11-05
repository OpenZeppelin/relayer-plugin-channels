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
import { HTTP_STATUS, IDEMPOTENCY, TIMEOUT, POLLING } from './constants';
import type { ChannelAccountsConfig } from './config';
import { ChannelAccountsResponse } from './types';
import { FeeTracker } from './fee-tracking';
import type { FeeBumpPayload } from './idempotency';

/**
 * `Relayer.sendTransaction` with its options argument. Relayer 1.9.0+ reads
 * `idempotencyKey`; older Relayers ignore it.
 * TODO: use the relayer-sdk's own `SendTransactionOptions` once a release
 * exports it.
 */
type IdempotentRelayer = {
  sendTransaction: (
    payload: FeeBumpPayload,
    options?: { idempotencyKey?: string }
  ) => ReturnType<Relayer['sendTransaction']>;
};

/** Relayer error when another request holds the fund relayer key without a transaction yet. */
export const RELAYER_IN_PROGRESS_MESSAGE = 'A request with this Idempotency-Key is already in progress';
/** Relayer error when it holds the fund relayer key but no longer has its transaction. */
export const RELAYER_TRANSACTION_GONE_MESSAGE = 'No transaction found for this Idempotency-Key';
/** Relayer error when it holds the fund relayer key for a different payload; it created nothing for the send. */
export const RELAYER_PAYLOAD_MISMATCH_MESSAGE = 'Idempotency-Key reused with a different request payload';

/** Relayer error when it no longer has a transaction (pruned after it became final). */
const RELAYER_TRANSACTION_NOT_FOUND = /Transaction with ID \S+ not found/;

/**
 * Tells whether a send failed with an error the fund relayer returned, as
 * opposed to a lost reply (socket timeout, closed socket, unexpected failure),
 * the Relayer's in-progress conflict, or a key whose transaction it no longer
 * has. The plugin runtime reports relayer failures as `Relayer error: ...`
 * with no status code.
 *
 * This never proves that no transaction exists: the Relayer checks the relayer
 * (paused, disabled) and its storage before it looks up an idempotency key,
 * and can fail after storing a transaction. It only tells that the reply
 * arrived.
 */
export function isSendRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith('Relayer error:') &&
    !message.includes(RELAYER_IN_PROGRESS_MESSAGE) &&
    !message.includes(RELAYER_TRANSACTION_GONE_MESSAGE)
  );
}

/** Tells whether a getTransaction call failed because the Relayer no longer has the transaction. */
export function isTransactionNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RELAYER_TRANSACTION_NOT_FOUND.test(message);
}

/**
 * Sends a fee bump payload to the fund relayer, with a fund relayer
 * idempotency key when one is given. Relayer 1.9.0+ creates at most one
 * transaction per key and returns it to a repeated send with the same payload.
 */
export function sendFeeBump(
  fundRelayer: Relayer,
  payload: FeeBumpPayload,
  idempotencyKey?: string
): ReturnType<Relayer['sendTransaction']> {
  const relayer = fundRelayer as unknown as IdempotentRelayer;
  return idempotencyKey ? relayer.sendTransaction(payload, { idempotencyKey }) : relayer.sendTransaction(payload);
}

/** Reason the Relayer gives a stored transaction it failed because it could not queue its jobs. */
const RELAYER_QUEUE_UNAVAILABLE_REASON = 'Queue unavailable';

/**
 * Tells whether the Relayer failed a transaction before ever submitting it:
 * it could not queue the transaction's jobs. A failed transaction without a
 * hash is not enough, since the Relayer clears the hash when it resets a
 * transaction after a bad sequence, possibly after an earlier submission.
 */
export function isNotSubmitted(final: { status: string; hash?: string | null; status_reason?: string | null }) {
  return final.status === 'failed' && !final.hash && final.status_reason === RELAYER_QUEUE_UNAVAILABLE_REASON;
}

/**
 * The error for a transaction the Relayer failed before submitting it (see
 * isNotSubmitted). Nothing reached the network, so it is not an on-chain
 * failure.
 */
export function notSubmittedError(final: { id: string; status_reason?: string | null }) {
  return pluginError('The fund relayer failed the transaction before submitting it to the network', {
    code: 'TRANSACTION_NOT_SUBMITTED',
    status: HTTP_STATUS.BAD_GATEWAY,
    details: { id: final.id, reason: final.status_reason ?? null },
  });
}

export interface SubmitContext {
  contractId?: string;
  isLimited?: boolean;
  /** Called with the exact payload before it is sent; a rejection stops the send */
  beforeSubmit?: (payload: FeeBumpPayload) => Promise<void>;
  /** Called once the fund relayer has created the transaction, before waiting */
  onSubmitted?: (transactionId: string) => Promise<void>;
  /** Fund relayer idempotency key for the send */
  fundRelayerIdempotencyKey?: string;
  /** Called when the fund relayer answered the send with an error (see isSendRejected) */
  onSendRejected?: () => Promise<void>;
  /** When set, the fee is recorded once per transaction, under the marker key for its id */
  feeMarkerKey?: (transactionId: string) => string;
  /** How long the fee marker is kept, read when the fee is recorded */
  feeMarkerTtlSec?: () => number;
}

/** Records the fee against the API key's budget, once per marker key when one is set. */
async function recordFee(
  tracker: FeeTracker | undefined,
  maxFee: number,
  transactionId: string,
  context?: SubmitContext
): Promise<void> {
  if (!tracker) return;
  if (context?.feeMarkerKey) {
    await tracker.recordUsageOnce(
      maxFee,
      context.feeMarkerKey(transactionId),
      context.feeMarkerTtlSec?.() ?? IDEMPOTENCY.TTL_SECONDS
    );
    return;
  }
  await tracker.recordUsage(maxFee);
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
  const payload: FeeBumpPayload = {
    network,
    transaction_xdr: signedXdr,
    fee_bump: true,
    max_fee: maxFee,
  };
  console.debug(`[channels] Relayer payload: ${JSON.stringify(payload)}`);
  await context?.beforeSubmit?.(payload);
  let submission: Awaited<ReturnType<Relayer['sendTransaction']>>;
  try {
    submission = await sendFeeBump(fundRelayer, payload, context?.fundRelayerIdempotencyKey);
  } catch (error) {
    if (isSendRejected(error)) await context?.onSendRejected?.();
    throw error;
  }
  await context?.onSubmitted?.(submission.id);

  // skipWait: return immediately after sendTransaction without waiting for confirmation
  if (skipWait) {
    console.debug(`[channels] skipWait enabled, returning pending result immediately`);
    await recordFee(tracker, maxFee, submission.id, context);
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

  // Wait for confirmation
  try {
    const final = (await api.transactionWait(submission, {
      interval: POLLING.INTERVAL_MS,
      timeout,
    })) as StellarTransactionResponse;

    // Check if transaction actually succeeded
    if (final.status === 'failed') {
      // Never submitted: nothing failed on chain
      if (isNotSubmitted(final)) throw notSubmittedError(final);
      // Record fee on on-chain failure (transaction was still submitted and consumed fees)
      await recordFee(tracker, maxFee, submission.id, context);
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
      throw onchainFailedError(final, network);
    }

    // Record fee on success
    await recordFee(tracker, maxFee, submission.id, context);

    return {
      transactionId: final.id,
      status: final.status,
      hash: final.hash ?? null,
    };
  } catch (error: any) {
    // A known failure outcome is rethrown as is
    if (error.code === 'ONCHAIN_FAILED' || error.code === 'TRANSACTION_NOT_SUBMITTED') {
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
 * The error for a transaction that failed on chain, with the decoded result
 * code and a Stellar Lab link.
 */
export function onchainFailedError(
  final: { id: string; status: string; hash?: string | null; status_reason?: string | null },
  network: 'testnet' | 'mainnet'
) {
  const rawReason = final.status_reason || 'Transaction failed';
  const decoded = decodeTransactionResult(rawReason);
  const labUrl = final.hash ? buildStellarLabTransactionUrl(network, final.hash) : null;
  const reason = sanitizeReason(rawReason);
  const reasonWithLab = labUrl ? `${reason}. Debug in Stellar Lab (click "Load Transaction"): ${labUrl}` : reason;
  return pluginError(reasonWithLab, {
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

/** Strip provider wrapper text, extract last segment (e.g., "TxInsufficientBalance") */
export function sanitizeReason(reason: string): string {
  const segments = reason.split(/:\s*/);
  const last = segments[segments.length - 1]?.trim();
  if (last && last.length > 2 && !last.toLowerCase().includes('provider')) {
    return last;
  }
  return reason.length > 100 ? reason.slice(0, 100) + '...' : reason;
}
