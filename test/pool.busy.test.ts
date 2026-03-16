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

  test('acquire skips channel claimed between scan and claim (TOCTOU race)', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);

    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    // Intercept exists() inside the claim lock: when the pool double-checks p1,
    // inject the in-use key just before the check — simulating another worker
    // claiming p1 between our scan (which showed p1 as free) and our claim.
    let injected = false;
    const origExists = kv.exists.bind(kv);
    kv.exists = async (key: string) => {
      if (!injected && key === 'testnet:channel:in-use:p1') {
        injected = true;
        await kv.set('testnet:channel:in-use:p1', { token: 'other-worker', lockedAt: new Date().toISOString() }, { ttlSec: 30 });
      }
      return origExists(key);
    };

    const lock = await pool.acquire(defaultOptions);
    // p1 was "free" in the scan but claimed by the time we try — pool falls through to p2
    expect(lock.relayerId).toBe('p2');
    await pool.release(lock);

    kv.exists = origExists;
  });
});
