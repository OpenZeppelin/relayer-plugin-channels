/**
 * Tests for dynamic timeout computation in submitWithFeeBumpAndWait.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { submitWithFeeBumpAndWait } from '../src/plugin/submit';
import { TIMEOUT, POLLING } from '../src/plugin/constants';
import type { PluginAPI, Relayer, StellarTransactionResponse } from '@openzeppelin/relayer-sdk';

function makeMocks() {
  const fundRelayer = {
    sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', hash: 'hash-1' }),
  } as unknown as Relayer;

  const transactionWait = vi.fn().mockResolvedValue({
    id: 'tx-1',
    status: 'confirmed',
    hash: 'hash-1',
  } as StellarTransactionResponse);

  const api = { transactionWait } as unknown as PluginAPI;

  return { fundRelayer, api, transactionWait };
}

describe('submitWithFeeBumpAndWait dynamic timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses dynamic timeout based on elapsed time', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    // Simulate 5s elapsed
    const startTime = Date.now() - 5_000;

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, startTime);

    expect(transactionWait).toHaveBeenCalledTimes(1);
    const opts = transactionWait.mock.calls[0][1];
    expect(opts.interval).toBe(POLLING.INTERVAL_MS);
    // With 5s elapsed: remaining = 30000 - 2000 - 5000 = 23000, capped at 25000 → 23000
    expect(opts.timeout).toBeLessThanOrEqual(POLLING.TIMEOUT_MS);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThan(POLLING.TIMEOUT_MS);
  });

  test('caps timeout at POLLING.TIMEOUT_MS when plenty of time remains', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    // Simulate 0s elapsed (just started)
    const startTime = Date.now();

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, startTime);

    const opts = transactionWait.mock.calls[0][1];
    // remaining = 30000 - 2000 - ~0 = ~28000, capped at 25000
    expect(opts.timeout).toBe(POLLING.TIMEOUT_MS);
  });

  test('throws immediately when no time remaining', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    // Simulate 29s elapsed (past the budget)
    const startTime = Date.now() - 29_000;

    await expect(submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, startTime)).rejects.toMatchObject({
      code: 'WAIT_TIMEOUT',
    });

    // transactionWait should NOT have been called
    expect(transactionWait).not.toHaveBeenCalled();
  });

  test('throws when elapsed exactly equals budget', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    // Elapsed = GLOBAL - BUFFER = 28s exactly → remaining = 0
    const startTime = Date.now() - (TIMEOUT.GLOBAL_TIMEOUT_MS - TIMEOUT.BUFFER_MS);

    await expect(submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, startTime)).rejects.toMatchObject({
      code: 'WAIT_TIMEOUT',
    });

    expect(transactionWait).not.toHaveBeenCalled();
  });

  test('gives very short timeout when close to deadline', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    // Simulate 27s elapsed → remaining = 30000 - 2000 - 27000 = 1000ms
    const startTime = Date.now() - 27_000;

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, startTime);

    const opts = transactionWait.mock.calls[0][1];
    expect(opts.timeout).toBeLessThanOrEqual(1_000);
    expect(opts.timeout).toBeGreaterThan(0);
  });
});
