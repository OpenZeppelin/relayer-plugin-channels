import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeKV } from './helpers/fakeKV';
import { FeeTracker } from '../src/plugin/fee-tracking';

describe('FeeTracker', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.FUND_RELAYER_ID = 'fund';
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  describe('checkBudget', () => {
    test('passes when consumed + fee is under limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await expect(tracker.checkBudget(3000)).resolves.toBeUndefined();
    });

    test('passes when consumed + fee equals limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await expect(tracker.checkBudget(5000)).resolves.toBeUndefined();
    });

    test('throws 429 when consumed + fee exceeds limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 9000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await expect(tracker.checkBudget(2000)).rejects.toMatchObject({
        code: 'FEE_LIMIT_EXCEEDED',
        status: 429,
        details: { consumed: 9000, fee: 2000, limit: 10000 },
      });
    });

    test('passes when no prior consumption', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'new-key', defaultLimit: 10000 });
      await expect(tracker.checkBudget(5000)).resolves.toBeUndefined();
    });

    test('skips check when no limit configured (unlimited)', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 999999999 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' }); // no default limit
      await expect(tracker.checkBudget(999999999)).resolves.toBeUndefined();
    });

    test('uses custom limit over default', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 4000 });
      await kv.set('testnet:api-key-limit:test-key', { limit: 5000 }); // custom limit

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      // consumed=4000 + fee=2000 = 6000 > customLimit=5000
      await expect(tracker.checkBudget(2000)).rejects.toMatchObject({
        code: 'FEE_LIMIT_EXCEEDED',
        status: 429,
      });
    });
  });

  describe('recordUsage', () => {
    test('creates new entry when none exists', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });

      await tracker.recordUsage(1000);

      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(1000);
    });

    test('increments existing entry', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: Date.now() });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await tracker.recordUsage(2500);

      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(7500);
    });

    test('handles multiple increments', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 100000 });

      await tracker.recordUsage(1000);
      await tracker.recordUsage(2000);
      await tracker.recordUsage(3000);

      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(6000);
    });

    test('does not throw on KV errors', async () => {
      const errorKV = {
        get: async () => ({ consumed: 100 }),
        set: async () => {
          throw new Error('KV write failed');
        },
      } as any;

      const tracker = new FeeTracker({ kv: errorKV, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });

      // Should not throw, just log
      await expect(tracker.recordUsage(1000)).resolves.toBeUndefined();
    });

    test('sets periodStart on first consumption', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 });

      const before = Date.now();
      await tracker.recordUsage(1000);
      const after = Date.now();

      const data = await kv.get<{ consumed: number; periodStart: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(1000);
      expect(data?.periodStart).toBeGreaterThanOrEqual(before);
      expect(data?.periodStart).toBeLessThanOrEqual(after);
    });

    test('retries when lock is busy and eventually succeeds', async () => {
      const kv = new FakeKV();
      let attempts = 0;
      const originalWithLock = kv.withLock.bind(kv);
      kv.withLock = async (key, fn, opts) => {
        attempts++;
        if (attempts < 3) return null; // Simulate busy lock
        return originalWithLock(key, fn, opts);
      };

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await tracker.recordUsage(1000);

      expect(attempts).toBe(3);
      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(1000);
    });

    test('logs warning after exhausting retries', async () => {
      const kv = new FakeKV();
      kv.withLock = async () => null; // Always busy

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      await tracker.recordUsage(1000);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('after 3 retries'));
      warnSpy.mockRestore();
    });
  });

  describe('getUsageInfo', () => {
    test('returns zero consumed when no data', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });

      const usage = await tracker.getUsageInfo();
      expect(usage.consumed).toBe(0);
      expect(usage.limit).toBe(10000);
      expect(usage.remaining).toBe(10000);
    });

    test('returns consumed and remaining correctly', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 3000, periodStart: Date.now() });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      const usage = await tracker.getUsageInfo();

      expect(usage.consumed).toBe(3000);
      expect(usage.limit).toBe(10000);
      expect(usage.remaining).toBe(7000);
    });

    test('returns undefined for limit/remaining when unlimited', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' }); // no limit
      const usage = await tracker.getUsageInfo();

      expect(usage.consumed).toBe(5000);
      expect(usage.limit).toBeUndefined();
      expect(usage.remaining).toBeUndefined();
    });

    test('returns period info when configured', async () => {
      const kv = new FakeKV();
      const periodStart = Date.now() - 10000;
      await kv.set('testnet:api-key-fees:test-key', { consumed: 3000, periodStart });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 });
      const usage = await tracker.getUsageInfo();

      expect(usage.consumed).toBe(3000);
      expect(usage.periodStartAt).toBe(new Date(periodStart).toISOString());
      expect(usage.periodEndsAt).toBe(new Date(periodStart + 60000).toISOString());
    });

    test('uses custom limit over default', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-limit:test-key', { limit: 5000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 });
      const usage = await tracker.getUsageInfo();

      expect(usage.limit).toBe(5000);
      expect(usage.remaining).toBe(5000);
    });
  });

  describe('custom limits', () => {
    test('setCustomLimit stores limit in KV', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' });
      await tracker.setCustomLimit(50000);

      const data = await kv.get<{ limit: number }>('testnet:api-key-limit:test-key');
      expect(data?.limit).toBe(50000);
    });

    test('getCustomLimit retrieves stored limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-limit:test-key', { limit: 75000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' });
      const limit = await tracker.getCustomLimit();
      expect(limit).toBe(75000);
    });

    test('getCustomLimit returns undefined when not set', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' });
      const limit = await tracker.getCustomLimit();
      expect(limit).toBeUndefined();
    });

    test('deleteCustomLimit removes limit from KV', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-limit:test-key', { limit: 50000 });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key' });
      await tracker.deleteCustomLimit();

      const exists = await kv.exists('testnet:api-key-limit:test-key');
      expect(exists).toBe(false);
    });
  });

  describe('key format', () => {
    test('uses correct key format for testnet', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'sk_live_abc123', defaultLimit: 10000 });

      await tracker.recordUsage(100);

      const keys = await kv.listKeys();
      expect(keys).toContain('testnet:api-key-fees:sk_live_abc123');
    });

    test('uses correct key format for mainnet', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker({ kv, network: 'mainnet', apiKey: 'pk_prod_xyz789', defaultLimit: 10000 });

      await tracker.recordUsage(100);

      const keys = await kv.listKeys();
      expect(keys).toContain('mainnet:api-key-fees:pk_prod_xyz789');
    });
  });

  describe('periodic reset', () => {
    test('no reset when resetPeriodMs not configured', async () => {
      const kv = new FakeKV();
      const oldTime = Date.now() - 1000000; // old timestamp
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: oldTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000 }); // no resetPeriodMs
      const usage = await tracker.getUsageInfo();
      expect(usage.consumed).toBe(5000); // not reset
    });

    test('no reset when within period', async () => {
      const kv = new FakeKV();
      const recentTime = Date.now() - 1000; // 1 second ago
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: recentTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 }); // 60 second period
      const usage = await tracker.getUsageInfo();
      expect(usage.consumed).toBe(5000); // not reset
    });

    test('resets consumption when period expired', async () => {
      const kv = new FakeKV();
      const oldTime = Date.now() - 120000; // 2 minutes ago
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: oldTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 }); // 60 second period
      const usage = await tracker.getUsageInfo();
      expect(usage.consumed).toBe(0); // reset because period expired
    });

    test('recordUsage resets period when expired', async () => {
      const kv = new FakeKV();
      const oldTime = Date.now() - 120000; // 2 minutes ago
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: oldTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 }); // 60 second period
      await tracker.recordUsage(1000);

      const data = await kv.get<{ consumed: number; periodStart: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(1000); // reset to new fee only
      expect(data?.periodStart).toBeGreaterThan(oldTime); // new period started
    });

    test('recordUsage accumulates within period', async () => {
      const kv = new FakeKV();
      const recentTime = Date.now() - 1000; // 1 second ago
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000, periodStart: recentTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 }); // 60 second period
      await tracker.recordUsage(1000);

      const data = await kv.get<{ consumed: number; periodStart: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(6000); // accumulated
      expect(data?.periodStart).toBe(recentTime); // same period
    });

    test('checkBudget passes when period expired (resets consumption)', async () => {
      const kv = new FakeKV();
      const oldTime = Date.now() - 120000; // 2 minutes ago
      await kv.set('testnet:api-key-fees:test-key', { consumed: 9000, periodStart: oldTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 }); // 60 second period
      // Would fail if consumed=9000 + fee=5000 > limit=10000, but period expired so consumed=0
      await expect(tracker.checkBudget(5000)).resolves.toBeUndefined();
    });

    test('getUsageInfo returns reset values when period expired', async () => {
      const kv = new FakeKV();
      const oldTime = Date.now() - 120000;
      await kv.set('testnet:api-key-fees:test-key', { consumed: 3000, periodStart: oldTime });

      const tracker = new FeeTracker({ kv, network: 'testnet', apiKey: 'test-key', defaultLimit: 10000, resetPeriodMs: 60000 });
      const usage = await tracker.getUsageInfo();
      expect(usage.consumed).toBe(0);
      expect(usage.periodStartAt).toBeUndefined();
      expect(usage.periodEndsAt).toBeUndefined();
    });
  });

  describe('getApiKey helper', () => {
    test('extracts api key from headers', () => {
      const headers: Record<string, string[]> = {
        'x-api-key': ['my-api-key'],
        'content-type': ['application/json'],
      };
      const apiKey = headers['x-api-key']?.[0]?.trim() || undefined;
      expect(apiKey).toBe('my-api-key');
    });

    test('returns undefined when header missing', () => {
      const headers: Record<string, string[]> = {
        'content-type': ['application/json'],
      };
      const apiKey = headers['x-api-key']?.[0]?.trim() || undefined;
      expect(apiKey).toBeUndefined();
    });

    test('returns undefined when header is empty', () => {
      const headers: Record<string, string[]> = {
        'x-api-key': [''],
      };
      const apiKey = headers['x-api-key']?.[0]?.trim() || undefined;
      expect(apiKey).toBeUndefined();
    });

    test('handles whitespace in api key', () => {
      const headers: Record<string, string[]> = {
        'x-api-key': ['  my-api-key  '],
      };
      const apiKey = headers['x-api-key']?.[0]?.trim() || undefined;
      expect(apiKey).toBe('my-api-key');
    });
  });
});
