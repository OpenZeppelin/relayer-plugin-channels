/**
 * config.ts
 *
 * Environment-driven configuration for the channel accounts plugin.
 */

import { Networks } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, CONFIG } from './constants';

export interface ChannelAccountsConfig {
  fundRelayerId: string;
  network: 'testnet' | 'mainnet';
  lockTtlSeconds: number;
  adminSecret?: string;
  feeLimit?: number;
  feeResetPeriodMs?: number;
  apiKeyHeader: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw pluginError(`Missing required environment variable: ${name}`, {
      code: 'CONFIG_MISSING',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: { name },
    });
  }
  return v.trim();
}

function parseOptionalString(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function parseLockTtl(): number {
  const raw = process.env.LOCK_TTL_SECONDS;
  if (!raw) return CONFIG.DEFAULT_LOCK_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < CONFIG.MIN_LOCK_TTL_SECONDS || n > CONFIG.MAX_LOCK_TTL_SECONDS) {
    return CONFIG.DEFAULT_LOCK_TTL_SECONDS;
  }
  return Math.floor(n);
}

function parseFeeLimit(): number | undefined {
  const raw = process.env.FEE_LIMIT;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function parseFeeResetPeriod(): number | undefined {
  const raw = process.env.FEE_RESET_PERIOD_SECONDS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * 1000 : undefined;
}

function parseApiKeyHeader(): string {
  const raw = process.env.API_KEY_HEADER;
  if (!raw) return 'x-api-key';
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'x-api-key';
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): ChannelAccountsConfig {
  const networkRaw = requireEnv('STELLAR_NETWORK').toLowerCase();
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    throw pluginError('STELLAR_NETWORK must be "testnet" or "mainnet"', {
      code: 'UNSUPPORTED_NETWORK',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  return {
    fundRelayerId: requireEnv('FUND_RELAYER_ID'),
    network: networkRaw as 'testnet' | 'mainnet',
    lockTtlSeconds: parseLockTtl(),
    adminSecret: parseOptionalString('PLUGIN_ADMIN_SECRET'),
    feeLimit: parseFeeLimit(),
    feeResetPeriodMs: parseFeeResetPeriod(),
    apiKeyHeader: parseApiKeyHeader(),
  };
}

/**
 * Get the network passphrase based on the configuration
 */
export function getNetworkPassphrase(network: 'testnet' | 'mainnet'): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}
