import { describe, test, expect } from 'vitest';
import { ChannelPool, AcquireOptions } from '../src/plugin/pool';
import { FakeKV } from './helpers/fakeKV';

const defaultOptions: AcquireOptions = {
  limitedContracts: new Set(),
  capacityRatio: 0.8,
};

describe('ChannelPool', () => {
  test('acquire distributes and release removes lock', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    const l1 = await pool.acquire(defaultOptions);
    const l2 = await pool.acquire(defaultOptions);
    expect(['p1', 'p2']).toContain(l1.relayerId);
    expect(['p1', 'p2']).toContain(l2.relayerId);
    expect(l1.relayerId).not.toEqual(l2.relayerId);

    // Next acquire should fail (both locked)
    const err = await pool.acquire(defaultOptions).catch((e) => e);
    expect(err.message).toContain('Too many transactions queued');
    expect(err.code).toBe('POOL_CAPACITY');
    expect(err.status).toBe(503);
    expect(err.details).toMatchObject({
      reason: 'all_channels_busy_or_mutex_contention',
      totalChannels: 2,
      candidateChannels: 2,
      busyCandidates: 2,
      availableCandidates: 0,
    });

    // Release one and ensure lock key gone
    await pool.release(l1);
    const stillLocked = await kv.exists(`testnet:channel:in-use:${l1.relayerId}`);
    expect(stillLocked).toBe(false);
  });

  test('acquire fails on empty membership', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: [] });
    await expect(pool.acquire(defaultOptions)).rejects.toThrow('No channel accounts configured');
  });

  test('limited-contract exhaustion reports limited capacity diagnostics', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    const limitedOptions: AcquireOptions = {
      contractId: 'C123',
      limitedContracts: new Set(['C123']),
      capacityRatio: 0.5,
    };

    await pool.acquire(limitedOptions);
    const err = await pool.acquire(limitedOptions).catch((e) => e);

    expect(err.code).toBe('POOL_CAPACITY');
    expect(err.details).toMatchObject({
      reason: 'limited_contract_capacity',
      contractId: 'C123',
      totalChannels: 2,
      candidateChannels: 1,
      busyCandidates: 1,
      availableCandidates: 0,
    });
  });
});
