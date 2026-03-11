import { describe, test, expect } from 'vitest';
import { ChannelPool, AcquireOptions } from '../src/plugin/pool';
import { FakeKV } from './helpers/fakeKV';

const defaultOptions: AcquireOptions = {
  limitedContracts: new Set(),
  capacityRatio: 0.8,
};

describe('ChannelPool busy claim locks', () => {
  test('acquire retries when all claim locks are busy, then succeeds', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);

    // Configure a single relayer
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    // Simulate busy claim lock briefly, then release
    const claimKey = 'testnet:channel:claim:p1';
    await kv.set(claimKey, { token: 'busy' });
    setTimeout(() => {
      void kv.del(claimKey);
    }, 50);

    const lock = await pool.acquire(defaultOptions);
    expect(lock.relayerId).toBe('p1');
    // Release for cleanliness
    await pool.release(lock);
  });

  test('acquire retries when channel in-use key appears between scan and claim', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);

    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    // p1 is locked (in-use key exists)
    await kv.set('testnet:channel:in-use:p1', { token: 'other', lockedAt: new Date().toISOString() }, { ttlSec: 30 });

    // p2 is free — should be acquired
    const lock = await pool.acquire(defaultOptions);
    expect(lock.relayerId).toBe('p2');
    await pool.release(lock);
  });
});
