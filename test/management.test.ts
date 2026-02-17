import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { handleManagement, isManagementRequest } from '../src/plugin/management';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { FakeKV } from './helpers/fakeKV';

describe('management', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.PLUGIN_ADMIN_SECRET = 'test';
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.FUND_RELAYER_ID = 'fund';
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  test('isManagementRequest detects shape', () => {
    expect(isManagementRequest({ management: {} })).toBe(true);
    expect(isManagementRequest({})).toBe(false);
  });

  test('list and set channel accounts', async () => {
    const kv = new FakeKV();
    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'listChannelAccounts' } },
    } as any as PluginContext;
    const list1 = await handleManagement(ctx);
    expect(Array.isArray(list1.relayerIds)).toBe(true);

    const ctxSet = {
      kv,
      params: { management: { adminSecret: 'test', action: 'setChannelAccounts', relayerIds: ['A', 'B'] } },
    } as any as PluginContext;
    const set = await handleManagement(ctxSet);
    expect(set.ok).toBe(true);
    expect(set.appliedRelayerIds).toEqual(['a', 'b']);

    const list2 = await handleManagement(ctx);
    expect(list2.relayerIds).toEqual(['a', 'b']);
  });

  test('locked conflict on removal', async () => {
    const kv = new FakeKV();
    // Seed list
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['a', 'b'] });
    // Simulate lock on 'b'
    await kv.set('testnet:channel:in-use:b', { token: 't' });
    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'setChannelAccounts', relayerIds: ['a'] } },
    } as any as PluginContext;
    await expect(handleManagement(ctx)).rejects.toThrow('Locked relayer IDs cannot be removed');
  });

  test('getFeeUsage returns consumption', async () => {
    const kv = new FakeKV();
    await kv.set('testnet:api-key-fees:my-api-key', { consumed: 5000 });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeUsage', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.consumed).toBe(5000);
  });

  test('getFeeUsage returns 0 for unknown key', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeUsage', apiKey: 'unknown-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.consumed).toBe(0);
  });

  test('getFeeUsage requires apiKey', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeUsage' } },
    } as any as PluginContext;

    await expect(handleManagement(ctx)).rejects.toThrow('Invalid payload: apiKey is required');
  });

  test('getFeeUsage returns limit and remaining when configured', async () => {
    process.env.FEE_LIMIT = '10000';
    const kv = new FakeKV();
    await kv.set('testnet:api-key-fees:my-api-key', { consumed: 3000 });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeUsage', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.consumed).toBe(3000);
    expect(result.limit).toBe(10000);
    expect(result.remaining).toBe(7000);
  });

  test('getFeeUsage uses custom limit over default', async () => {
    process.env.FEE_LIMIT = '10000';
    const kv = new FakeKV();
    await kv.set('testnet:api-key-fees:my-api-key', { consumed: 3000 });
    await kv.set('testnet:api-key-limit:my-api-key', { limit: 5000 });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeUsage', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.limit).toBe(5000);
    expect(result.remaining).toBe(2000);
  });

  test('getFeeLimit returns custom limit when set', async () => {
    process.env.FEE_LIMIT = '10000';
    const kv = new FakeKV();
    await kv.set('testnet:api-key-limit:my-api-key', { limit: 5000 });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeLimit', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.limit).toBe(5000);
  });

  test('getFeeLimit returns default when no custom limit', async () => {
    process.env.FEE_LIMIT = '10000';
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'getFeeLimit', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.limit).toBe(10000);
  });

  test('setFeeLimit stores custom limit', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'setFeeLimit', apiKey: 'my-api-key', limit: 50000 } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.ok).toBe(true);
    expect(result.limit).toBe(50000);

    const stored = await kv.get<{ limit: number }>('testnet:api-key-limit:my-api-key');
    expect(stored?.limit).toBe(50000);
  });

  test('setFeeLimit rejects negative limit', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'setFeeLimit', apiKey: 'my-api-key', limit: -100 } },
    } as any as PluginContext;

    await expect(handleManagement(ctx)).rejects.toThrow('limit must be a non-negative number');
  });

  test('setFeeLimit requires apiKey', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'setFeeLimit', limit: 50000 } },
    } as any as PluginContext;

    await expect(handleManagement(ctx)).rejects.toThrow('Invalid payload: apiKey is required');
  });

  test('deleteFeeLimit removes custom limit', async () => {
    const kv = new FakeKV();
    await kv.set('testnet:api-key-limit:my-api-key', { limit: 50000 });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'deleteFeeLimit', apiKey: 'my-api-key' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.ok).toBe(true);

    const exists = await kv.exists('testnet:api-key-limit:my-api-key');
    expect(exists).toBe(false);
  });

  test('deleteFeeLimit requires apiKey', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'deleteFeeLimit' } },
    } as any as PluginContext;

    await expect(handleManagement(ctx)).rejects.toThrow('Invalid payload: apiKey is required');
  });

  test('stats returns pool size and lock counts', async () => {
    const kv = new FakeKV();
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['a', 'b', 'c'] });
    // Lock one channel
    await kv.set('testnet:channel:in-use:b', { token: 't' });

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'stats' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.pool).toEqual({ size: 3, locked: 1, available: 2 });
  });

  test('stats returns empty pool when no relayer IDs', async () => {
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'stats' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.pool).toEqual({ size: 0, locked: 0, available: 0 });
  });

  test('stats returns undefined locked/available on lock check failure', async () => {
    const kv = new FakeKV();
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['a', 'b'] });
    // Make exists throw
    const origExists = kv.exists.bind(kv);
    kv.exists = () => {
      throw new Error('KV unavailable');
    };

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'stats' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.pool.size).toBe(2);
    expect(result.pool.locked).toBeUndefined();
    expect(result.pool.available).toBeUndefined();

    kv.exists = origExists;
  });

  test('stats includes config and fees', async () => {
    process.env.FEE_LIMIT = '10000';
    process.env.FEE_RESET_PERIOD_SECONDS = '3600';
    const kv = new FakeKV();

    const ctx = {
      kv,
      params: { management: { adminSecret: 'test', action: 'stats' } },
    } as any as PluginContext;

    const result = await handleManagement(ctx);
    expect(result.config.network).toBe('testnet');
    expect(result.config.lockTtlSeconds).toBeTypeOf('number');
    expect(result.config.feeLimit).toBe(10000);
    expect(result.config.feeResetPeriodSeconds).toBe(3600);
    expect(result.config.contractCapacityRatio).toBeTypeOf('number');
    expect(Array.isArray(result.config.limitedContracts)).toBe(true);
    expect(result.fees.inclusionFeeDefault).toBeTypeOf('number');
    expect(result.fees.inclusionFeeLimited).toBeTypeOf('number');
  });
});
