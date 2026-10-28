/**
 * Tests for Idempotency-Key handling in the handler.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext, PluginAPI } from '@openzeppelin/relayer-sdk';
import { FakeKV } from './helpers/fakeKV';

// Mock config with mutable override
let configOverride: Record<string, any> = {};
const baseConfig = {
  fundRelayerId: 'fund-1',
  allowedFundRelayerIds: new Set<string>(),
  network: 'testnet',
  lockTtlSeconds: 30,
  apiKeyHeader: 'x-api-key',
  limitedContracts: new Set<string>(),
  contractCapacityRatio: 0.8,
  inclusionFeeDefault: 203,
  inclusionFeeLimited: 201,
  sequenceNumberCacheMaxAgeMs: 120_000,
  minSignatureExpirationLedgerBuffer: 20,
  maxTimeBoundOffsetSeconds: 60,
  globalTimeoutMs: 30_000,
  pollingTimeoutMs: 25_000,
  idempotencyKeyTtlSeconds: 3_600,
};
vi.mock('../src/plugin/config', () => ({
  loadConfig: () => ({ ...baseConfig, ...configOverride }),
  getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
}));

// Mock management
vi.mock('../src/plugin/management', () => ({
  isManagementRequest: vi.fn().mockReturnValue(false),
  handleManagement: vi.fn(),
}));

// Mock validation, controlled via mockValidateResult
let mockValidateResult: any = {
  type: 'xdr' as const,
  xdr: 'SIGNED_XDR',
  skipWait: false,
  fundRelayerId: undefined,
};
vi.mock('../src/plugin/validation', () => ({
  validateAndParseRequest: vi.fn().mockImplementation(() => ({ ...mockValidateResult })),
}));

// Mock pool
const poolSpies = {
  acquire: vi.fn().mockResolvedValue({ relayerId: 'channel-1', token: 'tok' }),
  release: vi.fn().mockResolvedValue(undefined),
  extendLock: vi.fn().mockResolvedValue(undefined),
  renewLock: vi.fn().mockResolvedValue(true),
};
vi.mock('../src/plugin/pool', () => {
  class MockChannelPool {
    acquire = poolSpies.acquire;
    release = poolSpies.release;
    extendLock = poolSpies.extendLock;
    renewLock = poolSpies.renewLock;
  }
  return { ChannelPool: MockChannelPool };
});

// Mock submit
vi.mock('../src/plugin/submit', async (importOriginal) => ({
  // Real classification and error building
  isSendRejected: ((await importOriginal()) as any).isSendRejected,
  onchainFailedError: ((await importOriginal()) as any).onchainFailedError,
  // Real send and error classification
  sendFeeBump: ((await importOriginal()) as any).sendFeeBump,
  isTransactionNotFound: ((await importOriginal()) as any).isTransactionNotFound,
  notSubmittedError: ((await importOriginal()) as any).notSubmittedError,
  isNotSubmitted: ((await importOriginal()) as any).isNotSubmitted,
  RELAYER_IN_PROGRESS_MESSAGE: ((await importOriginal()) as any).RELAYER_IN_PROGRESS_MESSAGE,
  RELAYER_TRANSACTION_GONE_MESSAGE: ((await importOriginal()) as any).RELAYER_TRANSACTION_GONE_MESSAGE,
  RELAYER_PAYLOAD_MISMATCH_MESSAGE: ((await importOriginal()) as any).RELAYER_PAYLOAD_MISMATCH_MESSAGE,
  signWithChannelAndFund: vi.fn(),
  submitWithFeeBumpAndWait: vi.fn().mockResolvedValue({
    transactionId: 'tx-abc',
    status: 'confirmed',
    hash: 'hash-abc',
  }),
}));

// Mock tx validation: returns an object with toXdr
vi.mock('../src/plugin/tx', () => ({
  validateExistingTransactionForSubmitOnly: vi.fn().mockImplementation(() => ({
    fee: '100',
    timeBounds: { minTime: '0', maxTime: '9999999999' },
    toXdr: () => 'MOCK_XDR',
    toEnvelope: () => ({ v1: () => ({ tx: () => ({ operations: () => [] }) }) }),
  })),
}));

// Mock fee
vi.mock('../src/plugin/fee', () => ({
  calculateMaxFee: vi.fn().mockReturnValue(1000),
  getContractIdFromFunc: vi.fn(),
  getContractIdFromTransaction: vi.fn(),
}));

// Mock fee-stats
const mockFetchDynamicInclusionFee = vi.fn().mockResolvedValue(500);
vi.mock('../src/plugin/fee-stats', () => ({
  fetchDynamicInclusionFee: (...args: any[]) => mockFetchDynamicInclusionFee(...args),
}));

// Mock simulation
vi.mock('../src/plugin/simulation', () => ({
  simulateTransaction: vi.fn(),
  buildWithChannel: vi.fn(),
}));

// Mock sequence
vi.mock('../src/plugin/sequence', () => ({
  getSequence: vi.fn(),
  commitSequence: vi.fn(),
  clearSequence: vi.fn(),
}));

// Mock fee-tracking
vi.mock('../src/plugin/fee-tracking', () => ({
  FeeTracker: vi.fn().mockImplementation(() => ({
    checkBudget: vi.fn(),
  })),
}));

// Mock Transaction as a class constructor
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  class MockTransaction {
    signatures: any[];
    operations: any[];
    fee = '100';
    constructor(xdr: string) {
      this.signatures = xdr === 'UNSIGNED_XDR' ? [] : [{ hint: () => Buffer.from('hint') }];
      this.operations = [{ type: 'invokeHostFunction' }];
    }
    toXdr() {
      return 'MOCK_XDR';
    }
    toEnvelope() {
      return {
        type: 'envelopeTypeTx',
        v1: {
          tx: {
            operations: [
              {
                body: {
                  type: 'invokeHostFunction',
                  invokeHostFunctionOp: {
                    hostFunction: { type: 'hostFunctionTypeInvokeContract' },
                    auth: [],
                  },
                },
              },
            ],
          },
        },
      };
    }
  }
  return {
    ...actual,
    Transaction: MockTransaction,
  };
});

import { handler, clearRelayerInfoCache } from '../src/plugin/handler';
import { submitWithFeeBumpAndWait, signWithChannelAndFund } from '../src/plugin/submit';
import { validateExistingTransactionForSubmitOnly } from '../src/plugin/tx';
import { simulateTransaction, buildWithChannel } from '../src/plugin/simulation';
import { calculateMaxFee } from '../src/plugin/fee';
import { FeeTracker } from '../src/plugin/fee-tracking';

describe('idempotent submission', () => {
  let kv: FakeKV;
  let useRelayerMock: ReturnType<typeof vi.fn>;

  let fundRelayer: any;

  function makeContext(headers: Record<string, string[]> = {}, pluginConfig?: Record<string, any>): PluginContext {
    fundRelayer = {
      getRelayer: vi.fn().mockResolvedValue({
        address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        network_type: 'stellar',
      }),
      getTransaction: vi.fn().mockResolvedValue({
        id: 'tx-123',
        status: 'confirmed',
        hash: 'hash-123',
      }),
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: { sorobanInclusionFee: { p50: '500' } },
      }),
    };

    useRelayerMock = vi.fn().mockReturnValue(fundRelayer);

    const api = {
      useRelayer: useRelayerMock,
    } as unknown as PluginAPI;

    return {
      api,
      kv: kv as any,
      params: { xdr: 'SIGNED_XDR' },
      headers,
      config: pluginConfig,
    } as unknown as PluginContext;
  }

  beforeEach(() => {
    kv = new FakeKV();
    configOverride = {};
    mockValidateResult = {
      type: 'xdr' as const,
      xdr: 'SIGNED_XDR',
      skipWait: false,
      fundRelayerId: undefined,
    };
    mockFetchDynamicInclusionFee.mockResolvedValue(500);
    clearRelayerInfoCache();
    vi.clearAllMocks();
    (simulateTransaction as any).mockResolvedValue({
      isReadOnly: false,
      rawSimResult: { id: '1', results: [{ auth: ['a'], xdr: 'AAAA' }] },
    });
    (buildWithChannel as any).mockReturnValue({
      fee: '100',
      toXdr: () => 'BUILT_XDR',
      signatures: [{ hint: () => Buffer.alloc(4) }],
      operations: [{ type: 'invokeHostFunction' }],
    });
    (signWithChannelAndFund as any).mockImplementation(async (tx: any) => tx);
  });

  // A key needs a caller scope; Authorization stands in when there is no API key
  const KEY = { 'idempotency-key': ['settle-key-1'], authorization: ['Bearer caller-token'] };

  /** Moves the clock past the window in which a lost send's reply may still arrive. */
  function pastSendWindow() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Moves the clock forward by ms. */
  function advanceClock(ms: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ms);
  }

  /** A real signed transaction that expires at maxTime (seconds), wrapped in a fee bump payload. */
  async function payloadExpiringAt(maxTime: number) {
    const sdk = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
    const source = sdk.Keypair.random();
    const tx = new sdk.TransactionBuilder(new sdk.Account(source.publicKey(), '41'), {
      fee: '100',
      networkPassphrase: sdk.Networks.TESTNET,
      timebounds: { minTime: 0, maxTime },
    })
      .addOperation(sdk.Operation.bumpSequence({ bumpTo: '50' }))
      .build();
    return {
      payload: { ...PAYLOAD, transaction_xdr: tx.toXDR() },
      transaction: {
        innerHash: Buffer.from(tx.hash()).toString('hex'),
        source: source.publicKey(),
        sequence: '42',
        maxTime,
      },
    };
  }

  const PAYLOAD = { network: 'testnet', transaction_xdr: 'FEE_BUMP_XDR', fee_bump: true, max_fee: 1000 };

  /** Submit mock that stores the payload and creates a transaction, like the real one. */
  function submitCreates(transactionId: string) {
    (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
      const [, , , maxFee, , , tracker, submitContext] = args;
      await submitContext?.beforeSubmit?.(PAYLOAD);
      await submitContext?.onSubmitted?.(transactionId);
      // Fee recording, as in the real submit
      if (tracker) {
        if (submitContext?.feeMarkerKey)
          await tracker.recordUsageOnce(maxFee, submitContext.feeMarkerKey(transactionId));
        else await tracker.recordUsage(maxFee);
      }
      return { transactionId, status: 'confirmed', hash: `hash-${transactionId}` };
    });
  }

  /** Submit mock where the send starts but its reply is lost. */
  function submitLosesReply(payload: any = PAYLOAD) {
    (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
      await args[7]?.beforeSubmit?.(payload);
      throw new Error("Socket request 'sendTransaction' timed out after 30000ms");
    });
  }

  test('without the header, every request submits', async () => {
    submitCreates('tx-1');
    await handler(makeContext());
    await handler(makeContext());

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(2);
  });

  test('a repeated request returns the transaction the first one created', async () => {
    submitCreates('tx-1');
    const first = await handler(makeContext(KEY));
    const repeatContext = makeContext(KEY);
    fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });

    const second = await handler(repeatContext);

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    expect(fundRelayer.getTransaction).toHaveBeenCalledWith({ transactionId: 'tx-1' });
    expect(first).toEqual({ transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
    expect(second).toEqual({ transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
  });

  test('records the transaction even when waiting for it fails', async () => {
    (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
      await args[7]?.beforeSubmit?.(PAYLOAD);
      await args[7]?.onSubmitted?.('tx-1');
      throw Object.assign(new Error('Transaction wait timeout. It may still submit.'), { code: 'WAIT_TIMEOUT' });
    });
    await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
    const repeatContext = makeContext(KEY);
    fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'submitted', hash: 'hash-tx-1' });

    const repeat = await handler(repeatContext);

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    expect(repeat).toEqual({ transactionId: 'tx-1', status: 'submitted', hash: 'hash-tx-1' });
  });

  test('releases the key when the request fails before creating a transaction', async () => {
    (submitWithFeeBumpAndWait as any).mockRejectedValueOnce(new Error('pool capacity'));
    await expect(handler(makeContext(KEY))).rejects.toThrow('pool capacity');

    submitCreates('tx-2');
    const retry = await handler(makeContext(KEY));

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(2);
    expect(retry).toMatchObject({ transactionId: 'tx-2' });
  });

  test('a lost send reply keeps the key and the retry resends the identical transaction', async () => {
    submitLosesReply();
    await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

    // Within the send window the reply may still arrive, so a repeat waits
    await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });

    pastSendWindow();
    const repeatContext = makeContext(KEY);
    fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', hash: null });
    const repeat = await handler(repeatContext);

    // Not rebuilt: the stored payload is resent with the fund relayer key
    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(PAYLOAD, {
      idempotencyKey: expect.stringMatching(/^channels-idempotency:[0-9a-f]{64}$/),
    });
    expect(repeat).toEqual({ transactionId: 'tx-1', status: 'pending', hash: null });

    // The resend recorded the id, so a further repeat returns it directly
    const thirdContext = makeContext(KEY);
    fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
    expect(await handler(thirdContext)).toEqual({ transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
  });

  test('a failed transaction id write still resends instead of rebuilding', async () => {
    submitCreates('tx-1');
    const set = kv.set.bind(kv);
    vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
      if (value?.transactionId) throw new Error('kv down');
      return set(key, value, opts);
    });
    await handler(makeContext(KEY));
    vi.mocked(kv.set).mockRestore();

    pastSendWindow();
    const repeatContext = makeContext(KEY);
    fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', hash: 'hash-tx-1' });
    const repeat = await handler(repeatContext);

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(PAYLOAD, expect.any(Object));
    expect(repeat).toMatchObject({ transactionId: 'tx-1' });
  });

  test('passes the fund relayer idempotency key to the submission', async () => {
    submitCreates('tx-1');
    await handler(makeContext(KEY));

    const submitContext = (submitWithFeeBumpAndWait as any).mock.calls[0][7];
    expect(submitContext.fundRelayerIdempotencyKey).toMatch(/^channels-idempotency:[0-9a-f]{64}$/);
  });

  describe('channel lock on the func+auth path', () => {
    beforeEach(() => {
      mockValidateResult = {
        type: 'func-auth',
        func: { toXdr: () => 'FUNC_XDR' },
        auth: [],
        skipWait: false,
        fundRelayerId: undefined,
      };
    });

    test('renews the channel lock through the transaction expiry before sending', async () => {
      const order: string[] = [];
      poolSpies.renewLock.mockImplementationOnce(async () => {
        order.push('renew');
        return true;
      });
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        order.push('send');
        return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
      });

      await handler(makeContext());

      expect(order).toEqual(['renew', 'send']);
      // maxTimeBoundOffsetSeconds (60s) plus cooldown, well past the 30s lock TTL
      const [, ttlSec] = poolSpies.renewLock.mock.calls[0];
      expect(ttlSec).toBeGreaterThan(60);
    });

    test('never renews the channel lock for less than the lock TTL, which covers the wait', async () => {
      // Short time bounds: expiry plus cooldown (about 16s) is below the 30s lock TTL
      configOverride = { maxTimeBoundOffsetSeconds: 10 };
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
      });

      await handler(makeContext());

      const [, ttlSec] = poolSpies.renewLock.mock.calls[0];
      expect(ttlSec).toBe(30);
    });

    test('does not send when the channel lock was already lost', async () => {
      poolSpies.renewLock.mockResolvedValueOnce(false);
      const sent = vi.fn();
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        sent();
        return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
      });

      await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'CHANNEL_LOCK_LOST', status: 503 });
      expect(sent).not.toHaveBeenCalled();
      // Nothing was sent, so the key is free for a new attempt
      expect(await kv.listKeys('testnet:idempotency:*')).toEqual([]);
    });

    test('keeps the channel locked when the send started but its reply was lost', async () => {
      submitLosesReply();
      await expect(handler(makeContext())).rejects.toThrow('timed out');

      expect(poolSpies.renewLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.release).not.toHaveBeenCalled();
    });

    test('keeps the channel locked when bookkeeping fails after the send was accepted', async () => {
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        await args[7]?.onSubmitted?.('tx-1');
        throw new Error('kv down');
      });

      await expect(handler(makeContext())).rejects.toThrow('kv down');

      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.release).not.toHaveBeenCalled();
    });

    test('releases the channel when the request failed before sending', async () => {
      (submitWithFeeBumpAndWait as any).mockRejectedValueOnce(new Error('fee limit exceeded'));
      await expect(handler(makeContext())).rejects.toThrow('fee limit exceeded');

      expect(poolSpies.extendLock).not.toHaveBeenCalled();
      expect(poolSpies.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('fee accounting', () => {
    const API_KEY = { ...KEY, 'x-api-key': ['caller-a'] };
    let recordUsage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      recordUsage = vi.fn().mockResolvedValue(undefined);
      // Once-per-marker recording, as the real FeeTracker does (tested there)
      const recorded = new Set<string>();
      const recordUsageOnce = vi.fn(async (fee: number, markerKey: string) => {
        if (recorded.has(markerKey)) return;
        recorded.add(markerKey);
        await recordUsage(fee);
      });
      (FeeTracker as any).mockImplementation(function () {
        return { checkBudget: vi.fn(), recordUsage, recordUsageOnce };
      });
    });

    test('charges a recovered send once', async () => {
      submitLosesReply();
      await expect(handler(makeContext(API_KEY))).rejects.toThrow('timed out');
      expect(recordUsage).not.toHaveBeenCalled();

      pastSendWindow();
      const retry = makeContext(API_KEY);
      fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: null });
      await handler(retry);

      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith(PAYLOAD.max_fee);
    });

    test('a repeat does not charge a transaction that is not final', async () => {
      // Neither the first request (its wait failed) nor a repeat charges a
      // transaction still pending or expired, as for a request without a key
      (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        await args[7]?.onSubmitted?.('tx-1');
        throw Object.assign(new Error('Transaction wait timeout. It may still submit.'), { code: 'WAIT_TIMEOUT' });
      });
      await expect(handler(makeContext(API_KEY))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });

      for (const status of ['submitted', 'expired']) {
        const repeat = makeContext(API_KEY);
        fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status, hash: 'hash-tx-1' });
        await handler(repeat);
      }
      expect(recordUsage).not.toHaveBeenCalled();

      const final = makeContext(API_KEY);
      fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
      await handler(final);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    test('does not charge again when the original send was already charged', async () => {
      submitCreates('tx-1');
      // The id write fails, so the retry resends; the original charged the fee
      const set = kv.set.bind(kv);
      vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
        if (value?.transactionId) throw new Error('kv down');
        return set(key, value, opts);
      });
      await handler(makeContext(API_KEY));
      vi.mocked(kv.set).mockRestore();
      expect(recordUsage).toHaveBeenCalledTimes(1);

      pastSendWindow();
      const retry = makeContext(API_KEY);
      fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', hash: null });
      await handler(retry);

      expect(fundRelayer.sendTransaction).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    test('charges a recorded transaction whose first request ended before charging', async () => {
      // The send is accepted and recorded, then the wait fails before any charge
      (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        await args[7]?.onSubmitted?.('tx-1');
        throw Object.assign(new Error('Transaction wait timeout. It may still submit.'), { code: 'WAIT_TIMEOUT' });
      });
      await expect(handler(makeContext(API_KEY))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      expect(recordUsage).not.toHaveBeenCalled();

      const repeat = makeContext(API_KEY);
      fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
      await handler(repeat);
      await handler(makeContext(API_KEY));

      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith(PAYLOAD.max_fee);
    });

    test('does not charge a recorded transaction twice', async () => {
      submitCreates('tx-1');
      await handler(makeContext(API_KEY));
      expect(recordUsage).toHaveBeenCalledTimes(1);

      await handler(makeContext(API_KEY));

      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    test('a later reservation of the same key is charged again', async () => {
      // The first transaction is recorded and charged by a late repeat
      (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        await args[7]?.onSubmitted?.('tx-1');
        throw Object.assign(new Error('Transaction wait timeout. It may still submit.'), { code: 'WAIT_TIMEOUT' });
      });
      await expect(handler(makeContext(API_KEY))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      await handler(makeContext(API_KEY));
      expect(recordUsage).toHaveBeenCalledTimes(1);

      // The record expires while its fee marker remains; the key is reserved anew
      const [recordKey] = (await kv.listKeys('testnet:idempotency:*')).filter((k) => !k.endsWith(':fee'));
      await kv.del(recordKey);
      advanceClock(1_000);
      submitCreates('tx-2');
      await handler(makeContext(API_KEY));

      expect(recordUsage).toHaveBeenCalledTimes(2);
    });

    test('a recovered transaction is never charged again while its record exists (real fee tracker and KV expiry)', async () => {
      // Reviewer's case: the id write fails but the fee is recorded; a later
      // repeat recovers the id. The marker must outlive every later record write.
      const actual = await vi.importActual<typeof import('../src/plugin/fee-tracking')>('../src/plugin/fee-tracking');
      (FeeTracker as any).mockImplementation(function (config: any) {
        return new actual.FeeTracker(config);
      });
      configOverride = { idempotencyKeyTtlSeconds: 300 };
      const consumed = async () =>
        ((await kv.get<{ consumed: number }>('testnet:api-key-fees:caller-a')) ?? { consumed: 0 }).consumed;

      (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
        const [, , , maxFee, , , tracker, submitContext] = args;
        await submitContext.beforeSubmit(PAYLOAD);
        await submitContext.onSubmitted('tx-1');
        await tracker.recordUsageOnce(maxFee, submitContext.feeMarkerKey('tx-1'), submitContext.feeMarkerTtlSec());
        return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
      });
      const set = kv.set.bind(kv);
      const failIdWrite = vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
        if (value?.transactionId) throw new Error('kv down');
        return set(key, value, opts);
      });
      await handler(makeContext(API_KEY));
      failIdWrite.mockRestore();
      expect(await consumed()).toBe(1000);

      // Recovery at 40s rewrites the record
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      vi.setSystemTime(start + 40_000);
      const recovery = makeContext(API_KEY);
      fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
      await handler(recovery);
      expect(await consumed()).toBe(1000);

      // Whenever the record still exists, a repeat finds the marker too
      for (const at of [299_000, 310_000, 340_000]) {
        vi.setSystemTime(start + at);
        const [recordKey] = (await kv.listKeys('testnet:idempotency:*')).filter((k) => !k.endsWith(':fee'));
        if (!recordKey) continue;
        const repeat = makeContext(API_KEY);
        fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
        await handler(repeat);
        expect(await consumed()).toBe(1000);
      }

      // The record kept its fixed expiry: gone at 310s, not extended to 340s by the recovery
      vi.setSystemTime(start + 310_000);
      expect((await kv.listKeys('testnet:idempotency:*')).filter((k) => !k.endsWith(':fee'))).toEqual([]);
    });

    test('concurrent recoveries charge once', async () => {
      submitLosesReply();
      await expect(handler(makeContext(API_KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      const retries = [makeContext(API_KEY), makeContext(API_KEY)];
      for (const ctx of retries) {
        (ctx.api.useRelayer as any)().sendTransaction = vi
          .fn()
          .mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: null });
      }
      const results = await Promise.allSettled(retries.map((ctx) => handler(ctx)));

      // A retry racing the other's reservation gets 409; any that resend charge once
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
        }
      }
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });
  });

  test('a resend reports the status the fund relayer returned', async () => {
    submitLosesReply();
    await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

    pastSendWindow();
    const resend = makeContext(KEY);
    fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });

    expect(await handler(resend)).toEqual({ transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' });
  });

  test('a resend that returns a failed transaction reports ONCHAIN_FAILED', async () => {
    submitLosesReply();
    await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

    pastSendWindow();
    const resend = makeContext(KEY);
    fundRelayer.sendTransaction = vi.fn().mockResolvedValue({
      id: 'tx-1',
      status: 'failed',
      hash: 'hash-tx-1',
      status_reason: 'Specific XDR reason: txFailed',
    });

    await expect(handler(resend)).rejects.toMatchObject({
      code: 'ONCHAIN_FAILED',
      details: expect.objectContaining({ id: 'tx-1', resultCode: 'txFailed' }),
    });
    // The id is recorded, so later repeats take the existing-transaction path
    const [recordKey] = await kv.listKeys('testnet:idempotency:*');
    expect(await kv.get(recordKey)).toMatchObject({ transactionId: 'tx-1' });
  });

  test('requires a caller scope: a key without an API key or Authorization header is rejected', async () => {
    await expect(handler(makeContext({ 'idempotency-key': ['settle-key-1'] }))).rejects.toMatchObject({
      code: 'API_KEY_REQUIRED',
      status: 400,
    });
    expect(submitWithFeeBumpAndWait).not.toHaveBeenCalled();
    expect(await kv.listKeys('testnet:idempotency:*')).toEqual([]);
  });

  test('callers with different Authorization headers do not share keys', async () => {
    submitCreates('tx-1');
    await handler(makeContext({ ...KEY, authorization: ['Bearer caller-a'] }));
    submitCreates('tx-2');

    const other = await handler(makeContext({ ...KEY, Authorization: ['Bearer caller-b'] }));

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(2);
    expect(other).toMatchObject({ transactionId: 'tx-2' });
  });

  test('rejects a keyed signed XDR without a maxTime before anything is stored', async () => {
    (validateExistingTransactionForSubmitOnly as any).mockImplementationOnce(() => ({
      fee: '100',
      toXdr: () => 'MOCK_XDR',
      toEnvelope: () => ({ v1: () => ({ tx: () => ({ operations: () => [] }) }) }),
    }));

    await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'TIMEBOUNDS_REQUIRED', status: 400 });
    expect(submitWithFeeBumpAndWait).not.toHaveBeenCalled();
    expect(await kv.listKeys('testnet:idempotency:*')).toEqual([]);
  });

  test('a signed XDR without a maxTime is still accepted without a key', async () => {
    (validateExistingTransactionForSubmitOnly as any).mockImplementationOnce(() => ({
      fee: '100',
      toXdr: () => 'MOCK_XDR',
      toEnvelope: () => ({ v1: () => ({ tx: () => ({ operations: () => [] }) }) }),
    }));

    await expect(handler(makeContext())).resolves.toMatchObject({ status: 'confirmed' });
  });

  test('rejects a key reused for a different request', async () => {
    submitCreates('tx-1');
    await handler(makeContext(KEY));
    mockValidateResult = { ...mockValidateResult, xdr: 'OTHER_SIGNED_XDR' };

    await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
  });

  test('rejects a concurrent repeat while the first has no transaction yet', async () => {
    let finish!: () => void;
    (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
      await new Promise<void>((resolve) => (finish = resolve));
      await args[7]?.beforeSubmit?.(PAYLOAD);
      await args[7]?.onSubmitted?.('tx-1');
      return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
    });

    const first = handler(makeContext(KEY));
    await vi.waitFor(() => expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1));
    await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS', status: 409 });

    finish();
    await expect(first).resolves.toMatchObject({ transactionId: 'tx-1' });
  });

  test('keys are scoped to the caller API key', async () => {
    // An API key enables fee tracking, which needs a constructible tracker
    (FeeTracker as any).mockImplementation(function () {
      return { checkBudget: vi.fn(), recordUsage: vi.fn(), recordUsageOnce: vi.fn() };
    });
    submitCreates('tx-1');
    await handler(makeContext({ ...KEY, 'x-api-key': ['caller-a'] }));
    submitCreates('tx-2');

    const other = await handler(makeContext({ ...KEY, 'x-api-key': ['caller-b'] }));

    expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(2);
    expect(other).toMatchObject({ transactionId: 'tx-2' });
  });

  test('rejects an invalid key before any submission work', async () => {
    await expect(handler(makeContext({ 'idempotency-key': ['   '] }))).rejects.toMatchObject({
      code: 'INVALID_IDEMPOTENCY_KEY',
      status: 400,
    });
    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(submitWithFeeBumpAndWait).not.toHaveBeenCalled();
  });

  test('get-transaction ignores even an empty header', async () => {
    mockValidateResult = { type: 'get-transaction', transactionId: 'tx-123' };

    const result = await handler(makeContext({ 'idempotency-key': [''] }));

    expect(result).toEqual({ transactionId: 'tx-123', status: 'confirmed', hash: 'hash-123' });
  });

  describe('rejected sends', () => {
    // A realistic send error: balance and fee checks run later, in Relayer jobs
    const REJECTED = new Error('Relayer error: Relayer is paused');
    const FUNC_AUTH = {
      type: 'func-auth',
      func: { toXdr: () => 'FUNC_XDR' },
      auth: [],
      skipWait: false,
      fundRelayerId: undefined,
    };

    beforeEach(() => {
      mockValidateResult = { ...FUNC_AUTH };
    });

    /** Submit mock whose send the fund relayer answers with an error. */
    function submitRejected(payload: any = PAYLOAD) {
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(payload);
        await args[7]?.onSendRejected?.();
        throw REJECTED;
      });
    }

    test('a rejected send keeps the key and the channel; the next repeat resends the stored payload at once', async () => {
      submitRejected();
      await expect(handler(makeContext(KEY))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_SEND_FAILED',
        status: 503,
        details: { reason: 'Relayer error: Relayer is paused' },
      });

      // The Relayer may have stored the transaction before failing
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });
      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.release).not.toHaveBeenCalled();

      // No send window to wait out: the error was the send's reply
      const repeat = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', status: 'pending', hash: null });
      expect(await handler(repeat)).toEqual({ transactionId: 'tx-1', status: 'pending', hash: null });
      expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(PAYLOAD, {
        idempotencyKey: expect.stringMatching(/^channels-idempotency:[0-9a-f]{64}$/),
      });
      expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    });

    test('unsigned XDR follows the same rule as func+auth', async () => {
      mockValidateResult = { type: 'xdr', xdr: 'UNSIGNED_XDR', skipWait: false, fundRelayerId: undefined };
      submitRejected();
      await expect(handler(makeContext(KEY))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_SEND_FAILED' });

      expect(await kv.listKeys('testnet:idempotency:*')).toHaveLength(1);
      expect(poolSpies.release).not.toHaveBeenCalled();
    });

    test('a resend answered with an error (Relayer paused) keeps the key: 503, retry with the same key', async () => {
      // The original transaction may exist; the paused check runs before the
      // Relayer looks the key up, so the error says nothing about it
      submitLosesReply();
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      const resend = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error('Relayer error: Relayer is paused'));
      await expect(handler(resend)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_SEND_FAILED',
        status: 503,
        details: { reason: 'Relayer error: Relayer is paused' },
      });
      expect(fundRelayer.sendTransaction).toHaveBeenCalledTimes(1);

      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });

      // Once the Relayer is back, the next repeat (no send window to wait out)
      // gets the original transaction
      const again = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'h' });
      expect(await handler(again)).toMatchObject({ transactionId: 'tx-1', status: 'confirmed' });
      expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    });

    test('repeated resend errors keep the key and the stored transaction every time', async () => {
      const { payload, transaction } = await payloadExpiringAt(Math.floor(Date.now() / 1000) + 60);
      submitLosesReply(payload);
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      for (let i = 0; i < 3; i++) {
        const resend = makeContext(KEY);
        fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error('Relayer error: Relayer is paused'));
        await expect(handler(resend)).rejects.toMatchObject({
          code: 'IDEMPOTENCY_KEY_SEND_FAILED',
          details: { innerHash: transaction.innerHash, source: transaction.source },
        });
      }
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload });
      expect(submitWithFeeBumpAndWait).toHaveBeenCalledTimes(1);
    });

    test('once the stored transaction has expired, a resend error reports an unknown outcome to check', async () => {
      const { payload, transaction } = await payloadExpiringAt(Math.floor(Date.now() / 1000) + 5);
      submitLosesReply(payload);
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      // Past maxTime plus the ledger close margin
      advanceClock(60_000);
      const resend = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error('Relayer error: Relayer is paused'));
      await expect(handler(resend)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_OUTCOME_UNKNOWN',
        status: 422,
        details: { reason: 'Relayer error: Relayer is paused', ...transaction },
      });
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload });
    });

    test('a resend the fund relayer is still creating gets 409 and keeps the key', async () => {
      submitLosesReply();
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      const resend = makeContext(KEY);
      fundRelayer.sendTransaction = vi
        .fn()
        .mockRejectedValue(new Error('Relayer error: A request with this Idempotency-Key is already in progress'));
      await expect(handler(resend)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS', status: 409 });

      // Not a rejection, so not confirmed by a second send
      expect(fundRelayer.sendTransaction).toHaveBeenCalledTimes(1);
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });
    });

    test('a resend whose transaction the fund relayer no longer has reports an unknown outcome', async () => {
      const { payload, transaction } = await payloadExpiringAt(Math.floor(Date.now() / 1000) + 60);
      submitLosesReply(payload);
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      const resend = makeContext(KEY);
      const gone =
        'Relayer error: No transaction found for this Idempotency-Key. It may have completed and been removed from storage. Confirm whether the original request was processed before you send it again with a new key';
      fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error(gone));

      await expect(handler(resend)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_OUTCOME_UNKNOWN',
        status: 422,
        details: { reason: gone, ...transaction },
      });
      expect(fundRelayer.sendTransaction).toHaveBeenCalledTimes(1);
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload });
    });

    test('an unknown resend outcome keeps the key', async () => {
      submitLosesReply();
      await expect(handler(makeContext(KEY))).rejects.toThrow('timed out');

      pastSendWindow();
      const resend = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error('Socket closed by server'));
      await expect(handler(resend)).rejects.toThrow('Socket closed');

      expect(await kv.listKeys('testnet:idempotency:*')).toHaveLength(1);
    });

    test('a failed payload store after the payload was written keeps the key', async () => {
      // The write may have landed even though the call threw: never release a stored payload
      const set = kv.set.bind(kv);
      vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
        await set(key, value, opts);
        if (value?.payload) throw new Error('kv reply lost');
      });
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        throw new Error('not reached');
      });

      await expect(handler(makeContext(KEY))).rejects.toThrow('kv reply lost');
      vi.mocked(kv.set).mockRestore();

      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: PAYLOAD });
    });

    test('func+auth: an ambiguous payload write keeps the channel locked as well as the key', async () => {
      const set = kv.set.bind(kv);
      vi.spyOn(kv, 'set').mockImplementation(async (key: string, value: any, opts?: any) => {
        await set(key, value, opts);
        if (value?.payload) throw new Error('kv reply lost');
      });
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(async (...args: any[]) => {
        await args[7]?.beforeSubmit?.(PAYLOAD);
        throw new Error('not reached');
      });

      await expect(handler(makeContext(KEY))).rejects.toThrow('kv reply lost');
      vi.mocked(kv.set).mockRestore();

      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.release).not.toHaveBeenCalled();
    });

    test('through the real submit: a Relayer error on the first send returns SEND_FAILED and keeps the channel', async () => {
      const actual = await vi.importActual<typeof import('../src/plugin/submit')>('../src/plugin/submit');
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(actual.submitWithFeeBumpAndWait);
      const ctx = makeContext(KEY);
      fundRelayer.sendTransaction = vi.fn().mockRejectedValue(new Error('Relayer error: Relayer is paused'));

      await expect(handler(ctx)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_SEND_FAILED',
        status: 503,
        details: { reason: 'Relayer error: Relayer is paused' },
      });
      expect(fundRelayer.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ fee_bump: true }), {
        idempotencyKey: expect.stringMatching(/^channels-idempotency:/),
      });
      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      expect(poolSpies.release).not.toHaveBeenCalled();
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ sentAt: 0 });
    });

    test('through the real submit: a lost reply keeps the key and the channel and returns the raw error', async () => {
      const actual = await vi.importActual<typeof import('../src/plugin/submit')>('../src/plugin/submit');
      (submitWithFeeBumpAndWait as any).mockImplementationOnce(actual.submitWithFeeBumpAndWait);
      const ctx = makeContext(KEY);
      fundRelayer.sendTransaction = vi
        .fn()
        .mockRejectedValue(new Error("Socket request 'sendTransaction' timed out after 30000ms"));

      await expect(handler(ctx)).rejects.toThrow('timed out');
      expect(poolSpies.extendLock).toHaveBeenCalledTimes(1);
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: expect.objectContaining({ fee_bump: true }) });
    });

    test('releases the func+auth channel on a rejection without a key too', async () => {
      submitRejected();
      // Without a key the Relayer's error is returned as is
      await expect(handler(makeContext())).rejects.toThrow('Relayer is paused');

      expect(poolSpies.extendLock).not.toHaveBeenCalled();
      expect(poolSpies.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('fund relayer key fence', () => {
    const RELAYER_TTL_MS = 86_400_000;
    const PLUGIN_TTL_MS = 3_600_000;

    /**
     * A fund relayer with Relayer 1.9 idempotency: an atomic key reservation
     * kept for its TTL from the first send, a replay for the same body, and
     * 422 for a different one. Counts the transactions it creates.
     */
    function idempotentFundRelayer() {
      const keys = new Map<string, { body: string; id: string; expiresAt: number }>();
      const created: string[] = [];
      const sendTransaction = vi.fn(async (payload: any, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey;
        const body = JSON.stringify(payload);
        const held = key ? keys.get(key) : undefined;
        if (held && held.expiresAt > Date.now()) {
          if (held.body !== body) {
            throw new Error('Relayer error: Idempotency-Key reused with a different request payload');
          }
          return { id: held.id, status: 'pending', hash: null };
        }
        const id = `tx-${created.length + 1}`;
        created.push(id);
        if (key) keys.set(key, { body, id, expiresAt: Date.now() + RELAYER_TTL_MS });
        return { id, status: 'pending', hash: null };
      });
      return { sendTransaction, created };
    }

    /** Runs the real submit, without waiting, so every send reaches the fake fund relayer. */
    async function useRealSubmit() {
      const actual = await vi.importActual<typeof import('../src/plugin/submit')>('../src/plugin/submit');
      (submitWithFeeBumpAndWait as any).mockImplementation(actual.submitWithFeeBumpAndWait);
    }

    /** Each build gets a new body, as a rebuilt transaction does (new channel or sequence). */
    function eachBuildDiffers() {
      let builds = 0;
      (buildWithChannel as any).mockImplementation(() => {
        const xdr = `BUILT_XDR_${++builds}`;
        return {
          fee: '100',
          toXdr: () => xdr,
          signatures: [{ hint: () => Buffer.alloc(4) }],
          operations: [{ type: 'invokeHostFunction' }],
        };
      });
    }

    function contextWith(relayer: ReturnType<typeof idempotentFundRelayer>) {
      const ctx = makeContext(KEY);
      fundRelayer.sendTransaction = relayer.sendTransaction;
      return ctx;
    }

    // Implementations set here outlive vi.clearAllMocks, so put the defaults back
    let defaultValidation: any;
    let defaultTracker: any;

    beforeEach(async () => {
      defaultValidation = (validateExistingTransactionForSubmitOnly as any).getMockImplementation();
      defaultTracker = (FeeTracker as any).getMockImplementation();
      mockValidateResult = {
        type: 'func-auth',
        func: { toXdr: () => 'FUNC_XDR' },
        auth: [],
        skipWait: true,
        fundRelayerId: undefined,
      };
      eachBuildDiffers();
      await useRealSubmit();
    });

    afterEach(() => {
      (validateExistingTransactionForSubmitOnly as any).mockImplementation(defaultValidation);
      (FeeTracker as any).mockImplementation(defaultTracker);
    });

    test('a reservation that lands after its lock expired cannot execute a second transaction', async () => {
      const relayer = idempotentFundRelayer();
      // Request A's reservation write passes the lease check, then stalls past
      // the lock's TTL and lands after request B has finished
      let releaseStalledWrite!: () => void;
      const stalled = new Promise<void>((resolve) => (releaseStalledWrite = resolve));
      let reachedStall!: () => void;
      const atStall = new Promise<void>((resolve) => (reachedStall = resolve));
      const set = kv.set.bind(kv);
      let stalls = 1;
      vi.spyOn(kv, 'set').mockImplementation(async (key, value, opts) => {
        if (stalls > 0 && key.startsWith('testnet:idempotency:') && !key.endsWith(':lock')) {
          stalls--;
          reachedStall();
          await stalled;
        }
        return set(key, value, opts);
      });

      const first = handler(contextWith(relayer));
      await atStall;
      advanceClock(6_000);
      const second = await handler(contextWith(relayer));
      expect(second).toMatchObject({ transactionId: 'tx-1', status: 'pending' });

      // A's stale write now overwrites B's recorded transaction, and A sends a
      // transaction of its own under the key
      releaseStalledWrite();
      const conflict = await first.catch((error) => error);
      expect(conflict).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 422 });
      // Only the refused transaction is known here, so no transaction details
      expect(conflict.details).toEqual({
        reason: 'Relayer error: Idempotency-Key reused with a different request payload',
      });
      expect(relayer.sendTransaction).toHaveBeenCalledTimes(2);
      expect(relayer.created).toEqual(['tx-1']);
    });

    test('a key reused just before the plugin record expires returns the original transaction', async () => {
      const relayer = idempotentFundRelayer();
      await handler(contextWith(relayer));

      advanceClock(PLUGIN_TTL_MS - 60_000);
      const repeat = contextWith(relayer);
      fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'h' });
      await expect(handler(repeat)).resolves.toMatchObject({ transactionId: 'tx-1' });
      expect(fundRelayer.getTransaction).toHaveBeenCalledWith({ transactionId: 'tx-1' });
      expect(relayer.created).toEqual(['tx-1']);
    });

    test('a key reused after the plugin record expires, while the fund relayer holds it, gets a conflict', async () => {
      const relayer = idempotentFundRelayer();
      await handler(contextWith(relayer));

      advanceClock(PLUGIN_TTL_MS + 60_000);
      await expect(handler(contextWith(relayer))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(relayer.created).toEqual(['tx-1']);

      // The answer was the send's reply, so the next repeat gets it at once
      await expect(handler(contextWith(relayer))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(relayer.created).toEqual(['tx-1']);
    });

    test('a first send that reaches the fund relayer late still covers the whole plugin window', async () => {
      const relayer = idempotentFundRelayer();
      // The first send's reply is lost before the fund relayer sees it
      const lost = vi.fn().mockRejectedValue(new Error("Socket request 'sendTransaction' timed out after 30000ms"));
      const ctx = makeContext(KEY);
      fundRelayer.sendTransaction = lost;
      await expect(handler(ctx)).rejects.toThrow('timed out');

      // A recovery resend near the record's expiry is the first send it sees
      advanceClock(PLUGIN_TTL_MS - 60_000);
      await expect(handler(contextWith(relayer))).resolves.toMatchObject({ transactionId: 'tx-1' });

      // After the record expires, the fund relayer key from that late send
      // still holds, so a rebuilt transaction is rejected
      advanceClock(120_000);
      await expect(handler(contextWith(relayer))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(relayer.created).toEqual(['tx-1']);
    });

    /** Validates a real signed transaction expiring at maxTime with the real checks, as the handler does. */
    async function useRealValidation(maxTime: number) {
      const actual = await vi.importActual<typeof import('../src/plugin/tx')>('../src/plugin/tx');
      const { payload } = await payloadExpiringAt(maxTime);
      const sdk = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
      const real = new sdk.Transaction(payload.transaction_xdr, sdk.Networks.TESTNET);
      (validateExistingTransactionForSubmitOnly as any).mockImplementation((_tx: unknown, config: any) =>
        actual.validateExistingTransactionForSubmitOnly(real, config)
      );
    }

    test('a signed xdr reused after the plugin record expires has expired too, so nothing is sent', async () => {
      // Validation caps maxTime at maxTimeBoundOffsetSeconds, and the record
      // outlives that, so the transaction cannot be resent once the record is gone
      mockValidateResult = { type: 'xdr', xdr: 'SIGNED_XDR', skipWait: true, fundRelayerId: undefined };
      await useRealValidation(Math.floor(Date.now() / 1000) + 60);
      const relayer = idempotentFundRelayer();
      await expect(handler(contextWith(relayer))).resolves.toMatchObject({ transactionId: 'tx-1' });

      advanceClock(PLUGIN_TTL_MS + 60_000);
      await expect(handler(contextWith(relayer))).rejects.toMatchObject({ code: 'TIMEBOUNDS_EXPIRED' });
      expect(relayer.sendTransaction).toHaveBeenCalledTimes(1);
      expect(relayer.created).toEqual(['tx-1']);
    });

    test('two reservations that get the same signed xdr transaction back charge its fee once', async () => {
      const actualTracker =
        await vi.importActual<typeof import('../src/plugin/fee-tracking')>('../src/plugin/fee-tracking');
      (FeeTracker as any).mockImplementation(function (config: any) {
        return new actualTracker.FeeTracker(config);
      });
      mockValidateResult = { type: 'xdr', xdr: 'SIGNED_XDR', skipWait: true, fundRelayerId: undefined };
      await useRealValidation(Math.floor(Date.now() / 1000) + 60);
      const relayer = idempotentFundRelayer();
      const headers = { ...KEY, 'x-api-key': ['caller-a'] };
      const withKey = () => {
        const ctx = makeContext(headers);
        fundRelayer.sendTransaction = relayer.sendTransaction;
        return ctx;
      };

      // The stale reservation write from the lock race: A's write lands after
      // B has sent and charged, and A sends the identical body
      let releaseStalledWrite!: () => void;
      const stalled = new Promise<void>((resolve) => (releaseStalledWrite = resolve));
      let reachedStall!: () => void;
      const atStall = new Promise<void>((resolve) => (reachedStall = resolve));
      const set = kv.set.bind(kv);
      let stalls = 1;
      vi.spyOn(kv, 'set').mockImplementation(async (key, value, opts) => {
        if (stalls > 0 && /^testnet:idempotency:[0-9a-f]{64}$/.test(key)) {
          stalls--;
          reachedStall();
          await stalled;
        }
        return set(key, value, opts);
      });

      const first = handler(withKey());
      await atStall;
      advanceClock(6_000);
      await expect(handler(withKey())).resolves.toMatchObject({ transactionId: 'tx-1' });
      releaseStalledWrite();
      await expect(first).resolves.toMatchObject({ transactionId: 'tx-1' });

      expect(relayer.created).toEqual(['tx-1']);
      const usage = await kv.get<{ consumed: number }>('testnet:api-key-fees:caller-a');
      expect(usage?.consumed).toBe(1000);
    });

    test('a fee marker outlives the record of a later reservation that gets the same transaction back', async () => {
      // Reviewer's case: a 600s offset raises the 300s key TTL to the
      // transaction lifetime, the record is lost, and a replay of the same
      // signed transaction at 400s makes a reservation lasting past the first
      // reservation's marker
      const actualTracker =
        await vi.importActual<typeof import('../src/plugin/fee-tracking')>('../src/plugin/fee-tracking');
      (FeeTracker as any).mockImplementation(function (config: any) {
        return new actualTracker.FeeTracker(config);
      });
      configOverride = { maxTimeBoundOffsetSeconds: 600, idempotencyKeyTtlSeconds: 300 };
      mockValidateResult = { type: 'xdr', xdr: 'SIGNED_XDR', skipWait: true, fundRelayerId: undefined };
      await useRealValidation(Math.floor(Date.now() / 1000) + 600);
      const relayer = idempotentFundRelayer();
      const headers = { ...KEY, 'x-api-key': ['caller-a'] };
      const withKey = () => {
        const ctx = makeContext(headers);
        fundRelayer.sendTransaction = relayer.sendTransaction;
        fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'confirmed', hash: 'h' });
        return ctx;
      };
      const consumed = async () => (await kv.get<{ consumed: number }>('testnet:api-key-fees:caller-a'))?.consumed;

      await expect(handler(withKey())).resolves.toMatchObject({ transactionId: 'tx-1' });
      expect(await consumed()).toBe(1000);
      const recordKey = (await kv.listKeys('testnet:idempotency:*')).find((k) =>
        /^testnet:idempotency:[0-9a-f]{64}$/.test(k)
      )!;
      expect(await kv.get(recordKey)).toMatchObject({ transactionId: 'tx-1' });

      // The record is lost (a stalled writer deleted it)
      await kv.del(recordKey);
      advanceClock(400_000);
      await expect(handler(withKey())).resolves.toMatchObject({ transactionId: 'tx-1' });
      expect(relayer.created).toEqual(['tx-1']);

      // Past the first reservation's record and margin, within the second's
      advanceClock(600_000);
      expect(await kv.get(recordKey)).toMatchObject({ transactionId: 'tx-1' });
      await expect(handler(withKey())).resolves.toMatchObject({ transactionId: 'tx-1' });
      expect(await consumed()).toBe(1000);
    });

    test('once the fund relayer key has expired too, the key starts a new transaction', async () => {
      const relayer = idempotentFundRelayer();
      await handler(contextWith(relayer));

      advanceClock(RELAYER_TTL_MS + 60_000);
      await expect(handler(contextWith(relayer))).resolves.toMatchObject({ transactionId: 'tx-2' });
      expect(relayer.created).toEqual(['tx-1', 'tx-2']);
    });

    test('a first send the fund relayer is still creating for the key gets 409', async () => {
      const ctx = makeContext(KEY);
      fundRelayer.sendTransaction = vi
        .fn()
        .mockRejectedValue(new Error('Relayer error: A request with this Idempotency-Key is already in progress'));
      await expect(handler(ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS', status: 409 });
      // The payload stays, so a repeat resends it
      const [recordKey] = await kv.listKeys('testnet:idempotency:*');
      expect(await kv.get(recordKey)).toMatchObject({ payload: expect.objectContaining({ fee_bump: true }) });
    });
  });

  test('a recorded transaction the Relayer has pruned reports an unknown outcome with its details', async () => {
    const { payload, transaction } = await payloadExpiringAt(Math.floor(Date.now() / 1000) + 60);
    (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
      await args[7]?.beforeSubmit?.(payload);
      await args[7]?.onSubmitted?.('tx-1');
      return { transactionId: 'tx-1', status: 'confirmed', hash: 'hash-tx-1' };
    });
    await handler(makeContext(KEY));

    const repeat = makeContext(KEY);
    const pruned = 'Relayer error: Entity not found: Transaction with ID tx-1 not found';
    fundRelayer.getTransaction.mockRejectedValue(new Error(pruned));

    await expect(handler(repeat)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_OUTCOME_UNKNOWN',
      details: { reason: pruned, transactionId: 'tx-1', ...transaction },
    });
  });

  test('a recorded transaction the Relayer failed before submitting is neither ONCHAIN_FAILED nor charged', async () => {
    const recordUsageOnce = vi.fn();
    (FeeTracker as any).mockImplementation(function () {
      return { checkBudget: vi.fn(), recordUsage: vi.fn(), recordUsageOnce };
    });
    (submitWithFeeBumpAndWait as any).mockImplementation(async (...args: any[]) => {
      await args[7]?.beforeSubmit?.(PAYLOAD);
      await args[7]?.onSubmitted?.('tx-1');
      throw Object.assign(new Error('Transaction wait timeout. It may still submit.'), { code: 'WAIT_TIMEOUT' });
    });
    const withApiKey = { ...KEY, 'x-api-key': ['caller-a'] };
    await expect(handler(makeContext(withApiKey))).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });

    const repeat = makeContext(withApiKey);
    fundRelayer.getTransaction.mockResolvedValue({ id: 'tx-1', status: 'failed', status_reason: 'Queue unavailable' });

    await expect(handler(repeat)).rejects.toMatchObject({ code: 'TRANSACTION_NOT_SUBMITTED' });
    expect(recordUsageOnce).not.toHaveBeenCalled();
  });

  test('a repeat of a transaction that failed on chain reports ONCHAIN_FAILED', async () => {
    submitCreates('tx-1');
    await handler(makeContext(KEY));

    const repeat = makeContext(KEY);
    fundRelayer.getTransaction.mockResolvedValue({
      id: 'tx-1',
      status: 'failed',
      hash: 'hash-tx-1',
      status_reason: 'Specific XDR reason: txFailed',
    });

    await expect(handler(repeat)).rejects.toMatchObject({
      code: 'ONCHAIN_FAILED',
      status: 400,
      details: expect.objectContaining({ id: 'tx-1', hash: 'hash-tx-1', resultCode: 'txFailed' }),
    });
  });

  test('raises a retention shorter than the transaction lifetime', async () => {
    // A 600s time bound outlives the configured 300s retention
    configOverride = { idempotencyKeyTtlSeconds: 300, maxTimeBoundOffsetSeconds: 600 };
    const setSpy = vi.spyOn(kv, 'set');
    submitCreates('tx-1');

    await handler(makeContext(KEY));

    const recordWrites = setSpy.mock.calls.filter(([key]) => /^testnet:idempotency:[0-9a-f]{64}$/.test(key));
    // 30s budget + 600s time bounds + 6s cooldown + 35s send window
    for (const [, , opts] of recordWrites) expect(opts).toEqual({ ttlSec: 671 });
  });

  test('keeps records for the configured retention', async () => {
    configOverride = { idempotencyKeyTtlSeconds: 600 };
    const setSpy = vi.spyOn(kv, 'set');
    submitCreates('tx-1');

    await handler(makeContext(KEY));

    const recordWrites = setSpy.mock.calls.filter(([key]) => /^testnet:idempotency:[0-9a-f]{64}$/.test(key));
    expect(recordWrites.length).toBeGreaterThan(0);
    for (const [, , opts] of recordWrites) expect(opts).toEqual({ ttlSec: 600 });
  });

  test('get-transaction ignores the header', async () => {
    mockValidateResult = { type: 'get-transaction', transactionId: 'tx-123' };

    const result = await handler(makeContext(KEY));

    expect(result).toEqual({ transactionId: 'tx-123', status: 'confirmed', hash: 'hash-123' });
    expect(await kv.listKeys('testnet:idempotency:*')).toEqual([]);
  });
});
