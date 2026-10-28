/**
 * idempotency.ts
 *
 * Idempotency-Key support for transaction submissions.
 *
 * A caller may send an `Idempotency-Key` header with an `xdr` or `func`+`auth`
 * submission. The first request with a key reserves it. Before the fee bump
 * transaction is sent, its exact signed payload is stored under the key; once
 * the fund relayer returns the transaction id, the id replaces the payload. A
 * later request with the same key and request:
 * - gets the recorded transaction back, or
 * - when the id is missing (the reply was lost or the id write failed),
 *   resends the identical stored payload instead of building a new one.
 *
 * Every send under a key, from any reservation of it, carries the same fund
 * relayer idempotency key. Relayer 1.9.0+ reserves that key atomically,
 * creates at most one transaction per key, returns that transaction, in any
 * state, to a repeated send of the same payload, and rejects a different
 * payload; it keeps the key when a create fails after the transaction was
 * stored. So a resend recovers a transaction whose reply was lost, and
 * resending is always safe.
 *
 * The fund relayer key is also what stops a key from executing twice. The
 * record here is guarded by a lock with a TTL and the KV store has no
 * conditional writes, so a request stalled past the lock's TTL can still
 * overwrite or delete newer state (the lease check below narrows this, it does
 * not close it). Whatever happens to the record, a rebuilt transaction sent
 * under the key is rejected by the fund relayer while it holds the key. The
 * fund relayer keeps a key for its IDEMPOTENCY_KEY_TTL_SECONDS from the first
 * send, which comes after the reservation, so with that TTL at least this
 * plugin's, no transaction executes twice within the plugin's TTL of the
 * reservation. A key reused after the plugin's record expired, while the fund
 * relayer still holds it, gets IDEMPOTENCY_KEY_CONFLICT.
 * A send error never shows that no transaction exists (the Relayer can fail
 * before it looks the key up, or after storing), so once a payload is stored
 * the key is kept and only that payload is ever sent again. Older Relayers
 * ignore the fund relayer key, so the feature requires 1.9.0+.
 *
 * The key's scope is the caller's choice: a caller that wants only retries of
 * one call deduplicated sends a key unique to that call.
 */

import { createHash } from 'node:crypto';
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginKVStore } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, IDEMPOTENCY } from './constants';
import type { ChannelAccountsRequest } from './types';

/** The fee bump request sent to the fund relayer. */
export interface FeeBumpPayload {
  network: 'testnet' | 'mainnet';
  transaction_xdr: string;
  fee_bump: true;
  max_fee: number;
}

/**
 * Stored under the key. The payload and sentAt are written just before the
 * transaction is sent and dropped once the transaction id is recorded, so a
 * resolved record stays small; maxFee is kept for fee recovery. A record
 * without a payload or transaction id was never sent.
 */
interface IdempotencyRecord {
  fingerprint: string;
  reservedAt: number;
  /**
   * When the record expires (ms), fixed at reservation. Every write keeps it,
   * so repeats do not extend the record past the fee marker that stops the
   * transaction from being charged twice.
   */
  expiresAt: number;
  payload?: FeeBumpPayload;
  sentAt?: number;
  maxFee?: number;
  transactionId?: string;
  /** The inner transaction, kept with the id to report it if the Relayer prunes it */
  transaction?: StoredTransaction;
}

/**
 * What a caller needs to look up a stored transaction on chain. Only the inner
 * transaction is known here: the fund relayer builds the fee bump envelope,
 * and the network records it under the fee bump's own hash.
 */
export interface StoredTransaction {
  /** Hash of the inner transaction, not of the fee bump the network records */
  innerHash: string;
  source: string;
  sequence: string;
  /** timeBounds.maxTime in seconds; undefined when the transaction has none */
  maxTime?: number;
}

/** A key this request holds; the payload and transaction id are written against it. */
export interface IdempotencyReservation {
  recordKey: string;
  fingerprint: string;
  reservedAt: number;
  /** When the record expires (ms), fixed at reservation */
  expiresAt: number;
}

