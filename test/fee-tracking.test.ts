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

  describe('checkLimit', () => {
    test('passes when under limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000 });

      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 10000);
      await expect(tracker.checkLimit()).resolves.toBeUndefined();
    });

    test('throws 429 when at limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 10000 });

      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 10000);
      await expect(tracker.checkLimit()).rejects.toMatchObject({
        code: 'FEE_LIMIT_EXCEEDED',
        status: 429,
      });
    });

    test('throws 429 when over limit', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 15000 });

      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 10000);
      await expect(tracker.checkLimit()).rejects.toMatchObject({
        code: 'FEE_LIMIT_EXCEEDED',
        status: 429,
        details: { consumed: 15000, limit: 10000 },
      });
    });

    test('passes when no prior consumption', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker(kv, 'testnet', 'new-key', 10000);
      await expect(tracker.checkLimit()).resolves.toBeUndefined();
    });
  });

  describe('trackConsumed', () => {
    test('creates new entry when none exists', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 10000);

      await tracker.trackConsumed(1000);

      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(1000);
    });

    test('increments existing entry', async () => {
      const kv = new FakeKV();
      await kv.set('testnet:api-key-fees:test-key', { consumed: 5000 });

      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 10000);
      await tracker.trackConsumed(2500);

      const data = await kv.get<{ consumed: number }>('testnet:api-key-fees:test-key');
      expect(data?.consumed).toBe(7500);
    });

    test('handles multiple increments', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker(kv, 'testnet', 'test-key', 100000);

      await tracker.trackConsumed(1000);
      await tracker.trackConsumed(2000);
      await tracker.trackConsumed(3000);

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

      const tracker = new FeeTracker(errorKV, 'testnet', 'test-key', 10000);

      // Should not throw, just log
      await expect(tracker.trackConsumed(1000)).resolves.toBeUndefined();
    });
  });

  describe('key format', () => {
    test('uses correct key format for testnet', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker(kv, 'testnet', 'sk_live_abc123', 10000);

      await tracker.trackConsumed(100);

      const keys = await kv.listKeys();
      expect(keys).toContain('testnet:api-key-fees:sk_live_abc123');
    });

    test('uses correct key format for mainnet', async () => {
      const kv = new FakeKV();
      const tracker = new FeeTracker(kv, 'mainnet', 'pk_prod_xyz789', 10000);

      await tracker.trackConsumed(100);

      const keys = await kv.listKeys();
      expect(keys).toContain('mainnet:api-key-fees:pk_prod_xyz789');
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
