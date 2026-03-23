/**
 * pool.ts
 *
 * KV-backed, stateless channel pool.
 * - Membership comes from KV: <network>:channel:relayer-ids
 * - Per-relayer locks with tokens: <network>:channel:in-use:<relayerId>
 * - Uses per-channel claim locks to make acquire safe across workers.
 * - LRU ordering via per-channel keys: <network>:channel:lru:<relayerId>
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
  reason: 'limited_contract_capacity' | 'all_channels_busy_or_claim_contention';
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

    // --- Read state ONCE for the entire retry loop ---
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

    // Shuffle all candidates; batch size scales so every spin covers an
    // equal slice of the pool, guaranteeing full coverage across all spins.
    const candidates = ids.slice();
    shuffle(candidates);

    // Read LRU for a small prefix only (capped at 36) to guide initial ordering.
    // The rest stay in random shuffled order — no extra Redis reads.
    const lruSampleSize = Math.min(candidates.length, maxSpins * POOL.MAX_CLAIMS_PER_SPIN);
    const lruMap = await this.readLruMap(candidates.slice(0, lruSampleSize));
    const prefix = candidates.slice(0, lruSampleSize);
    prefix.sort((a, b) => (lruMap[a] ?? 0) - (lruMap[b] ?? 0));
    for (let j = 0; j < prefix.length; j++) candidates[j] = prefix[j];

    // Batch size: cover the full pool across maxSpins iterations
    const batchSize = Math.max(POOL.MAX_CLAIMS_PER_SPIN, Math.ceil(candidates.length / maxSpins));

    let offset = 0;
    for (let i = 0; i < maxSpins; i++) {
      if (offset >= candidates.length) {
        // Full sweep done — reshuffle for next sweep
        offset = 0;
        shuffle(candidates);
      }

      const batch = candidates.slice(offset, offset + batchSize);
      offset += batchSize;

      const result = await this.tryClaimBatch(batch);
      if (result) return result;

      // Exponential backoff with full jitter
      const baseDelay = Math.min(POOL.ACQUIRE_MAX_DELAY_MS, POOL.ACQUIRE_BASE_DELAY_MS * Math.pow(2, i));
      const jitter = Math.floor(Math.random() * baseDelay);
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

  /** Try to claim one channel from a batch of candidates */
  private async tryClaimBatch(batch: string[]): Promise<PoolLock | null> {
    for (const candidate of batch) {
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
          { ttlSec: this.channelLockTtlSec }
        );

        // Fire-and-forget: LRU is best-effort, don't hold the claim lock for it
        this.updateLru(relayerId);

        return { relayerId, token };
      },
      { ttlSec: POOL.CLAIM_LOCK_TTL_SECONDS, onBusy: 'skip' }
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

  private lockKey(relayerId: string): string {
    return `${this.network}:channel:in-use:${relayerId}`;
  }

  private claimKey(relayerId: string): string {
    return `${this.network}:channel:claim:${relayerId}`;
  }

  private lruKey(relayerId: string): string {
    return `${this.network}:channel:lru:${relayerId}`;
  }

  /** Read per-channel LRU timestamps in parallel (partial failures keep successful reads) */
  private async readLruMap(ids: string[]): Promise<Record<string, number>> {
    const lruMap: Record<string, number> = {};
    const results = await Promise.allSettled(ids.map((id) => this.kv.get<{ ts: number }>(this.lruKey(id))));
    results.forEach((r, i) => {
      lruMap[ids[i]] = r.status === 'fulfilled' ? (r.value?.ts ?? 0) : 0;
    });
    return lruMap;
  }

  /** Fire-and-forget LRU timestamp update for a single channel */
  private updateLru(relayerId: string): void {
    this.kv.set(this.lruKey(relayerId), { ts: Date.now() }, { ttlSec: POOL.LRU_KEY_TTL_SECONDS }).catch((err) => {
      console.debug('[channels] failed to update LRU key', err);
    });
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
      reason: isLimited ? 'limited_contract_capacity' : 'all_channels_busy_or_claim_contention',
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
  const hashes = new Map(ids.map((id) => [id, simpleHash(id)]));
  return ids
    .slice()
    .sort((a, b) => hashes.get(a)! - hashes.get(b)! || a.localeCompare(b))
    .slice(0, k);
}