/** Seconds until a reservation's record expires (at least 1, for the KV TTL). */
export function recordTtlSec(reservation: Pick<IdempotencyReservation, 'expiresAt'>, now = Date.now()): number {
  return Math.max(1, Math.ceil((reservation.expiresAt - now) / 1000));
}

export interface ReserveOptions {
  /** How long an unsent reservation blocks other requests before it may be taken over */
  reservationWindowMs: number;
  /** How long after a send its reply may still arrive; repeats get 409 until then */
  sendWindowMs: number;
  ttlSec: number;
}

export type ReserveResult =
  | { kind: 'reserved'; reservation: IdempotencyReservation }
  | {
      kind: 'existing';
      reservation: IdempotencyReservation;
      transactionId: string;
      maxFee?: number;
      transaction?: StoredTransaction;
    }
  | { kind: 'unresolved'; reservation: IdempotencyReservation; payload: FeeBumpPayload };

/**
 * Characters a key may use. The Relayer forwards only header values made of
 * visible ASCII (and spaces), and silently drops any other.
 */
const VISIBLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Reads the `Idempotency-Key` header (header names are matched case-insensitively).
 * Returns undefined when absent. Rejects an empty key, one longer than
 * IDEMPOTENCY.MAX_KEY_LENGTH characters after trimming, or one with
 * characters outside visible ASCII.
 */
export function getIdempotencyKey(headers: Record<string, string[]> | undefined): string | undefined {
  if (!headers) return undefined;
  const name = Object.keys(headers).find((h) => h.toLowerCase() === IDEMPOTENCY.HEADER);
  if (name === undefined) return undefined;

  const key = headers[name]?.[0]?.trim() ?? '';
  if (key.length === 0 || key.length > IDEMPOTENCY.MAX_KEY_LENGTH || !VISIBLE_ASCII.test(key)) {
    throw pluginError('Invalid Idempotency-Key header', {
      code: 'INVALID_IDEMPOTENCY_KEY',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { maxLength: IDEMPOTENCY.MAX_KEY_LENGTH },
    });
  }
  return key;
}

/**
 * Fingerprints what a submission would execute, so a key reused for a
 * different request is rejected. skipWait only changes the response shape and
 * is left out.
 */
export function requestFingerprint(request: ChannelAccountsRequest, fundRelayerId: string): string {
  const content =
    request.type === 'xdr'
      ? { type: 'xdr', xdr: request.xdr }
      : request.type === 'func-auth'
        ? {
            type: 'func-auth',
            func: request.func.toXdr('base64'),
            auth: request.auth.map((entry) => entry.toXdr('base64')),
          }
        : { type: request.type };
  return createHash('sha256')
    .update(JSON.stringify({ ...content, fundRelayerId }))
    .digest('hex');
}

/**
 * KV key for an idempotency key, scoped to the caller (see idempotencyScope)
 * so callers cannot collide with or probe each other's keys.
 */
