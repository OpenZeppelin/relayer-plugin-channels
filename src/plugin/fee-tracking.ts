/**
 * fee-tracking.ts
 *
 * API key fee tracking for rate limiting.
 * Supports custom per-key limits with fallback to default.
 * Supports periodic reset of consumption.
 */

import { PluginKVStore, pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';

/** KV data structure for fee consumption */
export interface FeeData {
  consumed: number;
  periodStart?: number;
}

/** Internal state returned by getFeeState */
interface FeeState {
  consumed: number;
  periodStart?: number;
}

/** Usage info returned by getUsageInfo */
export interface UsageInfo {
  consumed: number;
  limit?: number;
  remaining?: number;
  periodStartAt?: string;
  periodEndsAt?: string;
}

/** Configuration for FeeTracker */
export interface FeeTrackerConfig {
  kv: PluginKVStore;
  network: 'testnet' | 'mainnet';
  apiKey: string;
  defaultLimit?: number;
  resetPeriodMs?: number;
}

export class FeeTracker {
  private readonly kv: PluginKVStore;
  private readonly network: 'testnet' | 'mainnet';
  private readonly apiKey: string;
  private readonly defaultLimit?: number;
  private readonly resetPeriodMs?: number;

  constructor(config: FeeTrackerConfig) {
    this.kv = config.kv;
    this.network = config.network;
    this.apiKey = config.apiKey;
    this.defaultLimit = config.defaultLimit;
    this.resetPeriodMs = config.resetPeriodMs;
  }

  // === Public API: Transaction Flow ===

  /**
   * Check if API key can afford the given fee.
   * Throws 429 if not. No-op if unlimited.
   */
  async checkBudget(fee: number): Promise<void> {
    const limit = await this.getEffectiveLimit();
    if (limit === undefined) return;

    const { consumed } = await this.getFeeState();
    if (consumed + fee > limit) {
      const remaining = limit - consumed;
      throw pluginError(
        `Transaction fee (${fee} stroops) exceeds remaining budget (${remaining} stroops). Consumed: ${consumed}/${limit} stroops.`,
        {
          code: 'FEE_LIMIT_EXCEEDED',
          status: HTTP_STATUS.TOO_MANY_REQUESTS,
          details: { consumed, fee, remaining, limit },
        }
      );
    }
  }

  /**
   * Record fee consumption after successful transaction.
   * Errors are logged but not thrown (non-blocking).
   */
  async recordUsage(fee: number): Promise<void> {
    try {
      const state = await this.getFeeState();
      const now = Date.now();

      await this.kv.set(this.consumedKey, {
        consumed: state.consumed + fee,
        periodStart: state.periodStart ?? now,
      });
    } catch (err) {
      console.warn(`[channels] Failed to record fee: ${err}`);
    }
  }

  /**
   * Get complete usage info for management API.
   */
  async getUsageInfo(): Promise<UsageInfo> {
    const [state, limit] = await Promise.all([this.getFeeState(), this.getEffectiveLimit()]);

    return {
      consumed: state.consumed,
      limit,
      remaining: limit !== undefined ? Math.max(0, limit - state.consumed) : undefined,
      periodStartAt: state.periodStart ? new Date(state.periodStart).toISOString() : undefined,
      periodEndsAt:
        state.periodStart && this.resetPeriodMs
          ? new Date(state.periodStart + this.resetPeriodMs).toISOString()
          : undefined,
    };
  }

  /**
   * Get custom limit for this API key.
   */
  async getCustomLimit(): Promise<number | undefined> {
    const data = await this.kv.get<{ limit: number }>(this.limitKey);
    return data?.limit;
  }

  /**
   * Set custom limit for this API key.
   */
  async setCustomLimit(limit: number): Promise<void> {
    await this.kv.set(this.limitKey, { limit });
  }

  /**
   * Delete custom limit for this API key.
   */
  async deleteCustomLimit(): Promise<void> {
    await this.kv.del(this.limitKey);
  }

  // === Private ===

  /**
   * Get effective fee state after applying period expiry.
   * Returns { consumed: 0 } if no data or period expired.
   */
  private async getFeeState(): Promise<FeeState> {
    const data = await this.kv.get<FeeData>(this.consumedKey);

    if (!data || this.isPeriodExpired(data.periodStart)) {
      return { consumed: 0 };
    }
    return data;
  }

  /**
   * Get effective limit (custom ?? default).
   */
  private async getEffectiveLimit(): Promise<number | undefined> {
    const custom = await this.getCustomLimit();
    return custom ?? this.defaultLimit;
  }

  /**
   * Check if period has expired.
   */
  private isPeriodExpired(periodStart?: number): boolean {
    if (!this.resetPeriodMs || !periodStart) return false;
    return Date.now() - periodStart >= this.resetPeriodMs;
  }

  private get consumedKey(): string {
    return `${this.network}:api-key-fees:${this.apiKey}`;
  }

  private get limitKey(): string {
    return `${this.network}:api-key-limit:${this.apiKey}`;
  }
}
