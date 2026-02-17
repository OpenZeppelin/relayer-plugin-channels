import { describe, test, expect, vi, beforeEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { getSequence, commitSequence, clearSequence } from '../src/plugin/sequence';
import { FakeKV } from './helpers/fakeKV';
import type { Relayer } from '@openzeppelin/relayer-sdk';

const NETWORK = 'testnet';
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const KV_KEY = `${NETWORK}:channel:seq:${ADDRESS}`;

function mockRelayerWithSequence(seq: string): Relayer {
  vi.spyOn(xdr.LedgerEntryData, 'fromXDR').mockReturnValue({
    account: () => ({
      seqNum: () => ({ toString: () => seq }),
    }),
  } as unknown as xdr.LedgerEntryData);

  return {
    rpc: vi.fn().mockResolvedValue({
      id: '1',
      result: { entries: [{ xdr: 'AAAA' }] },
      error: null,
    }),
  } as unknown as Relayer;
}

describe('sequence cache', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    vi.restoreAllMocks();
  });

  describe('getSequence', () => {
    test('returns cached sequence from KV when fresh', async () => {
      await kv.set(KV_KEY, { sequence: '200', storedAt: Date.now() });
      const relayer = {} as Relayer;
      const seq = await getSequence(kv, NETWORK, relayer, ADDRESS);
      expect(seq).toBe('200');
    });

    test('falls back to chain on KV miss', async () => {
      const relayer = mockRelayerWithSequence('100');
      const seq = await getSequence(kv, NETWORK, relayer, ADDRESS);
      expect(seq).toBe('100');
      expect(relayer.rpc).toHaveBeenCalled();
    });

    test('falls back to chain when cached entry is stale', async () => {
      // storedAt 3 minutes ago — older than 2 min threshold
      await kv.set(KV_KEY, { sequence: '200', storedAt: Date.now() - 180_000 });
      const relayer = mockRelayerWithSequence('250');
      const seq = await getSequence(kv, NETWORK, relayer, ADDRESS);
      expect(seq).toBe('250');
      expect(relayer.rpc).toHaveBeenCalled();
    });

    test('falls back to chain when storedAt is missing', async () => {
      // Entry without storedAt (e.g. written by older code)
      await kv.set(KV_KEY, { sequence: '200' });
      const relayer = mockRelayerWithSequence('250');
      const seq = await getSequence(kv, NETWORK, relayer, ADDRESS);
      expect(seq).toBe('250');
      expect(relayer.rpc).toHaveBeenCalled();
    });
  });

  describe('commitSequence', () => {
    test('writes next sequence (current + 1) with storedAt to KV', async () => {
      const before = Date.now();
      await commitSequence(kv, NETWORK, ADDRESS, '500');
      const stored = await kv.get<{ sequence: string; storedAt: number }>(KV_KEY);
      expect(stored?.sequence).toBe('501');
      expect(stored?.storedAt).toBeGreaterThanOrEqual(before);
      expect(stored?.storedAt).toBeLessThanOrEqual(Date.now());
    });

    test('does not throw on KV error', async () => {
      const brokenKv = {
        get: vi.fn(),
        set: vi.fn().mockRejectedValue(new Error('KV down')),
        del: vi.fn(),
      } as unknown as FakeKV;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(commitSequence(brokenKv, NETWORK, ADDRESS, '500')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('clearSequence', () => {
    test('deletes KV entry', async () => {
      await kv.set(KV_KEY, { sequence: '200', storedAt: Date.now() });
      await clearSequence(kv, NETWORK, ADDRESS);
      const stored = await kv.get(KV_KEY);
      expect(stored).toBeNull();
    });
  });
});
