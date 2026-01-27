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
    await expect(pool.acquire(defaultOptions)).rejects.toThrow('Too many transactions queued');

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
});
