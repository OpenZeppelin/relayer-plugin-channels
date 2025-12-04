import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { loadConfig, getNetworkPassphrase } from '../src/plugin/config';

const env = process.env;

describe('config', () => {
  beforeEach(() => {
    process.env = { ...env };
    // Set required env vars for loadConfig
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.FUND_RELAYER_ID = 'fund-relayer';
  });
  afterEach(() => {
    process.env = env;
  });

  test('loadConfig reads required env', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.FUND_RELAYER_ID = 'fund-relayer';
    const cfg = loadConfig();
    expect(cfg.network).toBe('testnet');
    expect(cfg.fundRelayerId).toBe('fund-relayer');
  });

  test('network passphrase', () => {
    expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
  });

  test('lock ttl bounds', () => {
    delete process.env.LOCK_TTL_SECONDS;
    expect(loadConfig().lockTtlSeconds).toBe(30);
    process.env.LOCK_TTL_SECONDS = '2';
    expect(loadConfig().lockTtlSeconds).toBe(30);
    process.env.LOCK_TTL_SECONDS = '10';
    expect(loadConfig().lockTtlSeconds).toBe(10);
    process.env.LOCK_TTL_SECONDS = '29';
    expect(loadConfig().lockTtlSeconds).toBe(29);
  });

  test('fee limit env', () => {
    delete process.env.FEE_LIMIT;
    expect(loadConfig().feeLimit).toBeUndefined();
    process.env.FEE_LIMIT = '100000';
    expect(loadConfig().feeLimit).toBe(100000);
    process.env.FEE_LIMIT = '-100';
    expect(loadConfig().feeLimit).toBeUndefined();
    process.env.FEE_LIMIT = 'invalid';
    expect(loadConfig().feeLimit).toBeUndefined();
    process.env.FEE_LIMIT = '50000.7';
    expect(loadConfig().feeLimit).toBe(50000); // floors to integer
  });

  test('api key header', () => {
    delete process.env.API_KEY_HEADER;
    expect(loadConfig().apiKeyHeader).toBe('x-api-key');
    process.env.API_KEY_HEADER = 'X-Custom-Key';
    expect(loadConfig().apiKeyHeader).toBe('x-custom-key'); // lowercased
    process.env.API_KEY_HEADER = '';
    expect(loadConfig().apiKeyHeader).toBe('x-api-key');
  });

  test('admin secret', () => {
    delete process.env.PLUGIN_ADMIN_SECRET;
    expect(loadConfig().adminSecret).toBeUndefined();
    process.env.PLUGIN_ADMIN_SECRET = 'my-secret';
    expect(loadConfig().adminSecret).toBe('my-secret');
    process.env.PLUGIN_ADMIN_SECRET = '  trimmed  ';
    expect(loadConfig().adminSecret).toBe('trimmed');
  });
});
