import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  parseFundRelayerOverrides,
  resolveInclusionFees,
  resolveTimeouts,
  resolveTransactionParams,
} from '../src/plugin/fund-relayer-config';

// Mock fee-stats to control fetchDynamicInclusionFee behaviour
vi.mock('../src/plugin/fee-stats', () => ({
  fetchDynamicInclusionFee: vi.fn().mockResolvedValue(500),
}));

import { fetchDynamicInclusionFee } from '../src/plugin/fee-stats';

const globalConfig = {
  inclusionFeeDefault: 203,
  inclusionFeeLimited: 201,
  globalTimeoutMs: 30_000,
  pollingTimeoutMs: 25_000,
  maxTimeBoundOffsetSeconds: 60,
  minSignatureExpirationLedgerBuffer: 2,
  network: 'testnet',
} as any;

const mockRelayer = {} as any;
const mockKv = {} as any;

describe('parseFundRelayerOverrides', () => {
  test('returns undefined when pluginConfig is undefined', () => {
    expect(parseFundRelayerOverrides(undefined, 'x402-fund')).toBeUndefined();
  });

  test('returns undefined when fundRelayers key is missing', () => {
    expect(parseFundRelayerOverrides({}, 'x402-fund')).toBeUndefined();
  });

  test('returns undefined when fundRelayers is not an object', () => {
    expect(parseFundRelayerOverrides({ fundRelayers: 'bad' }, 'x402-fund')).toBeUndefined();
  });

  test('returns undefined when fund relayer ID not found', () => {
    const config = { fundRelayers: { 'other-fund': { dynamicFee: { enabled: true } } } };
    expect(parseFundRelayerOverrides(config, 'x402-fund')).toBeUndefined();
  });

  test('parses valid complete config', () => {
    const config = {
      fundRelayers: {
        'x402-fund': {
          dynamicFee: { enabled: true, percentile: 'p90', cacheTtlMs: 5000 },
          timeouts: { globalTimeoutMs: 20000, pollingTimeoutMs: 15000 },
        },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result).toEqual({
      dynamicFee: { enabled: true, percentile: 'p90', cacheTtlMs: 5000 },
      timeouts: { globalTimeoutMs: 20000, pollingTimeoutMs: 15000 },
    });
  });

  test('applies default percentile when missing', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { dynamicFee: { enabled: true } },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result?.dynamicFee?.percentile).toBe('p50');
  });

  test('applies default cacheTtlMs when missing', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { dynamicFee: { enabled: true } },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result?.dynamicFee?.cacheTtlMs).toBe(10_000);
  });

  test('falls back to default percentile for invalid value', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { dynamicFee: { enabled: true, percentile: 'p99.9' } },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result?.dynamicFee?.percentile).toBe('p50');
  });

  test('returns undefined dynamicFee when enabled is false', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { dynamicFee: { enabled: false } },
      },
    };
    expect(parseFundRelayerOverrides(config, 'x402-fund')).toBeUndefined();
  });

  test('returns undefined dynamicFee when enabled is not boolean', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { dynamicFee: { enabled: 'yes' } },
      },
    };
    expect(parseFundRelayerOverrides(config, 'x402-fund')).toBeUndefined();
  });

  test('parses transactionParams', () => {
    const config = {
      fundRelayers: {
        'x402-fund': {
          transactionParams: { maxTimeBoundOffsetSeconds: 120, minSignatureExpirationLedgerBuffer: 5 },
        },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result?.transactionParams).toEqual({
      maxTimeBoundOffsetSeconds: 120,
      minSignatureExpirationLedgerBuffer: 5,
    });
  });

  test('ignores invalid transactionParams values', () => {
    const config = {
      fundRelayers: {
        'x402-fund': {
          transactionParams: { maxTimeBoundOffsetSeconds: -1, minSignatureExpirationLedgerBuffer: 'bad' },
        },
      },
    };
    // Both invalid → no transactionParams → undefined overrides
    expect(parseFundRelayerOverrides(config, 'x402-fund')).toBeUndefined();
  });

  test('parses timeouts only (no dynamicFee)', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { timeouts: { globalTimeoutMs: 15000 } },
      },
    };
    const result = parseFundRelayerOverrides(config, 'x402-fund');
    expect(result).toEqual({
      dynamicFee: undefined,
      timeouts: { globalTimeoutMs: 15000, pollingTimeoutMs: undefined },
    });
  });

  test('ignores invalid timeout values', () => {
    const config = {
      fundRelayers: {
        'x402-fund': { timeouts: { globalTimeoutMs: -1, pollingTimeoutMs: 'bad' } },
      },
    };
    // Both timeouts invalid → no timeouts → undefined overrides
    expect(parseFundRelayerOverrides(config, 'x402-fund')).toBeUndefined();
  });
});

