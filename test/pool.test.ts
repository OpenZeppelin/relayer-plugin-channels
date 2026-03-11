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

    const cooldownCalls = setSpy.mock.calls.filter(
      (c) => c[0] === `testnet:channel:in-use:${lock.relayerId}`
    );
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
});
