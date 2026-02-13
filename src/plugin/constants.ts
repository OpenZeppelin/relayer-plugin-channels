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
} as const;

// Pool Constants
export const POOL = {
  // TTL for the short global mutex guarding acquire()
  MUTEX_TTL_SECONDS: 1,
  // Retry policy when mutex is busy
  MUTEX_MAX_SPINS: 30,
  MUTEX_RETRY_MIN_MS: 10,
  MUTEX_RETRY_MAX_MS: 30,
} as const;

// Time Constants
export const TIME = {
  MAX_TIME_BOUND_OFFSET_SECONDS: 120,
} as const;

// Simulation-related defaults
export const SIMULATION = {
  DEFAULT_FEE: '100',
  MIN_TIME_BOUND: 0,
  MAX_TIME_BOUND_OFFSET_SECONDS: 120,
  MAX_FUTURE_TIME_BOUND_SECONDS: 120,
} as const;

// Polling for transactionWait
export const POLLING = {
  INTERVAL_MS: 1000,
  TIMEOUT_MS: 25000,
} as const;

export const FEE = {
  // For non-Soroban txs: 100,000 stroops (0.01 XLM) per Stellar best practice
  NON_SOROBAN_FEE: 100_000,
} as const;
