/**
 * Tests for the get-transaction request type in the handler.
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

// Mock validation to return get-transaction request
const mockValidateResult = {
  type: 'get-transaction' as const,
  transactionId: 'tx-123',
  x402: false,
};
vi.mock('../src/plugin/validation', () => ({
  validateAndParseRequest: vi.fn().mockImplementation(() => ({ ...mockValidateResult })),
}));

// We don't need pool/simulation/submit mocks since get-transaction exits early
vi.mock('../src/plugin/pool', () => {
  class MockChannelPool {
    acquire = vi.fn();
    release = vi.fn();
    extendLock = vi.fn();
  }
  return { ChannelPool: MockChannelPool };
});

import { handler } from '../src/plugin/handler';

describe('get-transaction handler', () => {
  let kv: FakeKV;
  let getTransactionMock: ReturnType<typeof vi.fn>;

  function makeContext(overrides?: { headers?: Record<string, string[]> }): PluginContext {
    getTransactionMock = vi.fn().mockResolvedValue({
      id: 'tx-123',
      status: 'confirmed',
      hash: 'abc123',
      relayer_id: 'fund-1',
    });

    const fundRelayer = {
      getRelayer: vi.fn().mockResolvedValue({
        address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        network_type: 'stellar',
      }),
      getTransaction: getTransactionMock,
    };

    const api = {
      useRelayer: vi.fn().mockReturnValue(fundRelayer),
    } as unknown as PluginAPI;

    return {
      api,
      kv: kv as any,
      params: { getTransaction: { transactionId: 'tx-123' } },
      headers: overrides?.headers ?? {},
    } as unknown as PluginContext;
  }

  beforeEach(() => {
    kv = new FakeKV();
    vi.clearAllMocks();
  });

  test('returns mapped transaction response', async () => {
    const ctx = makeContext();
    const result = await handler(ctx);

    expect(getTransactionMock).toHaveBeenCalledWith({ transactionId: 'tx-123' });
    expect(result).toEqual({
      transactionId: 'tx-123',
      status: 'confirmed',
      hash: 'abc123',
    });
  });

  test('returns null hash when transaction has no hash', async () => {
    const ctx = makeContext();
    getTransactionMock.mockResolvedValue({
      id: 'tx-456',
      status: 'pending',
      relayer_id: 'fund-1',
    });
    mockValidateResult.transactionId = 'tx-456';

    const result = await handler(ctx);

    expect(result).toEqual({
      transactionId: 'tx-456',
      status: 'pending',
      hash: null,
    });

    // Reset
    mockValidateResult.transactionId = 'tx-123';
  });

  test('does not call getRelayer or acquire pool', async () => {
    const ctx = makeContext();
    await handler(ctx);

    // useRelayer is called once for the fund relayer, but getRelayer should not be called
    const fundRelayer = (ctx.api.useRelayer as any).mock.results[0].value;
    expect(fundRelayer.getRelayer).not.toHaveBeenCalled();
  });
});

describe('get-transaction API key requirement', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
    configOverride = {};
    vi.clearAllMocks();
  });

  test('rejects when feeLimit is set and no API key provided', async () => {
    configOverride = { feeLimit: 1000 };

    const fundRelayer = {
      getRelayer: vi.fn().mockResolvedValue({
        address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        network_type: 'stellar',
      }),
      getTransaction: vi.fn(),
    };

    const api = {
      useRelayer: vi.fn().mockReturnValue(fundRelayer),
    } as unknown as PluginAPI;

    const ctx = {
      api,
      kv: kv as any,
      params: { getTransaction: { transactionId: 'tx-123' } },
      headers: {},
    } as unknown as PluginContext;

    await expect(handler(ctx)).rejects.toMatchObject({
      code: 'API_KEY_REQUIRED',
    });
  });
});
