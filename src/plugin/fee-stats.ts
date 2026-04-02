/**
 * fee-stats.ts
 *
 * Fetches dynamic inclusion fees from Soroban RPC `getFeeStats` with KV-backed
 * caching so all worker processes share the same cached value.
 * On any error, returns `null` so the caller can fall back to static fees.
 */

import type { PluginKVStore, Relayer } from '@openzeppelin/relayer-sdk';

interface FeeStatsCacheEntry {
  fee: number;
  storedAt: number;
}

function cacheKey(network: string, percentile: string): string {
  return `${network}:fee-stats:${percentile}`;
}

/**
 * Fetch the dynamic inclusion fee for the given percentile from Soroban RPC.
 *
 * Returns a KV-cached value when fresh; otherwise calls `getFeeStats` via
 * `relayer.rpc()` and stores the result in KV with a TTL.
 * Returns `null` on any failure so the caller can apply its own fallback logic.
 */
export async function fetchDynamicInclusionFee(
  relayer: Relayer,
  kv: PluginKVStore,
  network: string,
  percentile: string,
  cacheTtlMs: number
): Promise<number | null> {
  const key = cacheKey(network, percentile);
  const cacheTtlSec = Math.max(1, Math.ceil(cacheTtlMs / 1000));

  try {
    const cached = await kv.get<FeeStatsCacheEntry>(key);
    if (cached && Date.now() - cached.storedAt < cacheTtlMs) {
      return cached.fee;
    }
  } catch {
    // KV read failure — proceed to RPC fetch
  }

  try {
    const rpcResponse = await relayer.rpc({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e8).toString(),
      method: 'getFeeStats',
      params: {},
    });

    if (rpcResponse.error) {
      console.warn('[channels] getFeeStats RPC error, falling back to static fee');
      return null;
    }

    const result = rpcResponse.result as { sorobanInclusionFee?: Record<string, string> } | undefined;
    const feeStr = result?.sorobanInclusionFee?.[percentile];

    if (!feeStr) {
      console.warn(`[channels] getFeeStats missing ${percentile}, falling back to static fee`);
      return null;
    }

    const fee = Number(feeStr);
    if (!Number.isFinite(fee) || fee < 0) {
      console.warn(`[channels] getFeeStats invalid value for ${percentile}: ${feeStr}`);
      return null;
    }

    try {
      await kv.set(key, { fee, storedAt: Date.now() } satisfies FeeStatsCacheEntry, { ttlSec: cacheTtlSec });
    } catch {
      // KV write failure is non-fatal — the value was already computed
    }

    console.debug(`[channels] Dynamic inclusion fee: ${fee} stroops (${percentile})`);
    return fee;
  } catch (err: any) {
    console.warn(`[channels] getFeeStats failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
