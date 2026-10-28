/**
 * Tests for Idempotency-Key parsing, fingerprinting and key reservation.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { FakeKV } from './helpers/fakeKV';
import {
  getIdempotencyKey,
  idempotencyRecordKey,
  recordIdempotentTransaction,
  releaseIdempotencyKey,
  requestFingerprint,
  reserveIdempotencyKey,
  storeIdempotentPayload,
  fundRelayerIdempotencyKey,
  idempotencyFeeKey,
  feeMarkerTtlSec,
  effectiveIdempotencyTtlSec,
  describeStoredTransaction,
  idempotencyScope,
} from '../src/plugin/idempotency';
import type { FeeBumpPayload } from '../src/plugin/idempotency';
import type { ChannelAccountsRequest } from '../src/plugin/types';

const WINDOW_MS = 60_000;
const SEND_MS = 35_000;
const OPTS = { reservationWindowMs: WINDOW_MS, sendWindowMs: SEND_MS, ttlSec: 3600 };
const PAYLOAD: FeeBumpPayload = { network: 'testnet', transaction_xdr: 'FEE_BUMP_XDR', fee_bump: true, max_fee: 1000 };

const xdrRequest = (value = 'SIGNED_XDR'): ChannelAccountsRequest => ({
  type: 'xdr',
  xdr: value,
  skipWait: false,
});

function funcAuthRequest(amount: bigint): ChannelAccountsRequest {
  const contract = StrKey.encodeContract(new Uint8Array(32).fill(7));
  const account = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: 'transfer',
      args: [new Address(account).toScVal(), new Address(account).toScVal(), nativeToScVal(amount, { type: 'i128' })],
    })
  );
  return { type: 'func-auth', func, auth: [], skipWait: false };
}

describe('getIdempotencyKey', () => {
  test('returns undefined without the header', () => {
    expect(getIdempotencyKey({})).toBeUndefined();
    expect(getIdempotencyKey(undefined)).toBeUndefined();
  });

  test('matches the header name case-insensitively and trims the value', () => {
    expect(getIdempotencyKey({ 'Idempotency-Key': [' key-1 '] })).toBe('key-1');
    expect(getIdempotencyKey({ 'idempotency-key': ['key-2'] })).toBe('key-2');
  });

  test.each([[''], ['   '], ['x'.repeat(256)], ['café-1'], ['key\u0001']])('rejects an invalid key %#', (value) => {
    expect(() => getIdempotencyKey({ 'idempotency-key': [value] })).toThrow(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY', status: 400 })
    );
  });

  test('accepts a key of the maximum length', () => {
    expect(getIdempotencyKey({ 'idempotency-key': ['x'.repeat(255)] })).toHaveLength(255);
  });
});

describe('requestFingerprint', () => {
  test('is stable for the same request and ignores skipWait', () => {
    expect(requestFingerprint(xdrRequest(), 'fund-1')).toBe(
      requestFingerprint({ ...xdrRequest(), skipWait: true } as ChannelAccountsRequest, 'fund-1')
    );
  });

  test('differs by request content and fund relayer', () => {
    const base = requestFingerprint(xdrRequest(), 'fund-1');
    expect(requestFingerprint(xdrRequest('OTHER_XDR'), 'fund-1')).not.toBe(base);
    expect(requestFingerprint(xdrRequest(), 'fund-2')).not.toBe(base);
    expect(requestFingerprint(funcAuthRequest(100n), 'fund-1')).not.toBe(
      requestFingerprint(funcAuthRequest(900n), 'fund-1')
    );
  });
});

describe('idempotencyRecordKey', () => {
  test('scopes keys by caller', () => {
    expect(idempotencyRecordKey('testnet', 'api-key-a', 'k')).not.toBe(
      idempotencyRecordKey('testnet', 'api-key-b', 'k')
    );
    expect(idempotencyRecordKey('testnet', 'api-key-a', 'k')).toBe(idempotencyRecordKey('testnet', 'api-key-a', 'k'));
    expect(idempotencyRecordKey('testnet', 'a', 'k')).not.toContain('api-key');
  });
});

describe('reserveIdempotencyKey', () => {
  let kv: FakeKV;
  const recordKey = 'testnet:idempotency:abc';

  beforeEach(() => {
    kv = new FakeKV();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('reserves a new key', async () => {
    const result = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    expect(result.kind).toBe('reserved');
    expect(await kv.get(recordKey)).toMatchObject({ fingerprint: 'fp' });
  });

  test('returns the recorded transaction for a repeated request', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);
    await recordIdempotentTransaction(kv, first.reservation, PAYLOAD.max_fee, 'tx-1');

    expect(await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).toMatchObject({
      kind: 'existing',
      transactionId: 'tx-1',
      maxFee: PAYLOAD.max_fee,
    });
  });

  test('rejects a key reused for a different request', async () => {
    await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    await expect(reserveIdempotencyKey(kv, recordKey, 'other-fp', OPTS)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
    });
  });

  test('rejects a repeat while the first request has no transaction yet', async () => {
    await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    await expect(reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      status: 409,
    });
  });

  test('lets only one of two concurrent requests reserve the key', async () => {
    const results = await Promise.allSettled([
      reserveIdempotencyKey(kv, recordKey, 'fp', OPTS),
      reserveIdempotencyKey(kv, recordKey, 'fp', OPTS),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
  });

  test('takes over a reservation abandoned past the in-flight window', async () => {
    vi.useFakeTimers();
    await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    vi.advanceTimersByTime(WINDOW_MS);

    const result = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    expect(result.kind).toBe('reserved');
  });

  test('a send without a recorded reply gets 409 during the send window, then is resent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);

    await expect(reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });

    vi.setSystemTime(Date.now() + SEND_MS);
    expect(await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).toMatchObject({
      kind: 'unresolved',
      payload: PAYLOAD,
    });
    // The resend re-armed the window, so a concurrent repeat does not resend too
    await expect(reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
  });

  test('a recorded transaction replaces the stored payload', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);
    await recordIdempotentTransaction(kv, first.reservation, PAYLOAD.max_fee, 'tx-1');

    const record = await kv.get<Record<string, unknown>>(recordKey);
    expect(record).not.toHaveProperty('payload');
    expect(record).toMatchObject({ transactionId: 'tx-1', maxFee: PAYLOAD.max_fee });
    expect(JSON.stringify(record).length).toBeLessThan(200);
  });

  test('never replaces a transaction id already recorded', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);
    await recordIdempotentTransaction(kv, first.reservation, PAYLOAD.max_fee, 'tx-1');
    await recordIdempotentTransaction(kv, first.reservation, PAYLOAD.max_fee, 'tx-2');

    expect(await kv.get(recordKey)).toMatchObject({ transactionId: 'tx-1' });
  });

  test('does not store a payload once another request took the key over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    vi.setSystemTime(Date.now() + WINDOW_MS);
    const takeover = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    expect(takeover.kind).toBe('reserved');

    await expect(storeIdempotentPayload(kv, first.reservation, PAYLOAD)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
    expect(await kv.get(recordKey)).not.toHaveProperty('payload');
  });

  test('releasing does not delete a key another request took over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    vi.setSystemTime(Date.now() + WINDOW_MS);
    await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);

    await releaseIdempotencyKey(kv, first.reservation);
    expect(await kv.exists(recordKey)).toBe(true);
  });

  test('never takes over a reservation whose payload was stored, even after the window', async () => {
    vi.useFakeTimers();
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);
    vi.advanceTimersByTime(WINDOW_MS * 10);

    expect((await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).kind).toBe('unresolved');
  });

  test('storing the payload fails loudly so nothing is sent', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    vi.spyOn(kv, 'set').mockRejectedValueOnce(new Error('kv down'));

    await expect(storeIdempotentPayload(kv, first.reservation, PAYLOAD)).rejects.toThrow('kv down');
  });

  test('a release never deletes a record with a stored payload', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await storeIdempotentPayload(kv, first.reservation, PAYLOAD);

    await releaseIdempotencyKey(kv, first.reservation);

    expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });
  });

  test('a transaction id is never recorded over another reservation of the key', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    // The key was freed and reserved again by a later request
    await kv.set(recordKey, { fingerprint: 'fp', reservedAt: first.reservation.reservedAt + 1 });

    await recordIdempotentTransaction(kv, first.reservation, 1000, 'tx-stale');

    expect(await kv.get(recordKey)).toEqual({ fingerprint: 'fp', reservedAt: first.reservation.reservedAt + 1 });
  });

  test('derives one fund relayer key for every reservation of a key', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    expect(fundRelayerIdempotencyKey(first.reservation)).toBe('channels-idempotency:abc');
    // Every reservation of the key shares it, so the fund relayer rejects a rebuilt transaction
    expect(fundRelayerIdempotencyKey({ ...first.reservation, reservedAt: first.reservation.reservedAt + 1 })).toBe(
      fundRelayerIdempotencyKey(first.reservation)
    );
  });

  test('derives the fee marker key from the transaction, not the reservation', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    expect(idempotencyFeeKey(first.reservation, 'tx-1')).toBe(`${recordKey}:tx-1:fee`);
    // Another reservation of the key that gets the same transaction shares the marker
    expect(idempotencyFeeKey({ ...first.reservation, reservedAt: first.reservation.reservedAt + 1 }, 'tx-1')).toBe(
      idempotencyFeeKey(first.reservation, 'tx-1')
    );
  });

  test('feeMarkerTtlSec covers any record that can hold the transaction', () => {
    // Record from 0 to 671s; the transaction is valid until 600s, so a later
    // reservation can start by 600s and last until 1271s
    const reservation = { reservedAt: 0, expiresAt: 671_000 };
    expect(feeMarkerTtlSec(reservation, 600, 0)).toBe(1271 + 300);
    // Never shorter than this reservation's own record
    const late = { reservedAt: 1_000_000, expiresAt: 1_671_000 };
    expect(feeMarkerTtlSec(late, 10, 1_000_000)).toBe(671 + 300);
    expect(feeMarkerTtlSec(late, undefined, 1_000_000)).toBe(671 + 300);
  });

  test('effectiveIdempotencyTtlSec raises a TTL below the transaction lifetime', () => {
    expect(effectiveIdempotencyTtlSec(3600, 131)).toBe(3600);
    expect(effectiveIdempotencyTtlSec(300, 671)).toBe(671);
  });

  describe('lease check', () => {
    /** Makes every clock reading after the first one land past the write budget, as after a stall. */
    function stallAfterLockRequest() {
      let calls = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => (calls++ === 0 ? 0 : 3_000));
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('a reservation stalled past the budget writes nothing and gets 409', async () => {
      stallAfterLockRequest();
      await expect(reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
        status: 409,
      });
      expect(await kv.get(recordKey)).toBeNull();
    });

    test('the clock starts before the lock is requested, so a late lock grant counts', async () => {
      let calls = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => (calls++ === 0 ? 0 : 3_000));
      const withLock = kv.withLock.bind(kv);
      // The clock was read once before withLock was called
      vi.spyOn(kv, 'withLock').mockImplementation((key, fn, opts) => {
        expect(calls).toBe(1);
        return withLock(key, fn, opts);
      });
      await expect(reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).rejects.toMatchObject({ status: 409 });
    });

    test('a payload store stalled past the budget writes nothing, so nothing is sent', async () => {
      const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
      if (first.kind !== 'reserved') throw new Error('expected reservation');
      stallAfterLockRequest();
      await expect(storeIdempotentPayload(kv, first.reservation, PAYLOAD)).rejects.toMatchObject({ status: 409 });
      expect(await kv.get(recordKey)).not.toHaveProperty('payload');
    });

    test('a release stalled past the budget deletes nothing', async () => {
      const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
      if (first.kind !== 'reserved') throw new Error('expected reservation');
      stallAfterLockRequest();
      await releaseIdempotencyKey(kv, first.reservation);
      expect(await kv.get(recordKey)).toMatchObject({ reservedAt: first.reservation.reservedAt });
    });

    test('a transaction id write stalled past the budget is skipped; the payload stays for a resend', async () => {
      const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
      if (first.kind !== 'reserved') throw new Error('expected reservation');
      await storeIdempotentPayload(kv, first.reservation, PAYLOAD);
      stallAfterLockRequest();
      await recordIdempotentTransaction(kv, first.reservation, 1000, 'tx-1');
      expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });
      expect(await kv.get(recordKey)).not.toHaveProperty('transactionId');
    });
  });

  test('a released key can be reserved again', async () => {
    const first = await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await releaseIdempotencyKey(kv, first.reservation);

    expect((await reserveIdempotencyKey(kv, recordKey, 'fp', OPTS)).kind).toBe('reserved');
  });
});

