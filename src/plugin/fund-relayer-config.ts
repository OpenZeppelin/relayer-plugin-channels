/**
 * fund-relayer-config.ts
 *
 * Parse and validate per-fund-relayer overrides from the plugin config
 * (`context.config` in PluginContext, sourced from config.json `plugins[].config`).
 *
 * When no per-fund config is present, all behaviour falls back to the global
 * env-var-based defaults in ChannelAccountsConfig.
 */

import type { PluginKVStore, Relayer } from '@openzeppelin/relayer-sdk';
import { BASE_FEE } from '@stellar/stellar-sdk';
import type { ChannelAccountsConfig } from './config';
import type { InclusionFees } from './fee';
import { fetchDynamicInclusionFee } from './fee-stats';
import { DYNAMIC_FEE } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeePercentile = (typeof DYNAMIC_FEE.VALID_PERCENTILES)[number];

export interface DynamicFeeConfig {
  enabled: boolean;
  percentile: FeePercentile;
  cacheTtlMs: number;
}

export interface FundRelayerTimeouts {
  globalTimeoutMs?: number;
  pollingTimeoutMs?: number;
}

export interface FundRelayerTransactionParams {
  maxTimeBoundOffsetSeconds?: number;
  minSignatureExpirationLedgerBuffer?: number;
}

export interface FundRelayerOverrides {
  dynamicFee?: DynamicFeeConfig;
  timeouts?: FundRelayerTimeouts;
  transactionParams?: FundRelayerTransactionParams;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const validPercentiles = new Set<string>(DYNAMIC_FEE.VALID_PERCENTILES);

function isValidPercentile(v: unknown): v is FeePercentile {
  return typeof v === 'string' && validPercentiles.has(v);
}

function parsePositiveNumber(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

function parseDynamicFee(raw: unknown): DynamicFeeConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.enabled !== 'boolean' || !obj.enabled) return undefined;

  const percentile = isValidPercentile(obj.percentile) ? obj.percentile : DYNAMIC_FEE.DEFAULT_PERCENTILE;
  const cacheTtlMs = parsePositiveNumber(obj.cacheTtlMs) ?? DYNAMIC_FEE.DEFAULT_CACHE_TTL_MS;

  return { enabled: true, percentile, cacheTtlMs };
}

function parseTransactionParams(raw: unknown): FundRelayerTransactionParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  const maxTimeBoundOffsetSeconds = parsePositiveNumber(obj.maxTimeBoundOffsetSeconds);
  const minSignatureExpirationLedgerBuffer = parsePositiveNumber(obj.minSignatureExpirationLedgerBuffer);

  if (maxTimeBoundOffsetSeconds === undefined && minSignatureExpirationLedgerBuffer === undefined) return undefined;
  return { maxTimeBoundOffsetSeconds, minSignatureExpirationLedgerBuffer };
}

function parseTimeouts(raw: unknown): FundRelayerTimeouts | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  const globalTimeoutMs = parsePositiveNumber(obj.globalTimeoutMs);
  const pollingTimeoutMs = parsePositiveNumber(obj.pollingTimeoutMs);

  if (globalTimeoutMs === undefined && pollingTimeoutMs === undefined) return undefined;
  return { globalTimeoutMs, pollingTimeoutMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract and validate per-fund-relayer overrides from plugin config.
 * Returns `undefined` when no overrides exist for the given fund relayer,
 * which signals the caller to use global env-var defaults.
 */
export function parseFundRelayerOverrides(
  pluginConfig: Record<string, any> | undefined,
  fundRelayerId: string
): FundRelayerOverrides | undefined {
  if (!pluginConfig) return undefined;

  const fundRelayers = pluginConfig.fundRelayers;
  if (!fundRelayers || typeof fundRelayers !== 'object') return undefined;

  const raw = fundRelayers[fundRelayerId];
  if (!raw || typeof raw !== 'object') return undefined;

  const dynamicFee = parseDynamicFee(raw.dynamicFee);
  const timeouts = parseTimeouts(raw.timeouts);
  const transactionParams = parseTransactionParams(raw.transactionParams);

  if (!dynamicFee && !timeouts && !transactionParams) return undefined;
  return { dynamicFee, timeouts, transactionParams };
}

/**
 * Resolve the inclusion fees for this request.
 *
 * When the fund relayer has `dynamicFee.enabled`, a single dynamic fee is
 * used for both limited and non-limited contracts (the limited/non-limited
 * distinction is static tuning that dynamic fees replace).
 *
 * On any dynamic-fee error the global static defaults are returned.
 */
export async function resolveInclusionFees(
  overrides: FundRelayerOverrides | undefined,
  globalConfig: ChannelAccountsConfig,
  relayer: Relayer,
  kv: PluginKVStore
): Promise<InclusionFees> {
  if (overrides?.dynamicFee?.enabled) {
    const fee = await fetchDynamicInclusionFee(
      relayer,
      kv,
      globalConfig.network,
      overrides.dynamicFee.percentile,
      overrides.dynamicFee.cacheTtlMs
    );
    if (fee !== null) {
      // getFeeStats reports inner-tx inclusion fees. Fee-bump wrapping adds one
      // extra virtual operation at BASE_FEE, plus a small margin to avoid
      // landing exactly at the protocol minimum.
      const feeBumpFee = fee + Number(BASE_FEE) + DYNAMIC_FEE.FEE_BUMP_MARGIN_DEFAULT;
      return { inclusionFeeDefault: feeBumpFee, inclusionFeeLimited: feeBumpFee };
    }
    // Dynamic fee fetch failed — fall through to static defaults
  }

  return {
    inclusionFeeDefault: globalConfig.inclusionFeeDefault,
    inclusionFeeLimited: globalConfig.inclusionFeeLimited,
  };
}

/**
 * Resolve effective transaction params (timebounds, auth expiry) by merging
 * per-fund overrides with global defaults.
 */
export function resolveTransactionParams(
  overrides: FundRelayerOverrides | undefined,
  globalConfig: ChannelAccountsConfig
): { maxTimeBoundOffsetSeconds: number; minSignatureExpirationLedgerBuffer: number } {
  return {
    maxTimeBoundOffsetSeconds:
      overrides?.transactionParams?.maxTimeBoundOffsetSeconds ?? globalConfig.maxTimeBoundOffsetSeconds,
    minSignatureExpirationLedgerBuffer:
      overrides?.transactionParams?.minSignatureExpirationLedgerBuffer ??
      globalConfig.minSignatureExpirationLedgerBuffer,
  };
}

/**
 * Resolve effective timeouts by merging per-fund overrides with global defaults.
 */
export function resolveTimeouts(
  overrides: FundRelayerOverrides | undefined,
  globalConfig: ChannelAccountsConfig
): { globalTimeoutMs: number; pollingTimeoutMs: number } {
  return {
    globalTimeoutMs: overrides?.timeouts?.globalTimeoutMs ?? globalConfig.globalTimeoutMs,
    pollingTimeoutMs: overrides?.timeouts?.pollingTimeoutMs ?? globalConfig.pollingTimeoutMs,
  };
}
