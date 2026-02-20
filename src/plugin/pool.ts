/**
 * pool.ts
 *
 * KV-backed, stateless channel pool.
 * - Membership comes from KV: <network>:channel:relayer-ids
 * - Per-relayer locks with tokens: <network>:channel:in-use:<relayerId>
 * - Uses a short global mutex to make acquire atomic across workers.
 */

import { PluginKVStore, pluginError } from '@openzeppelin/relayer-sdk';
import crypto from 'crypto';
import { HTTP_STATUS, POOL } from './constants';

export type PoolLock = { relayerId: string; token: string };

export type AcquireOptions = {
  contractId?: string;
  limitedContracts: Set<string>;
  capacityRatio: number;
};

type MembershipDoc = { relayerIds: string[] };
type PoolCapacityDetails = {
  reason: 'limited_contract_capacity' | 'all_channels_busy_or_mutex_contention';
  contractId?: string;
  capacityRatio: number;
  maxSpins: number;
};

export class ChannelPool {
  private readonly network: 'testnet' | 'mainnet';
  private readonly globalLockKey: string;
  private readonly channelLockTtlSec: number;
  private readonly mutexTtlSec: number;
  private readonly kv: PluginKVStore;

  constructor(network: 'testnet' | 'mainnet', kv: PluginKVStore, lockTtlSeconds: number) {
    this.network = network;
    this.kv = kv;
    this.globalLockKey = `${this.network}:channel-pool-lock`;
    this.channelLockTtlSec = lockTtlSeconds;
    this.mutexTtlSec = POOL.MUTEX_TTL_SECONDS;
  }

  /** Acquire a relayerId with a token lock */
  async acquire(options: AcquireOptions): Promise<PoolLock> {
    const maxSpins = POOL.MUTEX_MAX_SPINS;

    for (let i = 0; i < maxSpins; i++) {
      const r = await this.withGlobalMutex(() => this.tryLockAnyRelayer(options));
      if (r === null) {
        const jitter =
          POOL.MUTEX_RETRY_MIN_MS + Math.floor(Math.random() * (POOL.MUTEX_RETRY_MAX_MS - POOL.MUTEX_RETRY_MIN_MS + 1));
        await sleep(jitter);
        continue;
      }
      return r;
    }

    const diagnostics = await this.getPoolCapacityDetails(options, maxSpins);
    if (diagnostics.reason === 'limited_contract_capacity') {
      console.error(`[channels] Pool capacity exhausted for limited contract`);
    } else {
      console.error(`[channels] Pool capacity exhausted for non-limited contract`);
    }

    throw pluginError('Too many transactions queued. Please try again later', {
      code: 'POOL_CAPACITY',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      details: diagnostics,
    });
  }

  // Run a function under the short-lived global mutex; returns null if busy
  private async withGlobalMutex<T>(fn: () => Promise<T>): Promise<T | null> {
    return this.kv.withLock(this.globalLockKey, fn, { ttlSec: this.mutexTtlSec, onBusy: 'skip' });
  }

  // Inside the mutex: pick an available relayer and set its channel lock
  private async tryLockAnyRelayer(options: AcquireOptions): Promise<PoolLock | null> {
    let ids = await this.getRelayerIdsFromKV();
    if (ids.length === 0) {
      throw pluginError('No channel accounts configured. Use the management API to set channel accounts.', {
        code: 'NO_CHANNELS_CONFIGURED',
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      });
    }

    // If contract is limited, filter to allowed subset
    if (options.contractId && options.limitedContracts.has(options.contractId)) {
      ids = filterChannelsForLimitedContract(ids, options.capacityRatio);
    }

    shuffle(ids);
    for (const relayerId of ids) {
      const key = this.lockKey(relayerId);
      const exists = await this.kv.exists(key);
      if (exists) continue;
      const token = randomToken();
      const entry = { token, lockedAt: new Date().toISOString() };
      await this.kv.set(key, entry, { ttlSec: this.channelLockTtlSec });
      return { relayerId, token };
    }
    return null;
  }

  /** Release the lock if we own it */
  async release(lock: PoolLock): Promise<void> {
    try {
      const key = this.lockKey(lock.relayerId);
      const current = await this.kv.get<{ token?: string }>(key);
      if (current?.token === lock.token) {
        await this.kv.del(key);
      }
    } catch {
      // ignore release errors
    }
  }

  private membershipKey(): string {
    return `${this.network}:channel:relayer-ids`;
  }

  private lockKey(relayerId: string): string {
    return `${this.network}:channel:in-use:${relayerId}`;
  }

  private async getRelayerIdsFromKV(): Promise<string[]> {
    try {
      const doc = await this.kv.get<MembershipDoc>(this.membershipKey());
      if (!doc || !Array.isArray(doc.relayerIds)) return [];
      // Normalize and unique
      const set = new Set<string>(doc.relayerIds.map(normalizeId));
      return Array.from(set.values());
    } catch {
      return [];
    }
  }

  private async getPoolCapacityDetails(options: AcquireOptions, maxSpins: number): Promise<PoolCapacityDetails> {
    const isLimited = !!(options.contractId && options.limitedContracts.has(options.contractId));

    return {
      reason: isLimited ? 'limited_contract_capacity' : 'all_channels_busy_or_mutex_contention',
      contractId: options.contractId,
      capacityRatio: options.capacityRatio,
      maxSpins,
    };
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function randomToken(): string {
  try {
    return crypto.randomBytes(16).toString('hex');
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

function normalizeId(id: string): string {
  return String(id).trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Simple hash for deterministic channel partitioning.
 * Returns a number 0-99 for modulo-based filtering.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % 100;
}

/**
 * Filter channels for limited contracts using deterministic partitioning.
 * Returns exactly floor(ratio * N) channels, sorted by hash for stability.
 * Always returns at least 1 channel (min guarantee).
 */
function filterChannelsForLimitedContract(ids: string[], ratio: number): string[] {
  const k = Math.max(1, Math.floor(ratio * ids.length));
  return ids
    .slice()
    .sort((a, b) => simpleHash(a) - simpleHash(b) || a.localeCompare(b))
    .slice(0, k);
}