export function idempotencyRecordKey(network: string, scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\n${key}`).digest('hex');
  return `${network}:idempotency:${digest}`;
}

/**
 * Runs fn under the record's lock (null when the lock is busy). fn calls
 * checkLease right before each write: it throws once the lock may have
 * expired, so a request stalled while holding the lock does not write what it
 * read before the stall over newer state. Time is measured on a monotonic
 * clock from before the lock is requested, since the lock's TTL starts when
 * the KV store takes it and withLock can return late. A stall between the
 * check and the write landing is not caught (see the file comment).
 */
async function withRecordLease<T>(
  kv: PluginKVStore,
  recordKey: string,
  fn: (checkLease: () => void) => Promise<T>
): Promise<T | null> {
  const start = performance.now();
  const checkLease = () => {
    if (performance.now() - start > IDEMPOTENCY.LOCK_WRITE_BUDGET_MS) {
      console.warn('[channels] Idempotency-Key record lock may have expired; not writing');
      throw inProgressError();
    }
  };
  return kv.withLock(`${recordKey}:lock`, () => fn(checkLease), {
    ttlSec: IDEMPOTENCY.LOCK_TTL_SECONDS,
    onBusy: 'skip',
  });
}

/**
 * Reserves the key for this request, or returns what an earlier request with
 * the same key left: its transaction id, or the payload it sent without a
 * recorded reply (to be resent as is).
 *
 * - A payload sent within sendWindowMs may still get its reply, so the
 *   repeat gets 409. After that, one repeat per window resends it.
 * - A reservation without a payload was never sent. It blocks repeats for
 *   reservationWindowMs (the original request may yet send); after that the
 *   original request has ended and a new attempt may take the key over.
 *
 * @throws 422 when the key was used for a different request
 * @throws 409 while another request holds the key and its outcome is pending
 */
export async function reserveIdempotencyKey(
  kv: PluginKVStore,
  recordKey: string,
  fingerprint: string,
  options: ReserveOptions
): Promise<ReserveResult> {
  const { reservationWindowMs, sendWindowMs, ttlSec } = options;
  const result = await withRecordLease(kv, recordKey, async (checkLease): Promise<ReserveResult> => {
    const now = Date.now();
    const existing = await kv.get<IdempotencyRecord>(recordKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw pluginError('Idempotency-Key reused with a different request payload', {
          code: 'IDEMPOTENCY_KEY_REUSED',
          status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
        });
      }
      const reservation = {
        recordKey,
        fingerprint,
        reservedAt: existing.reservedAt,
        expiresAt: existing.expiresAt ?? existing.reservedAt + ttlSec * 1000,
      };
      if (existing.transactionId) {
        return {
          kind: 'existing',
          reservation,
          transactionId: existing.transactionId,
          maxFee: existing.maxFee ?? existing.payload?.max_fee,
          transaction: existing.transaction,
        };
      }
      if (existing.payload) {
        if (now - (existing.sentAt ?? 0) < sendWindowMs) throw inProgressError();
        // Re-arm the send window so concurrent repeats do not all resend
        checkLease();
        await kv.set(recordKey, { ...existing, sentAt: now } satisfies IdempotencyRecord, {
          ttlSec: recordTtlSec(reservation, now),
        });
        return { kind: 'unresolved', reservation, payload: existing.payload };
      }
      if (now - existing.reservedAt < reservationWindowMs) {
        throw inProgressError();
      }
      console.warn('[channels] Taking over an Idempotency-Key reservation that was never sent');
    }

    const record: IdempotencyRecord = { fingerprint, reservedAt: now, expiresAt: now + ttlSec * 1000 };
    checkLease();
    await kv.set(recordKey, record, { ttlSec });
    return {
      kind: 'reserved',
      reservation: { recordKey, fingerprint, reservedAt: now, expiresAt: record.expiresAt },
    };
  });

  // Another request is reserving the same key right now
  if (result === null) throw inProgressError();
  return result;
}

/**
 * Runs fn on the record under the key's lock, retrying briefly while the lock
 * is busy. Returns null if the lock stayed busy.
 */
async function withRecordLock<T>(
  kv: PluginKVStore,
  reservation: IdempotencyReservation,
  fn: (record: IdempotencyRecord | null, checkLease: () => void) => Promise<T>
): Promise<T | null> {
  for (let attempt = 0; attempt < IDEMPOTENCY.RECORD_LOCK_ATTEMPTS; attempt++) {
    const result = await withRecordLease(kv, reservation.recordKey, async (checkLease) => ({
      value: await fn(await kv.get<IdempotencyRecord>(reservation.recordKey), checkLease),
    }));
    if (result !== null) return result.value;
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
  }
  return null;
}

/** True while the record is still this reservation's and nothing was sent under it. */
function isOwnUnsentRecord(record: IdempotencyRecord | null, reservation: IdempotencyReservation): boolean {
  return (
    record !== null &&
    record.reservedAt === reservation.reservedAt &&
    record.payload === undefined &&
    record.transactionId === undefined
  );
}

/**
 * Stores the payload about to be sent, if the key is still this request's
 * unsent reservation. Throws otherwise (another request took the key over) or
 * when the write fails, so the caller does not send a transaction the key
 * cannot find again.
 */
export async function storeIdempotentPayload(
  kv: PluginKVStore,
  reservation: IdempotencyReservation,
  payload: FeeBumpPayload
): Promise<void> {
  const stored = await withRecordLock(kv, reservation, async (record, checkLease) => {
    if (!isOwnUnsentRecord(record, reservation)) return false;
    const next: IdempotencyRecord = {
      fingerprint: reservation.fingerprint,
      reservedAt: reservation.reservedAt,
      expiresAt: reservation.expiresAt,
      payload,
      sentAt: Date.now(),
    };
    checkLease();
    await kv.set(reservation.recordKey, next, { ttlSec: recordTtlSec(reservation) });
    return true;
  });
  if (!stored) throw inProgressError();
}

/**
 * Records the transaction created under a key and drops the stored payload.
 * Never replaces a transaction id already recorded, nor another reservation's
 * record. Failures are logged, not thrown: the stored payload still lets a
 * later repeat resend the same transaction.
 */
export async function recordIdempotentTransaction(
  kv: PluginKVStore,
  reservation: IdempotencyReservation,
  maxFee: number,
  transactionId: string,
  transaction?: StoredTransaction
): Promise<void> {
  try {
    const written = await withRecordLock(kv, reservation, async (record, checkLease) => {
      if (record?.transactionId) return true;
      if (record && record.reservedAt !== reservation.reservedAt) {
        console.warn('[channels] Idempotency-Key was reserved again; transaction not recorded over it');
        return true;
      }
      const next: IdempotencyRecord = {
        fingerprint: reservation.fingerprint,
        reservedAt: reservation.reservedAt,
        expiresAt: reservation.expiresAt,
        maxFee,
        transactionId,
        transaction,
      };
      checkLease();
      await kv.set(reservation.recordKey, next, { ttlSec: recordTtlSec(reservation) });
      return true;
    });
    if (!written) console.warn('[channels] Idempotency-Key record stayed locked; transaction not recorded');
  } catch (error) {
    console.warn(`[channels] Failed to record Idempotency-Key transaction: ${error}`);
  }
}

/**
 * KV key marking that a transaction sent under a key has been charged against
 * the API key's fee budget (see FeeTracker.recordUsageOnce). It must outlive
 * the record (see feeMarkerTtlSec), or a later repeat of the same transaction
 * would be charged again.
 */
export function idempotencyFeeKey(
  reservation: Pick<IdempotencyReservation, 'recordKey'>,
  transactionId: string
): string {
  // Per transaction, not per reservation: every reservation of the key shares
  // the fund relayer key, so two of them can get the same transaction back
  // (a stale reservation write, see the file comment) and must charge it once.
  // A later transaction under the key has its own id and is charged.
  return `${reservation.recordKey}:${transactionId}:fee`;
}

/**
 * TTL for a transaction's fee marker: past the expiry of every record that can
 * hold the transaction, so no repeat can find it in a record without its marker.
 *
 * The marker is shared by every reservation that gets the transaction back,
 * and the first one to charge sets its TTL. A later reservation gets it back
 * only by sending its identical signed payload, which validation accepts only
 * until its maxTime (a rebuilt transaction is a different one), so every such
 * reservation starts by maxTime and its record expires by maxTime plus the
 * record TTL. Without a maxTime only this reservation's record is covered.
 */
export function feeMarkerTtlSec(
  reservation: Pick<IdempotencyReservation, 'reservedAt' | 'expiresAt'>,
  maxTime?: number,
  now = Date.now()
): number {
  const recordTtlMs = reservation.expiresAt - reservation.reservedAt;
  const lastExpiry = Math.max(reservation.expiresAt, maxTime !== undefined ? maxTime * 1000 + recordTtlMs : 0);
  return recordTtlSec({ expiresAt: lastExpiry }, now) + IDEMPOTENCY.FEE_MARKER_MARGIN_SECONDS;
}

/**
 * Fund relayer idempotency key for a key's record, so resending its stored
 * payload returns the transaction the fund relayer already created. It is the
 * same for every reservation of the key: the fund relayer then rejects a
 * transaction rebuilt under the key while it holds the key, even if the
 * record here was overwritten or deleted (see the file comment). A takeover
 * shares it safely, since the reservation it takes over never sent.
 */
export function fundRelayerIdempotencyKey(reservation: Pick<IdempotencyReservation, 'recordKey'>): string {
  const digest = reservation.recordKey.slice(reservation.recordKey.lastIndexOf(':') + 1);
  return `channels-idempotency:${digest}`;
}

/**
 * Marks a stored send as answered with an error, so the next repeat resends
 * the stored payload right away instead of waiting out the send window.
 */
export async function markSendRejected(kv: PluginKVStore, reservation: IdempotencyReservation): Promise<void> {
  try {
    await withRecordLock(kv, reservation, async (record, checkLease) => {
      if (record?.reservedAt !== reservation.reservedAt || !record.payload || record.transactionId) return;
      checkLease();
      await kv.set(reservation.recordKey, { ...record, sentAt: 0 } satisfies IdempotencyRecord, {
        ttlSec: recordTtlSec(reservation),
      });
    });
  } catch (error) {
    console.warn(`[channels] Failed to mark Idempotency-Key send as answered: ${error}`);
  }
}

let ttlRaisedWarned = false;

/**
 * Returns the TTL to use for a key's record: the configured value, raised to
 * minSeconds when below it. A record must outlive its transaction (time
 * bounds plus the send reply window); otherwise it could expire while the
 * transaction may still land, and a repeat would build a second one.
 */
export function effectiveIdempotencyTtlSec(configuredSeconds: number, minSeconds: number): number {
  if (configuredSeconds >= minSeconds) return configuredSeconds;
  if (!ttlRaisedWarned) {
    ttlRaisedWarned = true;
    console.warn(
      `[channels] IDEMPOTENCY_KEY_TTL_SECONDS (${configuredSeconds}s) is below the transaction lifetime; using ${minSeconds}s. Keep the Relayer's IDEMPOTENCY_KEY_TTL_SECONDS at least ${minSeconds}s`
    );
  }
  return minSeconds;
}

