import { describe, test, expect, vi } from 'vitest';
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

  test('extendLock refreshes TTL when token matches', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);
    await pool.extendLock(lock);

    // Lock should still exist (extended, not deleted)
    const exists = await kv.exists(`testnet:channel:in-use:${lock.relayerId}`);
    expect(exists).toBe(true);

    // Should still be releasable with same token
    await pool.release(lock);
    const afterRelease = await kv.exists(`testnet:channel:in-use:${lock.relayerId}`);
    expect(afterRelease).toBe(false);
  });

  test('extendLock is no-op when token does not match', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);
    const wrongLock = { relayerId: lock.relayerId, token: 'wrong-token' };

    // Spy on kv.set to verify it's not called for the extend
    const setSpy = vi.spyOn(kv, 'set');
    await pool.extendLock(wrongLock);

    // set should not have been called (token mismatch)
    const extendCalls = setSpy.mock.calls.filter((c) => c[0] === `testnet:channel:in-use:${lock.relayerId}`);
    expect(extendCalls).toHaveLength(0);
  });

  test('extendLock silently handles KV errors', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);

    // Make kv.get throw
    vi.spyOn(kv, 'get').mockRejectedValue(new Error('KV unavailable'));

    // Should not throw
    await expect(pool.extendLock({ relayerId: 'p1', token: 'tok' })).resolves.toBeUndefined();
  });

  test('LRU ordering: channels acquired longer ago are acquired first', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2', 'p3'] });

    const now = Date.now();
    await kv.set('testnet:channel:lru-map', {
      p1: now,
      p2: now - 10000,
      p3: now - 5000,
    });

    const lock = await pool.acquire(defaultOptions);
    expect(lock.relayerId).toBe('p2');
  });

  test('never-used channels are preferred (missing from LRU map defaults to 0)', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    await kv.set('testnet:channel:lru-map', { p1: Date.now() - 10000 });

    const lock = await pool.acquire(defaultOptions);
    // p2 has no LRU entry (defaults to 0), so it's older than p1 and should be in top-K
    expect(lock.relayerId).toBe('p2');
  });

  test('acquire updates LRU map with acquisition timestamp', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    const before = Date.now();
    const lock = await pool.acquire(defaultOptions);
    const lruMap = await kv.get<Record<string, number>>('testnet:channel:lru-map');
    expect(lruMap).not.toBeNull();
    expect(lruMap![lock.relayerId]).toBeGreaterThanOrEqual(before);
  });

  test('releaseWithCooldown keeps lock key alive with short TTL', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);
    await pool.releaseWithCooldown(lock, 6000);

    // Lock key should still exist (channel blocked during cooldown)
    const exists = await kv.exists(`testnet:channel:in-use:${lock.relayerId}`);
    expect(exists).toBe(true);
  });

  test('releaseWithCooldown is no-op if token does not match', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    const lock = await pool.acquire(defaultOptions);
    const wrongLock = { relayerId: lock.relayerId, token: 'wrong-token' };

    const setSpy = vi.spyOn(kv, 'set');
    await pool.releaseWithCooldown(wrongLock, 6000);

    const cooldownCalls = setSpy.mock.calls.filter((c) => c[0] === `testnet:channel:in-use:${lock.relayerId}`);
    expect(cooldownCalls).toHaveLength(0);
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
    });
  });

  test('concurrent claims: no duplicate relayerId allocation', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2', 'p3'] });

    // Launch 3 concurrent acquires for 3 channels — all should succeed with unique IDs
    const results = await Promise.all([
      pool.acquire(defaultOptions),
      pool.acquire(defaultOptions),
      pool.acquire(defaultOptions),
    ]);

    const relayerIds = results.map((r) => r.relayerId);
    expect(new Set(relayerIds).size).toBe(3);

    // Verify each token matches what's stored in KV
    for (const lock of results) {
      const stored = await kv.get<{ token: string }>(`testnet:channel:in-use:${lock.relayerId}`);
      expect(stored?.token).toBe(lock.token);
    }
  });

  test('claim-busy fallback: skips busy claim lock and tries next candidate', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    // Pre-lock the claim key for p1 and p2's in-use key is free
    // Simulate: p1's claim lock is held by another worker
    await kv.set('testnet:channel:claim:p1', { token: 'lock' }, { ttlSec: 3 });

    const lock = await pool.acquire(defaultOptions);
    // p1's claim lock is busy so it should be skipped; p2 should be acquired
    expect(lock.relayerId).toBe('p2');
  });

  test('double-check inside claim: rejects already-claimed channel', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1', 'p2'] });

    // Pre-set p1's in-use key (simulating another worker claimed it after our scan)
    await kv.set(
      'testnet:channel:in-use:p1',
      { token: 'other-worker', lockedAt: new Date().toISOString() },
      { ttlSec: 30 }
    );

    const lock = await pool.acquire(defaultOptions);
    // p1 is already in-use (double-check inside claim rejects it), so p2 is acquired
    expect(lock.relayerId).toBe('p2');
  });

  test('stress: N concurrent acquires against M channels, no duplicates', async () => {
    const numChannels = 20;
    const numWorkers = 100;
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

    // Each returned token matches stored KV
    for (const lock of successes) {
      const stored = await kv.get<{ token: string }>(`testnet:channel:in-use:${lock.relayerId}`);
      expect(stored?.token).toBe(lock.token);
    }

    // All failures are POOL_CAPACITY
    for (const f of failures) {
      expect((f as any).err.code).toBe('POOL_CAPACITY');
    }
  }, 30_000);
});
