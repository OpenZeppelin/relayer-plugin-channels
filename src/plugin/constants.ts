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
  UNPROCESSABLE_ENTITY: 422,
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
  MAX_LOCK_TTL_SECONDS: 60,
  DEFAULT_CONTRACT_CAPACITY_RATIO: 0.8,
  DEFAULT_SEQUENCE_NUMBER_CACHE_MAX_AGE_MS: 120_000,
  DEFAULT_MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER: 2,
} as const;

// Pool Constants
export const POOL = {
  // Per-channel claim lock TTL — must exceed worst-case callback latency
  // to prevent TTL expiry allowing a second worker into the same claim section
  CLAIM_LOCK_TTL_SECONDS: 3,
  // Retry policy: exponential backoff with full jitter
  ACQUIRE_MAX_SPINS: 12,
  ACQUIRE_BASE_DELAY_MS: 25,
  ACQUIRE_MAX_DELAY_MS: 500,
  // Max claim-lock attempts per spin (batch size)
  MAX_CLAIMS_PER_SPIN: 3,
  // Attempts to take a channel's claim lock when renewing its lock
  RENEW_MAX_ATTEMPTS: 20,
  // Hard-block cooldown for uncertain-outcome channels (~1 Stellar ledger with margin)
  CHANNEL_COOLDOWN_MS: 6_000,
  // Housekeeping TTL for per-channel LRU keys
  LRU_KEY_TTL_SECONDS: 86_400,
} as const;

// Relayer info cache — address and network_type are effectively immutable
export const RELAYER_INFO_CACHE_TTL_SECONDS = 1_800; // 30 minutes

// Time constants — used for both simulation tx construction and incoming tx validation
export const TIME = {
  MIN_TIME_BOUND: 0,
  MAX_TIME_BOUND_OFFSET_SECONDS: 60,
} as const;

// Simulation-related defaults
export const SIMULATION = {
  DEFAULT_FEE: '100',
  SIMULATION_AUTH_MODE: 'enforce',
  /** Minimum ledger margin required between latestLedger and auth signatureExpirationLedger. Must be > 1 since simulation already validates 1 ledger of validity. ~10s at ~5s/ledger. */
  MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER: 2,
} as const;

// Global plugin timeout budget
export const TIMEOUT = {
  DEFAULT_GLOBAL_TIMEOUT_MS: 30_000,
  BUFFER_MS: 2_000,
} as const;

// Idempotency-Key support for submissions
export const IDEMPOTENCY = {
  /** Header name, matched case-insensitively */
  HEADER: 'idempotency-key',
  MAX_KEY_LENGTH: 255,
  /**
   * Default for how long a key keeps returning its transaction
   * (IDEMPOTENCY_KEY_TTL_SECONDS). A key only needs to outlive its
   * transaction's time bounds and the send reply window.
   */
  TTL_SECONDS: 3_600,
  /** Comfortably past the reservation window (request budget plus max time bounds) */
  MIN_TTL_SECONDS: 300,
  /** Lock held only while reading or updating a key's record */
  LOCK_TTL_SECONDS: 5,
  /**
   * How long after requesting a record's lock a write may still start. Well
   * under LOCK_TTL_SECONDS, so the write lands before the lock can expire
   */
  LOCK_WRITE_BUDGET_MS: 2_000,
  /** Attempts to take a record's lock before giving up */
  RECORD_LOCK_ATTEMPTS: 10,
  /** The plugin runtime's socket timeout (30s) plus margin: a send's reply can arrive this long after it started */
  SEND_REPLY_WINDOW_MS: 35_000,
  /** How long a fee marker outlives its record, for clock drift between workers */
  FEE_MARKER_MARGIN_SECONDS: 300,
  /**
   * Margin past a stored transaction's maxTime before it counts as expired:
   * validators compare maxTime with the ledger close time, which can trail
   * this clock by a few ledgers
   */
  EXPIRY_MARGIN_MS: 30_000,
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

// Dynamic fee estimation defaults
export const DYNAMIC_FEE = {
  DEFAULT_PERCENTILE: 'p50' as const,
  DEFAULT_CACHE_TTL_MS: 10_000,
  VALID_PERCENTILES: ['p10', 'p20', 'p30', 'p40', 'p50', 'p60', 'p70', 'p80', 'p90', 'p95', 'p99'] as const,
  // Margins above the fee-bump minimum (BASE_FEE * 2) to avoid landing exactly
  // at the protocol floor. Used by both static defaults and dynamic fee computation.
  FEE_BUMP_MARGIN_DEFAULT: 3,
  FEE_BUMP_MARGIN_LIMITED: 1,
} as const;