describe('resolveInclusionFees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns static fees when overrides are undefined', async () => {
    const fees = await resolveInclusionFees(undefined, globalConfig, mockRelayer, mockKv);
    expect(fees).toEqual({ inclusionFeeDefault: 203, inclusionFeeLimited: 201 });
    expect(fetchDynamicInclusionFee).not.toHaveBeenCalled();
  });

  test('returns static fees when dynamicFee is not enabled', async () => {
    const overrides = { timeouts: { globalTimeoutMs: 10000 } };
    const fees = await resolveInclusionFees(overrides, globalConfig, mockRelayer, mockKv);
    expect(fees).toEqual({ inclusionFeeDefault: 203, inclusionFeeLimited: 201 });
    expect(fetchDynamicInclusionFee).not.toHaveBeenCalled();
  });

  test('calls fetchDynamicInclusionFee when enabled', async () => {
    const overrides = {
      dynamicFee: { enabled: true as const, percentile: 'p90' as const, cacheTtlMs: 5000 },
    };
    const fees = await resolveInclusionFees(overrides, globalConfig, mockRelayer, mockKv);

    expect(fetchDynamicInclusionFee).toHaveBeenCalledWith(mockRelayer, mockKv, 'testnet', 'p90', 5000);
    // Dynamic fee (500) + BASE_FEE (100) for fee-bump + margin (3) = 603
    expect(fees).toEqual({ inclusionFeeDefault: 603, inclusionFeeLimited: 603 });
  });

  test('falls back to static fee split when dynamic fee fetch fails', async () => {
    (fetchDynamicInclusionFee as any).mockResolvedValueOnce(null);
    const overrides = {
      dynamicFee: { enabled: true as const, percentile: 'p50' as const, cacheTtlMs: 10000 },
    };
    const fees = await resolveInclusionFees(overrides, globalConfig, mockRelayer, mockKv);

    // Should preserve the 203/201 split, not use 203 for both
    expect(fees).toEqual({ inclusionFeeDefault: 203, inclusionFeeLimited: 201 });
  });
});

describe('resolveTimeouts', () => {
  test('returns global defaults when overrides are undefined', () => {
    const result = resolveTimeouts(undefined, globalConfig);
    expect(result).toEqual({ globalTimeoutMs: 30_000, pollingTimeoutMs: 25_000 });
  });

  test('returns global defaults when no timeout overrides', () => {
    const overrides = { dynamicFee: { enabled: true as const, percentile: 'p50' as const, cacheTtlMs: 10000 } };
    const result = resolveTimeouts(overrides, globalConfig);
    expect(result).toEqual({ globalTimeoutMs: 30_000, pollingTimeoutMs: 25_000 });
  });

  test('overrides globalTimeoutMs while keeping pollingTimeoutMs default', () => {
    const overrides = { timeouts: { globalTimeoutMs: 20_000 } };
    const result = resolveTimeouts(overrides, globalConfig);
    expect(result).toEqual({ globalTimeoutMs: 20_000, pollingTimeoutMs: 25_000 });
  });

  test('overrides both timeouts', () => {
    const overrides = { timeouts: { globalTimeoutMs: 20_000, pollingTimeoutMs: 15_000 } };
    const result = resolveTimeouts(overrides, globalConfig);
    expect(result).toEqual({ globalTimeoutMs: 20_000, pollingTimeoutMs: 15_000 });
  });
});

describe('resolveTransactionParams', () => {
  test('returns global defaults when overrides are undefined', () => {
    const result = resolveTransactionParams(undefined, globalConfig);
    expect(result).toEqual({ maxTimeBoundOffsetSeconds: 60, minSignatureExpirationLedgerBuffer: 2 });
  });

  test('overrides maxTimeBoundOffsetSeconds only', () => {
    const overrides = { transactionParams: { maxTimeBoundOffsetSeconds: 120 } };
    const result = resolveTransactionParams(overrides, globalConfig);
    expect(result).toEqual({ maxTimeBoundOffsetSeconds: 120, minSignatureExpirationLedgerBuffer: 2 });
  });

  test('overrides minSignatureExpirationLedgerBuffer only', () => {
    const overrides = { transactionParams: { minSignatureExpirationLedgerBuffer: 5 } };
    const result = resolveTransactionParams(overrides, globalConfig);
    expect(result).toEqual({ maxTimeBoundOffsetSeconds: 60, minSignatureExpirationLedgerBuffer: 5 });
  });

  test('overrides both params', () => {
    const overrides = {
      transactionParams: { maxTimeBoundOffsetSeconds: 120, minSignatureExpirationLedgerBuffer: 10 },
    };
    const result = resolveTransactionParams(overrides, globalConfig);
    expect(result).toEqual({ maxTimeBoundOffsetSeconds: 120, minSignatureExpirationLedgerBuffer: 10 });
  });
});
