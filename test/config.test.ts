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

  test('limited contracts validation', () => {
    const validContract = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    delete process.env.LIMITED_CONTRACTS;
    expect(loadConfig().limitedContracts.size).toBe(0);

    process.env.LIMITED_CONTRACTS = validContract;
    expect(loadConfig().limitedContracts).toEqual(new Set([validContract]));

    // Multiple contracts
    process.env.LIMITED_CONTRACTS = `${validContract}, ${validContract}`;
    expect(loadConfig().limitedContracts.size).toBe(1); // deduplicated

    // Lowercase is uppercased
    process.env.LIMITED_CONTRACTS = validContract.toLowerCase();
    expect(loadConfig().limitedContracts.has(validContract)).toBe(true);

    // Invalid contract throws
    process.env.LIMITED_CONTRACTS = 'invalid-contract';
    expect(() => loadConfig()).toThrow('Invalid contract address');

    // Mixed valid/invalid throws
    process.env.LIMITED_CONTRACTS = `${validContract},invalid`;
    expect(() => loadConfig()).toThrow('Invalid contract address');
  });

  test('contract capacity ratio', () => {
    delete process.env.CONTRACT_CAPACITY_RATIO;
    expect(loadConfig().contractCapacityRatio).toBe(0.8); // default

    process.env.CONTRACT_CAPACITY_RATIO = '0.5';
    expect(loadConfig().contractCapacityRatio).toBe(0.5);

    // Allow 0 (blocks limited contracts entirely)
    process.env.CONTRACT_CAPACITY_RATIO = '0';
    expect(loadConfig().contractCapacityRatio).toBe(0);

    // Allow 1 (no restriction)
    process.env.CONTRACT_CAPACITY_RATIO = '1';
    expect(loadConfig().contractCapacityRatio).toBe(1);

    // Invalid values fall back to default
    process.env.CONTRACT_CAPACITY_RATIO = '-0.1';
    expect(loadConfig().contractCapacityRatio).toBe(0.8);

    process.env.CONTRACT_CAPACITY_RATIO = '1.1';
    expect(loadConfig().contractCapacityRatio).toBe(0.8);

    process.env.CONTRACT_CAPACITY_RATIO = 'invalid';
    expect(loadConfig().contractCapacityRatio).toBe(0.8);
  });
});
