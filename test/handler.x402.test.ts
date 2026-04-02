/**
 * Tests for alternative fund relayer selection in the handler.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
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

// Mock validation — controlled via mockValidateResult
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
};
vi.mock('../src/plugin/pool', () => {
  class MockChannelPool {
    acquire = poolSpies.acquire;
    release = poolSpies.release;
    extendLock = poolSpies.extendLock;
  }
  return { ChannelPool: MockChannelPool };
});

// Mock submit
vi.mock('../src/plugin/submit', () => ({
  signWithChannelAndFund: vi.fn(),
  submitWithFeeBumpAndWait: vi.fn().mockResolvedValue({
    transactionId: 'tx-abc',
    status: 'confirmed',
    hash: 'hash-abc',
  }),
}));

// Mock tx validation — return an object with toXDR
vi.mock('../src/plugin/tx', () => ({
  validateExistingTransactionForSubmitOnly: vi.fn().mockImplementation(() => ({
    fee: '100',
    toXDR: () => 'MOCK_XDR',
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
    toXDR() {
      return 'MOCK_XDR';
    }
    toEnvelope() {
      return {
        v1: () => ({
          tx: () => ({
            operations: () => [
              {
                body: () => ({
                  switch: () => actual.xdr.OperationType.invokeHostFunction(),
                  invokeHostFunctionOp: () => ({
                    hostFunction: () => ({ switch: () => ({ value: 0 }) }),
                    auth: () => [],
                  }),
                }),
              },
            ],
          }),
        }),
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

describe('alternative fund relayer selection', () => {
  let kv: FakeKV;
  let useRelayerMock: ReturnType<typeof vi.fn>;

  function makeContext(pluginConfig?: Record<string, any>): PluginContext {
    const fundRelayer = {
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
      headers: {},
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
      toXDR: () => 'BUILT_XDR',
      signatures: [{ hint: () => Buffer.alloc(4) }],
      operations: [{ type: 'invokeHostFunction' }],
    });
    (signWithChannelAndFund as any).mockImplementation(async (tx: any) => tx);
  });

  test('uses default fund relayer when no fundRelayerId specified', async () => {
    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses specified fund relayer when fundRelayerId is in allowed list', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('x402-fund-1');
  });

  test('throws CONFIG_MISSING when fundRelayerId is not in allowed list', async () => {
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const ctx = makeContext();
    await expect(handler(ctx)).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
  });

  test('uses default fund relayer when fundRelayerId is undefined even if allowed list configured', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: undefined };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses default fund relayer for get-transaction when no fundRelayerId', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = {
      type: 'get-transaction' as const,
      transactionId: 'tx-123',
      fundRelayerId: undefined,
    };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses specified fund relayer for get-transaction when fundRelayerId is allowed', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = {
      type: 'get-transaction' as const,
      transactionId: 'tx-123',
      fundRelayerId: 'x402-fund-1',
    };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('x402-fund-1');
  });

  test('uses dynamic fees when fund relayer has dynamicFee enabled in plugin config', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          dynamicFee: { enabled: true, percentile: 'p50', cacheTtlMs: 10000 },
        },
      },
    };
    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    expect(mockFetchDynamicInclusionFee).toHaveBeenCalledWith(
      expect.anything(), // relayer
      expect.anything(), // kv
      'testnet', // network
      'p50',
      10000
    );
  });

  test('uses static fees when fund relayer is not in plugin config', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const pluginConfig = {
      fundRelayers: {
        'other-fund': { dynamicFee: { enabled: true } },
      },
    };
    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    expect(mockFetchDynamicInclusionFee).not.toHaveBeenCalled();
  });

  test('uses static fees when no plugin config provided', async () => {
    const ctx = makeContext(); // no pluginConfig
    await handler(ctx);

    expect(mockFetchDynamicInclusionFee).not.toHaveBeenCalled();
  });

  test('applies timeout overrides from plugin config', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          timeouts: { globalTimeoutMs: 20000, pollingTimeoutMs: 15000 },
        },
      },
    };
    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    // Check that submitWithFeeBumpAndWait was called with overridden config
    const submitMock = submitWithFeeBumpAndWait as any;
    expect(submitMock).toHaveBeenCalled();
    const configArg = submitMock.mock.calls[0]?.[9]; // 10th arg is config
    expect(configArg?.globalTimeoutMs).toBe(20000);
    expect(configArg?.pollingTimeoutMs).toBe(15000);
  });

  test('applies transactionParams overrides from plugin config', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          transactionParams: { maxTimeBoundOffsetSeconds: 120 },
        },
      },
    };
    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    const txValidateMock = validateExistingTransactionForSubmitOnly as any;
    expect(txValidateMock).toHaveBeenCalled();
    const configArg = txValidateMock.mock.calls[0]?.[1];
    expect(configArg?.maxTimeBoundOffsetSeconds).toBe(120);
  });

  test('uses default maxTimeBoundOffsetSeconds when no plugin config', async () => {
    const ctx = makeContext(); // no pluginConfig
    await handler(ctx);

    const txValidateMock = validateExistingTransactionForSubmitOnly as any;
    expect(txValidateMock).toHaveBeenCalled();
    const configArg = txValidateMock.mock.calls[0]?.[1];
    expect(configArg?.maxTimeBoundOffsetSeconds).toBe(60);
  });

  test('falls back to static fee split in handler when dynamic fee fetch fails', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = { ...mockValidateResult, fundRelayerId: 'x402-fund-1' };
    mockFetchDynamicInclusionFee.mockResolvedValueOnce(null);

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          dynamicFee: { enabled: true, percentile: 'p50', cacheTtlMs: 10000 },
        },
      },
    };

    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    const calculateMaxFeeMock = calculateMaxFee as any;
    expect(calculateMaxFeeMock).toHaveBeenCalled();
    const feesArg = calculateMaxFeeMock.mock.calls[0]?.[2];
    expect(feesArg).toEqual({ inclusionFeeDefault: 203, inclusionFeeLimited: 201 });
  });

  test('applies unsigned XDR transaction param overrides in simulation and build paths', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = {
      type: 'xdr' as const,
      xdr: 'UNSIGNED_XDR',
      skipWait: false,
      fundRelayerId: 'x402-fund-1',
    };

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          transactionParams: {
            maxTimeBoundOffsetSeconds: 120,
            minSignatureExpirationLedgerBuffer: 5,
          },
        },
      },
    };

    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    const simulateMock = simulateTransaction as any;
    const buildMock = buildWithChannel as any;
    expect(simulateMock).toHaveBeenCalled();
    expect(buildMock).toHaveBeenCalled();
    expect(simulateMock.mock.calls[0]?.[5]).toBe(120);
    expect(buildMock.mock.calls[0]?.[5]).toBe(5);
    expect(buildMock.mock.calls[0]?.[6]).toBe(120);
  });

  test('preserves global transaction defaults for missing unsigned XDR override fields', async () => {
    configOverride = { allowedFundRelayerIds: new Set(['x402-fund-1']) };
    mockValidateResult = {
      type: 'xdr' as const,
      xdr: 'UNSIGNED_XDR',
      skipWait: false,
      fundRelayerId: 'x402-fund-1',
    };

    const pluginConfig = {
      fundRelayers: {
        'x402-fund-1': {
          transactionParams: {
            minSignatureExpirationLedgerBuffer: 5,
          },
        },
      },
    };

    const ctx = makeContext(pluginConfig);
    await handler(ctx);

    const simulateMock = simulateTransaction as any;
    const buildMock = buildWithChannel as any;
    expect(simulateMock.mock.calls[0]?.[5]).toBe(60);
    expect(buildMock.mock.calls[0]?.[5]).toBe(5);
    expect(buildMock.mock.calls[0]?.[6]).toBe(60);
  });
});
