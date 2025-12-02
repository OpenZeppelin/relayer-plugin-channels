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
});
