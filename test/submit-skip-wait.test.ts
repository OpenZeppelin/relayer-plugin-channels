/**
 * Tests for skipWait behaviour in submitWithFeeBumpAndWait.
 * When skipWait is true, transactionWait must not be called and the result
 * should be returned immediately with status 'pending'.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  isSendRejected,
  isTransactionNotFound,
  onchainFailedError,
  sendFeeBump,
  submitWithFeeBumpAndWait,
} from '../src/plugin/submit';
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

  test('skipWait records fee usage when tracker is provided', async () => {
    const { fundRelayer, api } = makeMocks();
    const tracker = { checkBudget: vi.fn(), recordUsage: vi.fn() };

    await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      tracker as any,
      undefined,
      true
    );

    expect(tracker.recordUsage).toHaveBeenCalledWith(1000);
  });
});

describe('submitWithFeeBumpAndWait onSubmitted', () => {
  test.each([
    ['skipWait', true],
    ['waiting', false],
  ])('reports the created transaction before returning (%s)', async (_name, skipWait) => {
    const { fundRelayer, api, transactionWait } = makeMocks();
    const onSubmitted = vi.fn().mockResolvedValue(undefined);

    await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      undefined,
      { onSubmitted },
      skipWait
    );

    expect(onSubmitted).toHaveBeenCalledWith('tx-1');
    if (!skipWait) {
      expect(onSubmitted.mock.invocationCallOrder[0]).toBeLessThan(transactionWait.mock.invocationCallOrder[0]);
    }
  });

  test('is not called when the fund relayer rejects the transaction', async () => {
    const fundRelayer = {
      sendTransaction: vi.fn().mockRejectedValue(new Error('rejected')),
    } as unknown as Relayer;
    const onSubmitted = vi.fn();

    await expect(
      submitWithFeeBumpAndWait(
        fundRelayer,
        'xdr',
        'testnet',
        1000,
        {} as PluginAPI,
        Date.now(),
        undefined,
        { onSubmitted },
        true
      )
    ).rejects.toThrow('rejected');
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

describe('submitWithFeeBumpAndWait beforeSubmit', () => {
  test('receives the exact payload before it is sent', async () => {
    const { fundRelayer, api } = makeMocks();
    const beforeSubmit = vi.fn().mockResolvedValue(undefined);

    await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      undefined,
      { beforeSubmit },
      true
    );

    const payload = { network: 'testnet', transaction_xdr: 'xdr', fee_bump: true, max_fee: 1000 };
    expect(beforeSubmit).toHaveBeenCalledWith(payload);
    expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(payload);
    expect(beforeSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      (fundRelayer.sendTransaction as any).mock.invocationCallOrder[0]
    );
  });

  test('does not send when beforeSubmit rejects', async () => {
    const { fundRelayer, api } = makeMocks();
    const beforeSubmit = vi.fn().mockRejectedValue(new Error('kv down'));

    await expect(
      submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now(), undefined, { beforeSubmit }, true)
    ).rejects.toThrow('kv down');
    expect(fundRelayer.sendTransaction).not.toHaveBeenCalled();
  });

  test('passes the fund relayer idempotency key when given', async () => {
    const { fundRelayer, api } = makeMocks();

    await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      undefined,
      { fundRelayerIdempotencyKey: 'channels-idempotency:abc' },
      true
    );

    expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'channels-idempotency:abc',
    });
  });
});

describe('sendFeeBump', () => {
  test('sends without options when no key is given', async () => {
    const { fundRelayer } = makeMocks();
    const payload = { network: 'testnet' as const, transaction_xdr: 'xdr', fee_bump: true as const, max_fee: 1 };

    await sendFeeBump(fundRelayer, payload);

    expect((fundRelayer.sendTransaction as any).mock.calls[0]).toEqual([payload]);
  });
});

describe('sendFeeBump under a fund relayer key', () => {
  const payload = { network: 'testnet', transaction_xdr: 'XDR', fee_bump: true, max_fee: 1000 } as const;

  test('sends once with the key; an error is not retried, since it does not show what the Relayer stored', async () => {
    const sendTransaction = vi.fn().mockRejectedValue(new Error('Relayer error: Relayer is paused'));

    await expect(sendFeeBump({ sendTransaction } as unknown as Relayer, payload, 'k')).rejects.toThrow('paused');

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction).toHaveBeenCalledWith(payload, { idempotencyKey: 'k' });
  });
});

describe('isTransactionNotFound', () => {
  test.each([
    ['Relayer error: Entity not found: Transaction with ID tx-1 not found', true],
    ['Relayer error: Relayer is paused', false],
    ['Socket closed by server', false],
  ])('%s -> %s', (message, expected) => {
    expect(isTransactionNotFound(new Error(message))).toBe(expected);
  });
});

describe('a failed transaction without a hash', () => {
  test('is reported as on-chain unless the Relayer could not queue it (it clears the hash on a bad-sequence reset)', async () => {
    const fundRelayer = {
      sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', status: 'pending', hash: null }),
    } as unknown as Relayer;
    const api = {
      transactionWait: vi.fn().mockResolvedValue({
        id: 'tx-1',
        status: 'failed',
        status_reason: 'Transaction stuck in Pending status for too long',
      }),
    } as unknown as PluginAPI;
    const tracker = { recordUsage: vi.fn().mockResolvedValue(undefined), recordUsageOnce: vi.fn() };

    await expect(
      submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now(), tracker as any, {}, false)
    ).rejects.toMatchObject({ code: 'ONCHAIN_FAILED' });
    expect(tracker.recordUsage).toHaveBeenCalledWith(1000);
  });

  test('is reported as not submitted and not charged when the Relayer could not queue it', async () => {
    const fundRelayer = {
      sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', status: 'pending', hash: null }),
    } as unknown as Relayer;
    const api = {
      transactionWait: vi.fn().mockResolvedValue({ id: 'tx-1', status: 'failed', status_reason: 'Queue unavailable' }),
    } as unknown as PluginAPI;
    const tracker = { recordUsage: vi.fn(), recordUsageOnce: vi.fn() };

    await expect(
      submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now(), tracker as any, {}, false)
    ).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_SUBMITTED',
      details: { id: 'tx-1', reason: 'Queue unavailable' },
    });
    expect(tracker.recordUsage).not.toHaveBeenCalled();
  });
});

describe('submitWithFeeBumpAndWait fee marker', () => {
  test('records the fee once under the marker key when one is set', async () => {
    const { fundRelayer, api } = makeMocks();
    const tracker = { recordUsage: vi.fn(), recordUsageOnce: vi.fn().mockResolvedValue(undefined) };

    await submitWithFeeBumpAndWait(
      fundRelayer,
      'xdr',
      'testnet',
      1000,
      api,
      Date.now(),
      tracker as any,
      { feeMarkerKey: 'testnet:idempotency:abc:fee' },
      true
    );

    expect(tracker.recordUsageOnce).toHaveBeenCalledWith(1000, 'testnet:idempotency:abc:fee', 3_600);
    expect(tracker.recordUsage).not.toHaveBeenCalled();
  });

  test('records the fee as before without a marker key', async () => {
    const { fundRelayer, api } = makeMocks();
    const tracker = { recordUsage: vi.fn().mockResolvedValue(undefined), recordUsageOnce: vi.fn() };

    await submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', 1000, api, Date.now(), tracker as any, {}, false);

    expect(tracker.recordUsage).toHaveBeenCalledWith(1000);
    expect(tracker.recordUsageOnce).not.toHaveBeenCalled();
  });
});

describe('isSendRejected', () => {
  test.each([
    ['Relayer error: Insufficient balance', true],
    ['Relayer error: Relayer is paused', true],
    ['Relayer error: A request with this Idempotency-Key is already in progress', false],
    [
      'Relayer error: No transaction found for this Idempotency-Key. It may have completed and been removed from storage.',
      false,
    ],
    ["Socket request 'sendTransaction' timed out after 30000ms", false],
    ['Socket closed by server', false],
    ['unexpected', false],
  ])('%s -> %s', (message, rejected) => {
    expect(isSendRejected(new Error(message))).toBe(rejected);
  });
});

describe('submitWithFeeBumpAndWait onSendRejected', () => {
  test.each([
    ['a rejection', 'Relayer error: Relayer is paused', 1],
    ['an unknown outcome', 'Socket closed by server', 0],
  ])('is called for %s only', async (_name, message, calls) => {
    const fundRelayer = {
      sendTransaction: vi.fn().mockRejectedValue(new Error(message)),
    } as unknown as Relayer;
    const onSendRejected = vi.fn().mockResolvedValue(undefined);

    await expect(
      submitWithFeeBumpAndWait(
        fundRelayer,
        'xdr',
        'testnet',
        1000,
        {} as PluginAPI,
        Date.now(),
        undefined,
        { onSendRejected },
        true
      )
    ).rejects.toThrow(message);
    expect(onSendRejected).toHaveBeenCalledTimes(calls);
  });
});

describe('onchainFailedError', () => {
  test('builds the ONCHAIN_FAILED error with the decoded result code', () => {
    const error = onchainFailedError(
      { id: 'tx-1', status: 'failed' as any, hash: 'abc', status_reason: 'Specific XDR reason: txFailed' },
      'testnet'
    );
    expect(error).toMatchObject({
      code: 'ONCHAIN_FAILED',
      status: 400,
      details: expect.objectContaining({ id: 'tx-1', hash: 'abc', resultCode: 'txFailed' }),
    });
  });
});
