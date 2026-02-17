/**
 * Integration tests for sequence cache lifecycle in handleFuncAuthSubmit.
 * Verifies commitSequence/clearSequence are called correctly based on submit outcome.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext, PluginAPI } from '@openzeppelin/relayer-sdk';
import { FakeKV } from './helpers/fakeKV';

// Mock config to avoid env var requirements
vi.mock('../src/plugin/config', () => ({
  loadConfig: () => ({
    fundRelayerId: 'fund-1',
    network: 'testnet',
    lockTtlSeconds: 30,
    apiKeyHeader: 'x-api-key',
    limitedContracts: new Set<string>(),
    contractCapacityRatio: 0.8,
    inclusionFeeDefault: 203,
    inclusionFeeLimited: 201,
  }),
  getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
}));

// Mock pool to immediately return a channel
vi.mock('../src/plugin/pool', () => {
  class MockChannelPool {
    acquire = vi.fn().mockResolvedValue({ relayerId: 'channel-1', token: 'tok' });
    release = vi.fn().mockResolvedValue(undefined);
  }
  return { ChannelPool: MockChannelPool };
});

// Mock simulation to return non-read-only result
vi.mock('../src/plugin/simulation', () => ({
  simulateTransaction: vi.fn().mockResolvedValue({
    isReadOnly: false,
    rawSimResult: { id: '1', results: [{ auth: ['a'], xdr: 'AAAA' }] },
  }),
  buildWithChannel: vi.fn().mockReturnValue({
    toXDR: () => 'built-xdr',
    toEnvelope: () => ({
      v1: () => ({
        tx: () => ({
          ext: () => ({ sorobanData: () => ({ resourceFee: () => 1000 }) }),
          operations: () => [
            {
              body: () => ({
                switch: () => ({ value: 24 }),
                invokeHostFunctionOp: () => ({
                  hostFunction: () => ({ switch: () => ({ value: 0 }) }),
                }),
              }),
            },
          ],
        }),
      }),
    }),
    signatures: [{ hint: () => Buffer.alloc(4) }],
    operations: [{ type: 'invokeHostFunction' }],
  }),
}));

// Mock signing
vi.mock('../src/plugin/submit', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    signWithChannelAndFund: vi.fn().mockImplementation((_tx: any) => ({
      toXDR: () => 'signed-xdr',
      toEnvelope: () => ({
        v1: () => ({
          tx: () => ({
            ext: () => ({ sorobanData: () => ({ resourceFee: () => 1000 }) }),
            operations: () => [
              {
                body: () => ({
                  switch: () => ({ value: 24 }),
                  invokeHostFunctionOp: () => ({
                    hostFunction: () => ({ switch: () => ({ value: 0 }) }),
                  }),
                }),
              },
            ],
          }),
        }),
      }),
      signatures: [{ hint: () => Buffer.alloc(4) }],
      operations: [{ type: 'invokeHostFunction' }],
    })),
    submitWithFeeBumpAndWait: vi.fn(),
  };
});

// Mock fee
vi.mock('../src/plugin/fee', () => ({
  calculateMaxFee: vi.fn().mockReturnValue(1203),
  getContractIdFromFunc: vi.fn().mockReturnValue('CONTRACT123'),
  getContractIdFromTransaction: vi.fn(),
}));

// Mock validation to return func+auth request
vi.mock('../src/plugin/validation', () => ({
  validateAndParseRequest: vi.fn().mockReturnValue({
    type: 'func-auth',
    func: { switch: () => ({ value: 0 }) },
    auth: [],
  }),
}));

// Mock management
vi.mock('../src/plugin/management', () => ({
  isManagementRequest: vi.fn().mockReturnValue(false),
  handleManagement: vi.fn(),
}));

// Spy on sequence module
import * as sequenceModule from '../src/plugin/sequence';
import { submitWithFeeBumpAndWait } from '../src/plugin/submit';
import { handler } from '../src/plugin/handler';

const CHANNEL_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function makeContext(kv: FakeKV): PluginContext {
  const channelRelayer = {
    getRelayer: vi.fn().mockResolvedValue({
      address: CHANNEL_ADDRESS,
      network_type: 'stellar',
    }),
    signTransaction: vi.fn().mockResolvedValue({ signature: 'sig', signedXdr: 'xdr' }),
    rpc: vi.fn(),
  };

  const fundRelayer = {
    getRelayer: vi.fn().mockResolvedValue({
      address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      network_type: 'stellar',
    }),
    sendTransaction: vi.fn().mockResolvedValue({ id: 'tx-1', hash: 'hash-1' }),
  };

  const api = {
    useRelayer: vi.fn().mockImplementation((id: string) => {
      if (id === 'fund-1') return fundRelayer;
      return channelRelayer;
    }),
    transactionWait: vi.fn(),
  } as unknown as PluginAPI;

  return {
    api,
    kv: kv as any,
    params: { func: 'AAAA', auth: [] },
    headers: {},
  } as unknown as PluginContext;
}

describe('handler sequence cache lifecycle', () => {
  let kv: FakeKV;
  let getSequenceSpy: ReturnType<typeof vi.spyOn>;
  let commitSequenceSpy: ReturnType<typeof vi.spyOn>;
  let clearSequenceSpy: ReturnType<typeof vi.spyOn>;
  const mockSubmit = submitWithFeeBumpAndWait as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kv = new FakeKV();
    vi.clearAllMocks();
    getSequenceSpy = vi.spyOn(sequenceModule, 'getSequence').mockResolvedValue('42');
    commitSequenceSpy = vi.spyOn(sequenceModule, 'commitSequence').mockResolvedValue(undefined);
    clearSequenceSpy = vi.spyOn(sequenceModule, 'clearSequence').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls commitSequence on confirmed transaction', async () => {
    mockSubmit.mockResolvedValue({
      transactionId: 'tx-1',
      status: 'confirmed',
      hash: 'hash-1',
    });

    const ctx = makeContext(kv);
    const result = await handler(ctx);

    expect(result.status).toBe('confirmed');
    expect(getSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', expect.anything(), CHANNEL_ADDRESS);
    expect(commitSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', CHANNEL_ADDRESS, '42');
    expect(clearSequenceSpy).not.toHaveBeenCalled();
  });

  test('calls clearSequence on non-confirmed result status', async () => {
    mockSubmit.mockResolvedValue({
      transactionId: 'tx-1',
      status: 'pending',
      hash: 'hash-1',
    });

    const ctx = makeContext(kv);
    const result = await handler(ctx);

    expect(result.status).toBe('pending');
    expect(commitSequenceSpy).not.toHaveBeenCalled();
    expect(clearSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', CHANNEL_ADDRESS);
  });

  test('calls clearSequence on ONCHAIN_FAILED error', async () => {
    const err = new Error('TxFailed') as any;
    err.code = 'ONCHAIN_FAILED';
    mockSubmit.mockRejectedValue(err);

    const ctx = makeContext(kv);
    await expect(handler(ctx)).rejects.toMatchObject({ code: 'ONCHAIN_FAILED' });

    expect(commitSequenceSpy).not.toHaveBeenCalled();
    expect(clearSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', CHANNEL_ADDRESS);
  });

  test('calls clearSequence on WAIT_TIMEOUT error', async () => {
    const err = new Error('timeout') as any;
    err.code = 'WAIT_TIMEOUT';
    mockSubmit.mockRejectedValue(err);

    const ctx = makeContext(kv);
    await expect(handler(ctx)).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });

    expect(commitSequenceSpy).not.toHaveBeenCalled();
    expect(clearSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', CHANNEL_ADDRESS);
  });

  test('calls clearSequence on unexpected submit error', async () => {
    mockSubmit.mockRejectedValue(new Error('network down'));

    const ctx = makeContext(kv);
    await expect(handler(ctx)).rejects.toThrow('network down');

    expect(commitSequenceSpy).not.toHaveBeenCalled();
    expect(clearSequenceSpy).toHaveBeenCalledWith(kv, 'testnet', CHANNEL_ADDRESS);
  });
});