describe('stored transaction', () => {
  function signedXdr(maxTime: number) {
    const source = Keypair.random();
    const tx = new TransactionBuilder(new Account(source.publicKey(), '41'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime },
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '50' }))
      .build();
    return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex'), source: source.publicKey() };
  }

  test('describes the inner transaction of a payload', () => {
    const { xdr: transaction_xdr, hash, source } = signedXdr(1_800_000_000);

    expect(describeStoredTransaction({ ...PAYLOAD, transaction_xdr }, Networks.TESTNET)).toEqual({
      innerHash: hash,
      source,
      sequence: '42',
      maxTime: 1_800_000_000,
    });
  });

  test('a transaction without time bounds has no maxTime', () => {
    const { xdr: transaction_xdr } = signedXdr(0);

    expect(describeStoredTransaction({ ...PAYLOAD, transaction_xdr }, Networks.TESTNET)?.maxTime).toBeUndefined();
  });

  test('an undecodable payload is not described', () => {
    expect(describeStoredTransaction(PAYLOAD, Networks.TESTNET)).toBeUndefined();
  });
});

describe('idempotencyScope', () => {
  test('uses the API key when present', () => {
    expect(idempotencyScope({ authorization: ['Bearer t'] }, 'key-a')).toBe('api-key:key-a');
  });

  test('falls back to the Authorization header, matched case-insensitively', () => {
    expect(idempotencyScope({ Authorization: ['Bearer t'] }, undefined)).toBe('authorization:Bearer t');
  });

  test('rejects a caller with neither', () => {
    expect(() => idempotencyScope({}, undefined)).toThrow(expect.objectContaining({ code: 'API_KEY_REQUIRED' }));
    expect(() => idempotencyScope({ authorization: ['  '] }, undefined)).toThrow(
      expect.objectContaining({ code: 'API_KEY_REQUIRED' })
    );
  });
});
