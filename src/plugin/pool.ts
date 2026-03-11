/**
 * pool.ts
 *
 * KV-backed, stateless channel pool.
 * - Membership comes from KV: <network>:channel:relayer-ids
 * - Per-relayer locks with tokens: <network>:channel:in-use:<relayerId>
 * - Uses per-channel claim locks to make acquire safe across workers.
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
  private readonly channelLockTtlSec: number;
  private readonly kv: PluginKVStore;

  constructor(network: 'testnet' | 'mainnet', kv: PluginKVStore, lockTtlSeconds: number) {
    this.network = network;
    this.kv = kv;
    this.channelLockTtlSec = lockTtlSeconds;
  }

  /** Acquire a relayerId with a token lock */
  async acquire(options: AcquireOptions): Promise<PoolLock> {
    const maxSpins = POOL.ACQUIRE_MAX_SPINS;

    for (let i = 0; i < maxSpins; i++) {
      const result = await this.tryAcquire(options);
      if (result) return result;

      const jitter =
        POOL.ACQUIRE_RETRY_MIN_MS +
        Math.floor(Math.random() * (POOL.ACQUIRE_RETRY_MAX_MS - POOL.ACQUIRE_RETRY_MIN_MS + 1));
      await sleep(jitter);
    }

    const diagnostics = await this.getPoolCapacityDetails(options, maxSpins);
    console.warn('[channels] Pool capacity exhausted', diagnostics);

    throw pluginError('Too many transactions queued. Please try again later', {
      code: 'POOL_CAPACITY',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      details: diagnostics,
    });
  }

  /** Read phase + claim phase (no global mutex) */
  private async tryAcquire(options: AcquireOptions): Promise<PoolLock | null> {
    // --- READ PHASE (no lock) ---
    let ids = await this.getRelayerIdsFromKV();
    if (ids.length === 0) {
      throw pluginError('No channel accounts configured. Use the management API to set channel accounts.', {
        code: 'NO_CHANNELS_CONFIGURED',
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      });
    }

    if (options.contractId && options.limitedContracts.has(options.contractId)) {
      ids = filterChannelsForLimitedContract(ids, options.capacityRatio);
    }

    const lockPrefix = this.lockKeyPrefix();
    let lockedSet: Set<string>;
    let lruMap: Record<string, number>;
    try {
      const [lockedKeys, lruMapRaw] = await Promise.all([
        this.kv.listKeys(`${lockPrefix}*`),
        this.kv.get<Record<string, number>>(this.lruMapKey()),
      ]);
      lruMap = lruMapRaw ?? {};
      lockedSet = new Set(lockedKeys.map(k => k.slice(lockPrefix.length)));
    } catch (err) {
      // Fallback: if listKeys fails, degrade to O(N) per-channel exists checks.
      // This is expensive with many channels — log so persistent failures are observable.
      console.warn('[channels] listKeys failed, falling back to per-channel exists checks', err);
      lruMap = {};
      const results = await Promise.all(ids.map(id => this.kv.exists(this.lockKey(id))));
      lockedSet = new Set(ids.filter((_, i) => results[i]));
    }

    const unlocked = ids.filter(id => !lockedSet.has(id));
    if (unlocked.length === 0) return null;

    // Sort by LRU ascending — oldest channel is always first (deterministic).
    // Shuffle-then-stable-sort: tie-break among equal timestamps is random,
    // spreading contention when multiple channels share the same LRU value.
    shuffle(unlocked);
    unlocked.sort((a, b) => (lruMap[a] ?? 0) - (lruMap[b] ?? 0));
    const candidates = unlocked;

    // --- CLAIM PHASE (per-channel lock) ---
    for (const candidate of candidates) {
      const result = await this.tryClaimChannel(candidate);
      if (result) return result;
    }

    return null;
  }

  /** Attempt to claim a single channel under its per-channel lock */
  private async tryClaimChannel(relayerId: string): Promise<PoolLock | null> {
    return this.kv.withLock(
      this.claimKey(relayerId),
      async () => {
        // Double-check: another worker may have claimed it between our scan and this lock
        if (await this.kv.exists(this.lockKey(relayerId))) return null;

        const token = randomToken();
        await this.kv.set(
          this.lockKey(relayerId),
          { token, lockedAt: new Date().toISOString() },
          { ttlSec: this.channelLockTtlSec },
        );

        // Best-effort LRU update — re-fetch the map to minimize last-writer-wins
        // staleness (the read-phase copy may be many retries old). Concurrent workers
        // claiming different channels can still race on get→set, but the window is
        // narrow. Only affects ordering precision, not claim correctness.
        try {
          const freshLru = await this.kv.get<Record<string, number>>(this.lruMapKey()) ?? {};
          freshLru[relayerId] = Date.now();
          await this.kv.set(this.lruMapKey(), freshLru, { ttlSec: POOL.LRU_MAP_TTL_SECONDS });
        } catch { /* ordering-only */ }

        return { relayerId, token };
      },
      { ttlSec: POOL.CLAIM_LOCK_TTL_SECONDS, onBusy: 'skip' },
    );
  }

  /** Extend the lock TTL if we still own it (e.g. after WAIT_TIMEOUT) */
  async extendLock(lock: PoolLock, ttlSec?: number): Promise<void> {
    try {
      const key = this.lockKey(lock.relayerId);
      const current = await this.kv.get<{ token?: string }>(key);
      if (current?.token === lock.token) {
        await this.kv.set(
          key,
          { ...current, lockedAt: new Date().toISOString() },
          { ttlSec: ttlSec ?? this.channelLockTtlSec }
        );
      }
    } catch {
      // ignore extend errors — lock will expire via TTL
    }
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

  /** Release with cooldown: keeps lock alive with short TTL to hard-block the channel. */
  async releaseWithCooldown(lock: PoolLock, cooldownMs = POOL.CHANNEL_COOLDOWN_MS): Promise<void> {
    try {
      const key = this.lockKey(lock.relayerId);
      const current = await this.kv.get<{ token?: string }>(key);
      if (current?.token === lock.token) {
        const cooldownSec = Math.max(1, Math.ceil(cooldownMs / 1000));
        await this.kv.set(key, current, { ttlSec: cooldownSec });
      }
    } catch {
      // ignore
    }
  }

  private membershipKey(): string {
    return `${this.network}:channel:relayer-ids`;
  }

  private lockKeyPrefix(): string {
    return `${this.network}:channel:in-use:`;
  }

  private lockKey(relayerId: string): string {
    return `${this.lockKeyPrefix()}${relayerId}`;
  }

  private claimKey(relayerId: string): string {
    return `${this.network}:channel:claim:${relayerId}`;
  }

  private lruMapKey(): string {
    return `${this.network}:channel:lru-map`;
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
