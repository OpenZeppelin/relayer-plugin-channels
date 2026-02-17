import type { LogEntry } from '@openzeppelin/relayer-sdk';

/**
 * Configuration for ChannelsClient in direct HTTP mode
 */
export interface DirectHttpConfig {
  /** Base URL for channel accounts service */
  baseUrl: string;
  /** API key for channel accounts service */
  apiKey: string;
  /** Optional admin secret for management operations */
  adminSecret?: string;
  /** Optional request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Configuration for ChannelsClient in relayer mode
 */
export interface RelayerConfig {
  /** Plugin ID in the OpenZeppelin Relayer */
  pluginId: string;
  /** API key for OpenZeppelin Relayer */
  apiKey: string;
  /** Base URL for OpenZeppelin Relayer */
  baseUrl: string;
  /** Optional admin secret for management operations */
  adminSecret?: string;
  /** Optional request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Header name for API key forwarding to plugin (default: 'x-api-key') */
  apiKeyHeader?: string;
}

/**
 * Configuration for ChannelsClient
 * The client automatically detects the mode:
 * - If pluginId is provided → relayer mode
 * - Otherwise → direct HTTP mode
 */
export type ChannelsClientConfig = DirectHttpConfig | RelayerConfig;

/**
 * Transaction submission request using signed XDR
 */
export interface ChannelsXdrRequest {
  /** Complete signed transaction envelope XDR */
  xdr: string;
}

/**
 * Transaction submission using Soroban function and authorization
 */
export interface ChannelsFuncAuthRequest {
  /** Soroban host function XDR (base64) */
  func: string;
  /** Array of authorization entry XDRs (base64) */
  auth: string[];
}

/**
 * Response from transaction submission
 */
export interface ChannelsTransactionResponse {
  /** Transaction ID from the relayer */
  transactionId: string | null;
  /** Transaction hash on-chain */
  hash: string | null;
  /** Transaction status */
  status: string | null;
  /** Present only for read-only calls: the base64-encoded xdr.ScVal return value */
  returnValue?: string;
  /** Present only for read-only calls: the latest ledger at simulation time */
  latestLedger?: number;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from listing channel accounts
 */
export interface ListChannelAccountsResponse {
  /** Array of relayer IDs currently configured as channel accounts */
  relayerIds: string[];
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from setting channel accounts
 */
export interface SetChannelAccountsResponse {
  /** Success indicator */
  ok: boolean;
  /** Array of relayer IDs that were applied */
  appliedRelayerIds: string[];
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from getting fee usage
 */
export interface GetFeeUsageResponse {
  /** Total fees consumed (in stroops) */
  consumed: number;
  /** Effective fee limit (in stroops), undefined if unlimited */
  limit?: number;
  /** Remaining fee budget (in stroops), undefined if unlimited */
  remaining?: number;
  /** When the current reset period started, undefined if no reset period */
  periodStartAt?: string;
  /** When the current period will end, undefined if no reset period */
  periodEndsAt?: string;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from getting fee limit
 */
export interface GetFeeLimitResponse {
  /** Fee limit (in stroops), undefined if unlimited */
  limit?: number;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from setting fee limit
 */
export interface SetFeeLimitResponse {
  /** Success indicator */
  ok: boolean;
  /** The limit that was set (in stroops) */
  limit: number;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from deleting fee limit
 */
export interface DeleteFeeLimitResponse {
  /** Success indicator */
  ok: boolean;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Response from getting pool stats
 */
export interface GetStatsResponse {
  pool: {
    size: number;
    locked?: number;
    available?: number;
  };
  config: {
    network: 'testnet' | 'mainnet';
    lockTtlSeconds: number;
    feeLimit?: number;
    feeResetPeriodSeconds?: number;
    contractCapacityRatio: number;
    limitedContracts: string[];
  };
  fees: {
    inclusionFeeDefault: number;
    inclusionFeeLimited: number;
  };
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Plugin response structure for successful operations
 */
export interface PluginResponseSuccess<T> {
  success: true;
  data: T;
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Plugin response structure for failed operations
 */
export interface PluginResponseError {
  success: false;
  error: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Discriminated union type for all plugin responses
 * Enables type-safe handling of success/error cases
 */
export type PluginResponse<T> = PluginResponseSuccess<T> | PluginResponseError;
