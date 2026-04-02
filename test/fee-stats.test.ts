import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fetchDynamicInclusionFee } from '../src/plugin/fee-stats';
import { FakeKV } from './helpers/fakeKV';

function makeRelayer(response: any) {
  return { rpc: vi.fn().mockResolvedValue(response) } as any;
}

function makeFeeStatsResponse(percentileValues: Record<string, string>) {
  return {
    id: '1',
    result: { sorobanInclusionFee: percentileValues },
  };
}

describe('fee-stats', () => {
  const NETWORK = 'testnet';
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
  });

  test('returns fee from getFeeStats for requested percentile', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150', p90: '300' }));
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBe(150);
    expect(relayer.rpc).toHaveBeenCalledOnce();
  });

  test('returns cached value on second call within TTL', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));

    await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 60_000);
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 60_000);

    expect(fee).toBe(150);
    expect(relayer.rpc).toHaveBeenCalledOnce(); // only one RPC call
  });

  test('fetches fresh value after cache expires', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));

    // Use TTL of 0 so cache expires immediately
    await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 0);
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 0);

    expect(fee).toBe(150);
    expect(relayer.rpc).toHaveBeenCalledTimes(2);
  });

  test('different percentiles are cached independently', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150', p90: '300' }));

    const fee50 = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 60_000);
    const fee90 = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p90', 60_000);

    expect(fee50).toBe(150);
    expect(fee90).toBe(300);
    expect(relayer.rpc).toHaveBeenCalledTimes(2);
  });

  test('returns null on RPC network error', async () => {
    const relayer = { rpc: vi.fn().mockRejectedValue(new Error('network down')) } as any;
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('returns null on RPC error response', async () => {
    const relayer = makeRelayer({ id: '1', error: { code: -1, message: 'bad' } });
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('returns null when percentile key is missing from response', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p90: '300' }));
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('returns null when sorobanInclusionFee is missing', async () => {
    const relayer = makeRelayer({ id: '1', result: {} });
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('returns null when fee value is not a valid number', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: 'not-a-number' }));
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('returns null when fee value is negative', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '-100' }));
    const fee = await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);
    expect(fee).toBeNull();
  });

  test('stores result in KV so other workers can read it', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));
    await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);

    const stored = await kv.get<{ fee: number; storedAt: number }>('testnet:fee-stats:p50');
    expect(stored).not.toBeNull();
    expect(stored!.fee).toBe(150);
  });

  test('RPC is called with correct getFeeStats method', async () => {
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));
    await fetchDynamicInclusionFee(relayer, kv as any, NETWORK, 'p50', 10_000);

    expect(relayer.rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'getFeeStats',
        params: {},
      })
    );
  });

  test('survives KV write failure gracefully', async () => {
    const badKv = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('KV down')),
    } as any;
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));

    const fee = await fetchDynamicInclusionFee(relayer, badKv, NETWORK, 'p50', 10_000);
    expect(fee).toBe(150); // still returns the fetched value
  });

  test('survives KV read failure and fetches from RPC', async () => {
    const badKv = {
      get: vi.fn().mockRejectedValue(new Error('KV down')),
      set: vi.fn().mockResolvedValue(true),
    } as any;
    const relayer = makeRelayer(makeFeeStatsResponse({ p50: '150' }));

    const fee = await fetchDynamicInclusionFee(relayer, badKv, NETWORK, 'p50', 10_000);
    expect(fee).toBe(150);
    expect(relayer.rpc).toHaveBeenCalledOnce();
  });
});
