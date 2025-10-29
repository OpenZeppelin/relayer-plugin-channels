import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { loadConfig, getNetworkPassphrase, getLockTtlSeconds, getMaxFee } from '../config';

const env = process.env;

describe('config', () => {
  beforeEach(() => {
    process.env = { ...env };
  });
  afterEach(() => {
    process.env = env;
  });

  test('loadConfig reads required env', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.SOROBAN_RPC_URL = 'http://localhost:9999';
    process.env.FUND_RELAYER_ID = 'fund-relayer';
    const cfg = loadConfig();
    expect(cfg.network).toBe('testnet');
    expect(cfg.rpcUrl).toBe('http://localhost:9999');
    expect(cfg.fundRelayerId).toBe('fund-relayer');
  });

  test('network passphrase', () => {
    expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
  });

  test('lock ttl bounds', () => {
    delete process.env.LOCK_TTL_SECONDS;
    expect(getLockTtlSeconds()).toBe(30);
    process.env.LOCK_TTL_SECONDS = '5';
    expect(getLockTtlSeconds()).toBe(30);
    process.env.LOCK_TTL_SECONDS = '10';
    expect(getLockTtlSeconds()).toBe(10);
    process.env.LOCK_TTL_SECONDS = '29';
    expect(getLockTtlSeconds()).toBe(29);
  });

  test('max fee env', () => {
    delete process.env.MAX_FEE;
    expect(typeof getMaxFee()).toBe('number');
    process.env.MAX_FEE = '12345';
    expect(getMaxFee()).toBe(12345);
  });
});
