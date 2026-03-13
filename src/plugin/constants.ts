/**
 * constants.ts
 *
 * Centralized constants for the channel accounts plugin.
 */

// HTTP Status Codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

// Configuration Constants
export const CONFIG = {
  DEFAULT_LOCK_TTL_SECONDS: 30,
  MIN_LOCK_TTL_SECONDS: 3,
  MAX_LOCK_TTL_SECONDS: 30,
  DEFAULT_CONTRACT_CAPACITY_RATIO: 0.8,
  DEFAULT_SEQUENCE_NUMBER_CACHE_MAX_AGE_MS: 120_000,
  DEFAULT_MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER: 2,
} as const;

// Pool Constants
export const POOL = {
  // Per-channel claim lock TTL — must exceed worst-case callback latency
  // to prevent TTL expiry allowing a second worker into the same claim section
  CLAIM_LOCK_TTL_SECONDS: 3,
  // Retry policy when all candidates busy
  ACQUIRE_MAX_SPINS: 30,
  ACQUIRE_RETRY_MIN_MS: 10,
  ACQUIRE_RETRY_MAX_MS: 30,
  // Hard-block cooldown for uncertain-outcome channels (~1 Stellar ledger with margin)
  CHANNEL_COOLDOWN_MS: 6_000,
  // Housekeeping TTL for the single LRU map document
  LRU_MAP_TTL_SECONDS: 86_400,
} as const;

// Time Constants
export const TIME = {
  MAX_TIME_BOUND_OFFSET_SECONDS: 60,
} as const;

// Simulation-related defaults
export const SIMULATION = {
  DEFAULT_FEE: '100',
  MIN_TIME_BOUND: 0,
  MAX_TIME_BOUND_OFFSET_SECONDS: 60,
  MAX_FUTURE_TIME_BOUND_SECONDS: 60,
  SIMULATION_AUTH_MODE: 'enforce',
  /** Minimum ledger margin required between latestLedger and auth signatureExpirationLedger. Must be > 1 since simulation already validates 1 ledger of validity. ~10s at ~5s/ledger. */
  MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER: 2,
} as const;

// Global plugin timeout budget
export const TIMEOUT = {
  DEFAULT_GLOBAL_TIMEOUT_MS: 30_000,
  BUFFER_MS: 2_000,
} as const;

// Polling for transactionWait
export const POLLING = {
  INTERVAL_MS: 1000,
  DEFAULT_TIMEOUT_MS: 25_000,
} as const;

export const FEE = {
  // For non-Soroban txs: 100,000 stroops (0.01 XLM) per Stellar best practice
  NON_SOROBAN_FEE: 100_000,
} as const;
