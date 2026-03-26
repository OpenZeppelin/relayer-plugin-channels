/**
 * Safety-property tests for ChannelPool.
 *
 * These tests lock in invariants that must hold regardless of implementation changes:
 * - One acquire never owns more than one channel
 * - Release only removes a lock with a matching token
 * - No raw delete path for in-use locks (all removals go through token-checked release)
 * - Sampled acquire never calls listKeys
 * - High-concurrency: no duplicate allocation
 */

import { describe, test, expect, vi } from 'vitest';
import { ChannelPool, AcquireOptions } from '../src/plugin/pool';
import { FakeKV } from './helpers/fakeKV';

const defaultOptions: AcquireOptions = {
  limitedContracts: new Set(),
  capacityRatio: 0.8,
};

describe('ChannelPool safety properties', () => {
  test('one acquire never owns more than one channel', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'] });

    // Track all in-use keys set during a single acquire
    const inUseKeysSet: string[] = [];
    const origSet = kv.set.bind(kv);
    vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
      if (key.startsWith('testnet:channel:in-use:')) {
        inUseKeysSet.push(key);
      }
      return origSet(key, value, opts);
    });

    const lock = await pool.acquire(defaultOptions);

    // Exactly one in-use key should have been created
    expect(inUseKeysSet.length).toBe(1);
    expect(inUseKeysSet[0]).toBe(`testnet:channel:in-use:${lock.relayerId}`);
  });

  test('release only removes lock with matching token', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);

    // Attempt release with wrong token — lock must survive
    const wrongLock = { relayerId: lock.relayerId, token: 'wrong-token' };
    await pool.release(wrongLock);
    const stillExists = await kv.exists(`testnet:channel:in-use:${lock.relayerId}`);
    expect(stillExists).toBe(true);

    // Release with correct token — lock must be removed
    await pool.release(lock);
    const afterRelease = await kv.exists(`testnet:channel:in-use:${lock.relayerId}`);
    expect(afterRelease).toBe(false);
  });

  test('releaseWithCooldown only applies to matching token', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);
    const originalToken = lock.token;

    // Attempt cooldown with wrong token — must be a no-op
    const setSpy = vi.spyOn(kv, 'set');
    await pool.releaseWithCooldown({ relayerId: lock.relayerId, token: 'wrong-token' });
    const cooldownCalls = setSpy.mock.calls.filter((c) => c[0] === `testnet:channel:in-use:${lock.relayerId}`);
    expect(cooldownCalls).toHaveLength(0);

    // Original lock must still exist with its token
    const stored = await kv.get<{ token: string }>(`testnet:channel:in-use:${lock.relayerId}`);
    expect(stored?.token).toBe(originalToken);
  });

  test('no raw kv.del calls on in-use lock keys during acquire', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2', 'p3'] });

    // Pre-lock some channels to force claim retries
    await kv.set(
      'testnet:channel:in-use:p1',
      { token: 'other-worker', lockedAt: new Date().toISOString() },
      { ttlSec: 30 }
    );

    const delSpy = vi.spyOn(kv, 'del');
    const lock = await pool.acquire(defaultOptions);

    // No del() should have been called on any in-use key during acquire
    const inUseDelCalls = delSpy.mock.calls.filter((c) => (c[0] as string).startsWith('testnet:channel:in-use:'));
    expect(inUseDelCalls).toHaveLength(0);

    // Cleanup
    await pool.release(lock);
  });

  test('acquire never calls listKeys', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    const ids = Array.from({ length: 50 }, (_, i) => `ch${i}`);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ids });

    const listKeysSpy = vi.spyOn(kv, 'listKeys');

    // Acquire and exhaust to trigger all spins
    const locks = [];
    for (let i = 0; i < 5; i++) {
      locks.push(await pool.acquire(defaultOptions));
    }

    expect(listKeysSpy).not.toHaveBeenCalled();

    // Cleanup
    for (const l of locks) await pool.release(l);
  });

  test('high-concurrency: 200 workers, 50 channels, no duplicate allocation', async () => {
    const numChannels = 50;
    const numWorkers = 200;
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    const ids = Array.from({ length: numChannels }, (_, i) => `ch${i}`);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ids });

    const promises = Array.from({ length: numWorkers }, () =>
      pool.acquire(defaultOptions).then(
        (lock) => ({ ok: true as const, lock }),
        (err) => ({ ok: false as const, err })
      )
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.ok).map((r) => (r as any).lock);
    const failures = results.filter((r) => !r.ok);

    // Exactly numChannels should succeed
    expect(successes.length).toBe(numChannels);
    expect(failures.length).toBe(numWorkers - numChannels);

    // No duplicate relayerIds
    const acquiredIds = successes.map((l: any) => l.relayerId);
    expect(new Set(acquiredIds).size).toBe(numChannels);

    // Every stored token matches the returned token
    for (const lock of successes) {
      const stored = await kv.get<{ token: string }>(`testnet:channel:in-use:${lock.relayerId}`);
      expect(stored?.token).toBe(lock.token);
    }

    // All failures are POOL_CAPACITY
    for (const f of failures) {
      expect((f as any).err.code).toBe('POOL_CAPACITY');
    }
  }, 30_000);

  test('concurrent acquire + release: released channels are reusable', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    // Acquire both channels
    const l1 = await pool.acquire(defaultOptions);
    const l2 = await pool.acquire(defaultOptions);

    // Release one, acquire again — must get the released one back
    await pool.release(l1);
    const l3 = await pool.acquire(defaultOptions);
    expect(l3.relayerId).toBe(l1.relayerId);

    // Token must be different (new lock, not reuse of old)
    expect(l3.token).not.toBe(l1.token);

    // Cleanup
    await pool.release(l2);
    await pool.release(l3);
  });
});