/**
 * Decodes the inner transaction of a stored payload: its hash, source,
 * sequence and maxTime. Returns undefined when the XDR cannot be decoded as a
 * regular transaction.
 */
export function describeStoredTransaction(
  payload: FeeBumpPayload,
  networkPassphrase: string
): StoredTransaction | undefined {
  try {
    const tx = TransactionBuilder.fromXDR(payload.transaction_xdr, networkPassphrase);
    if (tx instanceof FeeBumpTransaction) return undefined;
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    return {
      innerHash: Buffer.from(tx.hash()).toString('hex'),
      source: tx.source,
      sequence: tx.sequence,
      maxTime: maxTime > 0 ? maxTime : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * True once a stored transaction can no longer be included in a ledger: its
 * maxTime, plus a margin for ledger close time, is in the past. A transaction
 * without a maxTime never expires.
 */
export function hasStoredTransactionExpired(transaction: StoredTransaction | undefined, now = Date.now()): boolean {
  if (transaction?.maxTime === undefined) return false;
  return now > transaction.maxTime * 1000 + IDEMPOTENCY.EXPIRY_MARGIN_MS;
}

/** Why the outcome of a key's transaction cannot be read. */
export type OutcomeUnknownCause = 'gone' | 'expired';

const OUTCOME_UNKNOWN_SUMMARY: Record<OutcomeUnknownCause, string> = {
  gone: 'The fund relayer no longer has the transaction sent for this Idempotency-Key, so its outcome is unknown.',
  expired:
    'The transaction stored for this Idempotency-Key has expired, so it can no longer execute, but the fund relayer returned an error when it was resent, so whether it landed is unknown.',
};

/**
 * The error for a key whose transaction outcome cannot be read from the
 * Relayer: it no longer has the transaction (pruned after it became final, or
 * its create stopped before storing it), or the stored transaction expired
 * while the Relayer kept returning errors. The key is kept. The plugin knows
 * only the inner transaction; the network records the fund relayer's fee
 * bump under a different hash.
 */
export function outcomeUnknownError(cause: OutcomeUnknownCause, reason: string, details: Record<string, unknown>) {
  return pluginError(
    `${OUTCOME_UNKNOWN_SUMMARY[cause]} Before retrying with a new key, check whether it landed: details.innerHash is the inner transaction hash, not the hash the network records for the fee bump, so search the transactions of details.source for a fee bump whose inner transaction hash is details.innerHash. A not-found lookup by hash alone is not proof that it did not land.`,
    {
      code: 'IDEMPOTENCY_KEY_OUTCOME_UNKNOWN',
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      details: { reason, ...details },
    }
  );
}

/**
 * The error for a send of the stored transaction, first or repeated, that the
 * fund relayer answered with an error. The error does not show whether the
 * transaction was stored, so the key and its payload are kept: the caller
 * retries with the same key, never a new one.
 */
export function sendFailedError(reason: string, transaction: StoredTransaction | undefined) {
  return pluginError(
    'The fund relayer returned an error for the transaction stored under this Idempotency-Key. It may still have been stored and can land: retry with the same key, never a new one, which could execute a second transaction.',
    {
      code: 'IDEMPOTENCY_KEY_SEND_FAILED',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      details: { reason, ...transaction },
    }
  );
}

/**
 * The error for a send the fund relayer rejected because it holds the fund
 * relayer key for a different payload: an earlier request with this key sent
 * another transaction, and the key was reused after this plugin's record
 * expired, or the record was overwritten. The fund relayer created nothing for
 * this send. The key cannot be used until the fund relayer's key expires.
 *
 * It carries no transaction details: the only transaction the plugin knows here
 * is the refused one, and a lookup of it finds nothing, which says nothing
 * about the earlier transaction. The Relayer does not return the earlier one,
 * and the plugin's record of it is gone.
 */
export function keyConflictError(reason: string) {
  return pluginError(
    'The fund relayer holds this Idempotency-Key for a different transaction, sent by an earlier request with this key, so it did not create this one. The key cannot be used again until the fund relayer releases it (its IDEMPOTENCY_KEY_TTL_SECONDS after the earlier send). This error does not identify the earlier transaction, which may have executed: a new key can execute the request a second time, so confirm from your own records or the on-chain state the request changes whether it executed before using one.',
    {
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      details: { reason },
    }
  );
}

/**
 * The caller identity a key is scoped to: the API key, or else the
 * Authorization header. A key sent with neither is rejected, since all such
 * callers would share one namespace and could claim or read each other's keys.
 */
export function idempotencyScope(headers: Record<string, string[]> | undefined, apiKey: string | undefined): string {
  if (apiKey) return `api-key:${apiKey}`;
  const name = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === 'authorization');
  const authorization = name ? headers![name]?.[0]?.trim() : undefined;
  if (authorization) return `authorization:${authorization}`;
  throw pluginError('An Idempotency-Key requires an API key or Authorization header to scope it to the caller', {
    code: 'API_KEY_REQUIRED',
    status: HTTP_STATUS.BAD_REQUEST,
  });
}

/**
 * Frees a key whose request ended before sending, unless another request has
 * taken it over since. A record with a stored payload is never deleted: a
 * transaction may exist for it, and a concurrent repeat may be resending it.
 */
export async function releaseIdempotencyKey(kv: PluginKVStore, reservation: IdempotencyReservation): Promise<void> {
  try {
    await withRecordLock(kv, reservation, async (record, checkLease) => {
      if (isOwnUnsentRecord(record, reservation)) {
        checkLease();
        await kv.del(reservation.recordKey);
      }
    });
  } catch (error) {
    console.warn(`[channels] Failed to release Idempotency-Key: ${error}`);
  }
}

/** The error for a key whose transaction is still being created. */
export function inProgressError() {
  return pluginError('A request with this Idempotency-Key is already in progress', {
    code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    status: HTTP_STATUS.CONFLICT,
  });
}
