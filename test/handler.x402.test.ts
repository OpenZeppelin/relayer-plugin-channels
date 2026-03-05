/**
 * Tests for x402 fund relayer selection in the handler.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, PluginAPI } from '@openzeppelin/relayer-sdk';
import { FakeKV } from './helpers/fakeKV';

// Mock config with mutable override
let configOverride: Record<string, any> = {};
const baseConfig = {
  fundRelayerId: 'fund-1',
  network: 'testnet',
  lockTtlSeconds: 30,
  apiKeyHeader: 'x-api-key',
  limitedContracts: new Set<string>(),
  contractCapacityRatio: 0.8,
  inclusionFeeDefault: 203,
  inclusionFeeLimited: 201,
  sequenceNumberCacheMaxAgeMs: 120_000,
  minSignatureExpirationLedgerBuffer: 20,
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
  x402: false,
};
vi.mock('../src/plugin/validation', () => ({
  validateAndParseRequest: vi.fn().mockImplementation(() => ({ ...mockValidateResult })),
}));

// Mock pool
vi.mock('../src/plugin/pool', () => {
  class MockChannelPool {
    acquire = vi.fn();
    release = vi.fn();
    extendLock = vi.fn();
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
    signatures = [{ hint: () => Buffer.from('hint') }];
    operations = [{ type: 'invokeHostFunction' }];
    fee = '100';
    toXDR() {
      return 'MOCK_XDR';
    }
  }
  return {
    ...actual,
    Transaction: MockTransaction,
  };
});

import { handler } from '../src/plugin/handler';

describe('x402 fund relayer selection', () => {
  let kv: FakeKV;
  let useRelayerMock: ReturnType<typeof vi.fn>;

  function makeContext(): PluginContext {
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
    } as unknown as PluginContext;
  }

  beforeEach(() => {
    kv = new FakeKV();
    configOverride = {};
    mockValidateResult = {
      type: 'xdr' as const,
      xdr: 'SIGNED_XDR',
      skipWait: false,
      x402: false,
    };
    vi.clearAllMocks();
  });

  test('uses default fund relayer when x402 is false', async () => {
    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses x402 fund relayer when x402 is true and configured', async () => {
    configOverride = { x402FundRelayerId: 'x402-fund-1' };
    mockValidateResult = { ...mockValidateResult, x402: true };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('x402-fund-1');
  });

  test('throws CONFIG_MISSING when x402 is true but not configured', async () => {
    mockValidateResult = { ...mockValidateResult, x402: true };

    const ctx = makeContext();
    await expect(handler(ctx)).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
  });

  test('uses default fund relayer when x402 is false even if x402FundRelayerId is configured', async () => {
    configOverride = { x402FundRelayerId: 'x402-fund-1' };
    mockValidateResult = { ...mockValidateResult, x402: false };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses default fund relayer for get-transaction when x402 is false', async () => {
    configOverride = { x402FundRelayerId: 'x402-fund-1' };
    mockValidateResult = {
      type: 'get-transaction' as const,
      transactionId: 'tx-123',
      x402: false,
    };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('fund-1');
  });

  test('uses x402 fund relayer for get-transaction when x402 is true', async () => {
    configOverride = { x402FundRelayerId: 'x402-fund-1' };
    mockValidateResult = {
      type: 'get-transaction' as const,
      transactionId: 'tx-123',
      x402: true,
    };

    const ctx = makeContext();
    await handler(ctx);

    expect(useRelayerMock).toHaveBeenCalledWith('x402-fund-1');
  });
});
