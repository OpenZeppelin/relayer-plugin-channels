/**
 * Tests for how submitWithFeeBumpAndWait reports the final state of a
 * transaction and what it debits from the API key's fee budget.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PluginAPI, Relayer } from '@openzeppelin/relayer-sdk';
import { submitWithFeeBumpAndWait } from '../src/plugin/submit';
import { FeeTracker } from '../src/plugin/fee-tracking';
import { FakeKV } from './helpers/fakeKV';

const MAX_FEE = 1_000_000;
const HASH = 'a'.repeat(64);

describe('submitWithFeeBumpAndWait outcomes', () => {
  let tracker: FeeTracker;

  beforeEach(() => {
    tracker = new FeeTracker({ kv: new FakeKV(), network: 'testnet', apiKey: 'key-1' });
  });

  /** Submits a transaction whose wait resolves with `final` (or rejects when `final` is an Error). */
  function submit(final: Record<string, unknown> | Error, startTime = Date.now()) {
    const fundRelayer = {
      sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', hash: null }),
    } as unknown as Relayer;
    const transactionWait =
      final instanceof Error ? vi.fn().mockRejectedValue(final) : vi.fn().mockResolvedValue({ id: 'tx-1', ...final });
    const api = { transactionWait } as unknown as PluginAPI;
    return submitWithFeeBumpAndWait(fundRelayer, 'xdr', 'testnet', MAX_FEE, api, startTime, tracker);
  }

  async function consumed(): Promise<number> {
    return (await tracker.getUsageInfo()).consumed;
  }

  describe('confirmed', () => {
    test('debits the fee the Relayer reports as charged, not maxFee', async () => {
      const result = await submit({ status: 'confirmed', hash: HASH, fee: 83_000 });

      expect(result).toEqual({ transactionId: 'tx-1', status: 'confirmed', hash: HASH });
      expect(await consumed()).toBe(83_000);
    });

    test.each([
      ['no fee', {}],
      ['a zero fee', { fee: 0 }],
      ['a fee that is not a number', { fee: '83000' }],
    ])('debits maxFee when the Relayer reports %s', async (_name, fields) => {
      await submit({ status: 'confirmed', hash: HASH, ...fields });

      expect(await consumed()).toBe(MAX_FEE);
    });

    test('debits maxFee for a state that is not confirmed, whose fee is still the bid', async () => {
      await submit({ status: 'canceled', hash: HASH, fee: 83_000 });

      expect(await consumed()).toBe(MAX_FEE);
    });
  });

  describe('failed on chain', () => {
    const reason =
      'Transaction failed on-chain. reason=TxFeeBumpInnerFailed inner=TxFailed op=Trapped contract_error=Contract(7) message="bad: input"';

    test('is reported as ONCHAIN_FAILED with the result code and the full reason', async () => {
      await expect(submit({ status: 'failed', hash: HASH, status_reason: reason })).rejects.toMatchObject({
        code: 'ONCHAIN_FAILED',
        status: 400,
        details: {
          status: 'failed',
          id: 'tx-1',
          hash: HASH,
          resultCode: 'TxFeeBumpInnerFailed:TxFailed',
          reason,
        },
      });
    });

    test('debits maxFee, since the Relayer does not report the fee charged for a failure', async () => {
      await expect(submit({ status: 'failed', hash: HASH, status_reason: reason })).rejects.toThrow();

      expect(await consumed()).toBe(MAX_FEE);
    });

    // Not proven to have missed the ledger, so these keep the previous code and debit
    test.each([
      ['has a hash but no on-chain reason', { hash: HASH, status_reason: 'Transaction stuck in Submitted status' }],
      [
        'was sent but the RPC gave no answer',
        { status_reason: 'Submission failed: Underlying provider error: Request timeout' },
      ],
      [
        'the network rejected on a resubmission after accepting it',
        {
          hash: HASH,
          status_reason: 'Submission failed: Unexpected error: Transaction submission error: TxFeeBumpInnerFailed',
        },
      ],
      ['has no reason', {}],
    ])('a failure that %s stays ONCHAIN_FAILED and is debited', async (_name, fields) => {
      await expect(submit({ status: 'failed', ...fields })).rejects.toMatchObject({ code: 'ONCHAIN_FAILED' });
      expect(await consumed()).toBe(MAX_FEE);
    });
  });

  describe('failed before reaching a ledger', () => {
    const rejected = {
      status: 'failed',
      status_reason: 'Submission failed: Unexpected error: Transaction submission error: TxFeeBumpInnerFailed',
    };

    test('a network rejection is reported as TRANSACTION_REJECTED, not ONCHAIN_FAILED', async () => {
      await expect(submit(rejected)).rejects.toMatchObject({
        code: 'TRANSACTION_REJECTED',
        status: 400,
        details: {
          status: 'failed',
          id: 'tx-1',
          hash: null,
          resultCode: 'TxFeeBumpInnerFailed',
          reason: 'TxFeeBumpInnerFailed',
        },
      });
    });

    test('a network rejection is not debited', async () => {
      await expect(submit(rejected)).rejects.toThrow();

      expect(await consumed()).toBe(0);
    });

    test('a preparation failure keeps the Relayer message', async () => {
      const prepFailed = {
        status: 'failed',
        status_reason:
          'Preparation failed: Transaction validation error: max_fee (100203) is insufficient. Required fee-bump fee: 20000000',
      };

      await expect(submit(prepFailed)).rejects.toMatchObject({
        code: 'TRANSACTION_REJECTED',
        message: 'max_fee (100203) is insufficient. Required fee-bump fee: 20000000',
      });
      expect(await consumed()).toBe(0);
    });
  });

  describe('expired', () => {
    const expired = { status: 'expired', status_reason: 'Transaction time_bounds expired' };

    test('is reported as TRANSACTION_EXPIRED instead of a successful response', async () => {
      await expect(submit({ ...expired, hash: HASH })).rejects.toMatchObject({
        code: 'TRANSACTION_EXPIRED',
        status: 400,
        details: { status: 'expired', id: 'tx-1', hash: HASH },
      });
    });

    test('is not debited when the network never accepted it', async () => {
      await expect(submit(expired)).rejects.toMatchObject({ code: 'TRANSACTION_EXPIRED', details: { hash: null } });

      expect(await consumed()).toBe(0);
    });

    // The Relayer expires by the clock, so an accepted transaction may have landed just before
    test('debits maxFee when the network had accepted it', async () => {
      await expect(submit({ ...expired, hash: HASH })).rejects.toThrow();

      expect(await consumed()).toBe(MAX_FEE);
    });
  });

  describe('wait timeout', () => {
    test('debits maxFee when the wait times out, since the transaction may still land', async () => {
      await expect(submit(new Error('Transaction wait timed out'))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });

      expect(await consumed()).toBe(MAX_FEE);
    });

    test('debits maxFee when no time is left to wait after the send', async () => {
      const startTime = Date.now() - 29_000;

      await expect(submit({ status: 'confirmed' }, startTime)).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });

      expect(await consumed()).toBe(MAX_FEE);
    });
  });
});
