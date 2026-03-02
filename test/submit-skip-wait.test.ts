/**
 * Tests for skipWait behaviour in submitWithFeeBumpAndWait.
 * When skipWait is true, transactionWait must not be called and the result
 * should be returned immediately with status 'pending'.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { submitWithFeeBumpAndWait } from '../src/plugin/submit';
import type { PluginAPI, Relayer } from '@openzeppelin/relayer-sdk';

function makeMocks() {
  const fundRelayer = {
    sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', hash: 'hash-1' }),
  } as unknown as Relayer;

  const transactionWait = vi.fn().mockResolvedValue({
    id: 'tx-1',
    status: 'confirmed',
    hash: 'hash-1',
  });

  const api = { transactionWait } as unknown as PluginAPI;

  return { fundRelayer, api, transactionWait };
}

describe('submitWithFeeBumpAndWait skipWait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('skipWait returns pending without calling transactionWait', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    const startTime = Date.now();

    const result = await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      startTime,
      undefined,
      undefined,
      true
    );

    expect(result).toEqual({
      transactionId: 'tx-1',
      status: 'pending',
      hash: 'hash-1',
    });
    expect(transactionWait).not.toHaveBeenCalled();
  });

  test('skipWait returns null hash when sendTransaction has no hash', async () => {
    const fundRelayer = {
      sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-2' }),
    } as unknown as Relayer;
    const transactionWait = vi.fn();
    const api = { transactionWait } as unknown as PluginAPI;

    const result = await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      undefined,
      undefined,
      true
    );

    expect(result).toEqual({
      transactionId: 'tx-2',
      status: 'pending',
      hash: null,
    });
    expect(transactionWait).not.toHaveBeenCalled();
  });

  test('default (no skipWait) still calls transactionWait', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now());

    expect(transactionWait).toHaveBeenCalledTimes(1);
  });

  test('skipWait=false still calls transactionWait', async () => {
    const { fundRelayer, api, transactionWait } = makeMocks();

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now(), undefined, undefined, false);

    expect(transactionWait).toHaveBeenCalledTimes(1);
  });
});
