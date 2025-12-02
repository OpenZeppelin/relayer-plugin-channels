/**
 * fee-tracking.ts
 *
 * API key fee tracking for rate limiting.
 */

import { PluginKVStore, pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';

export class FeeTracker {
  constructor(
    private readonly kv: PluginKVStore,
    private readonly network: 'testnet' | 'mainnet',
    private readonly apiKey: string,
    private readonly feeLimit: number
  ) {}

  private get key(): string {
    return FeeTracker.buildKey(this.network, this.apiKey);
  }

  static buildKey(network: 'testnet' | 'mainnet', apiKey: string): string {
    return `${network}:api-key-fees:${apiKey}`;
  }

  /**
   * Get fee consumption for an API key (for management API).
   */
  static async getConsumed(
    kv: PluginKVStore,
    network: 'testnet' | 'mainnet',
    apiKey: string
  ): Promise<number> {
    const key = FeeTracker.buildKey(network, apiKey);
    const data = await kv.get<{ consumed: number }>(key);
    return data?.consumed ?? 0;
  }

  /**
   * Check if the API key has exceeded its fee limit.
   * Throws 429 if limit exceeded.
   */
  async checkLimit(): Promise<void> {
    const data = await this.kv.get<{ consumed: number }>(this.key);
    const consumed = data?.consumed ?? 0;
    if (consumed >= this.feeLimit) {
      throw pluginError('API key fee limit exceeded', {
        code: 'FEE_LIMIT_EXCEEDED',
        status: HTTP_STATUS.TOO_MANY_REQUESTS,
        details: { consumed, limit: this.feeLimit },
      });
    }
  }

  /**
   * Record fee consumption for this API key.
   * Errors are logged but don't throw (non-blocking).
   */
  async trackConsumed(fee: number): Promise<void> {
    try {
      const data = await this.kv.get<{ consumed: number }>(this.key);
      const current = data?.consumed ?? 0;
      await this.kv.set(this.key, { consumed: current + fee });
    } catch (err) {
      console.warn(`[channels] Failed to track fee for API key: ${err}`);
    }
  }
}
