/**
 * sequence.ts
 *
 * KV-based sequence number cache for channel accounts.
 * After a transaction is confirmed on-chain, the RPC `getLedgerEntries` can
 * still return the old (pre-increment) sequence number due to read-after-write
 * lag.  Caching the next expected sequence in KV avoids `tx_bad_seq` errors.
 */

import { pluginError } from '@openzeppelin/relayer-sdk';
import type { PluginKVStore, Relayer } from '@openzeppelin/relayer-sdk';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { HTTP_STATUS } from './constants';

type LedgerEntryRpcItem = { xdr?: unknown };
type LedgerEntriesRpcResult = { entries?: LedgerEntryRpcItem[] };

/** Max age (ms) before cached sequence is considered stale and re-fetched from chain. */
const SEQ_CACHE_MAX_AGE_MS = 120_000;

interface SeqCacheEntry {
  sequence: string;
  storedAt: number;
}

function seqKey(network: string, address: string): string {
  return `${network}:channel:seq:${address}`;
}

export async function getAccountSequence(relayer: Relayer, address: string): Promise<string> {
  let accountKey: xdr.LedgerKey;
  try {
    accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
      })
    );
  } catch (error) {
    console.error('[channels] Sequence fetch failed', {
      event: 'invalid_channel_account_address',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
      message: error instanceof Error ? error.message : String(error),
    });
    throw pluginError('Invalid channel account address', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { address, message: error instanceof Error ? error.message : String(error) },
    });
  }

  let response;
  try {
    response = await relayer.rpc({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e8).toString(),
      method: 'getLedgerEntries',
      params: {
        keys: [accountKey.toXDR('base64')],
      },
    });
  } catch (error) {
    console.error('[channels] Sequence fetch failed', {
      event: 'sequence_rpc_request_failed',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
      message: error instanceof Error ? error.message : String(error),
    });
    throw pluginError('Failed to get sequence from channel relayer', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  if (response.error) {
    console.error('[channels] Sequence fetch failed', {
      event: 'sequence_rpc_error_response',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
      message: response.error.message,
    });
    throw pluginError('Failed to get sequence from channel relayer', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: response.error.message },
    });
  }

  const result = response.result as LedgerEntriesRpcResult | null | undefined;
  const entries = result?.entries;
  if (!Array.isArray(entries)) {
    console.error('[channels] Sequence fetch failed', {
      event: 'sequence_rpc_invalid_result_shape',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
    });
    throw pluginError('Invalid RPC response for account sequence', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { address },
    });
  }

  if (!entries || entries.length === 0) {
    console.warn('[channels] Sequence fetch returned no account entries', {
      event: 'sequence_account_not_found',
      code: 'ACCOUNT_NOT_FOUND',
      address,
    });
    throw pluginError('Channel account not found on ledger', {
      code: 'ACCOUNT_NOT_FOUND',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { address },
    });
  }

  const firstEntryXdr = entries[0]?.xdr;
  if (typeof firstEntryXdr !== 'string') {
    console.error('[channels] Sequence fetch failed', {
      event: 'sequence_rpc_invalid_entry_xdr',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
    });
    throw pluginError('Invalid RPC response for account sequence', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { address },
    });
  }

  try {
    const accountEntry = xdr.LedgerEntryData.fromXDR(firstEntryXdr, 'base64');
    return accountEntry.account().seqNum().toString();
  } catch (error) {
    console.error('[channels] Sequence fetch failed', {
      event: 'sequence_xdr_decode_failed',
      code: 'FAILED_TO_GET_SEQUENCE',
      address,
      message: error instanceof Error ? error.message : String(error),
    });
    throw pluginError('Failed to decode account sequence from ledger entry', {
      code: 'FAILED_TO_GET_SEQUENCE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { address, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Get the current sequence number for a channel account.
 * Reads from KV cache first; falls back to chain via `getAccountSequence`.
 */
export async function getSequence(
  kv: PluginKVStore,
  network: string,
  relayer: Relayer,
  address: string
): Promise<string> {
  const key = seqKey(network, address);
  const cached = await kv.get<SeqCacheEntry>(key);
  if (cached?.sequence) {
    const age = Date.now() - (cached.storedAt ?? 0);
    if (age < SEQ_CACHE_MAX_AGE_MS) {
      console.debug(`[channels] Sequence cache hit: address=${address}, seq=${cached.sequence}, age=${age}ms`);
      return cached.sequence;
    }
    console.debug(`[channels] Sequence cache stale: address=${address}, age=${age}ms, refetching`);
  }
  return getAccountSequence(relayer, address);
}

/**
 * Store the next expected sequence number in KV after a transaction
 * has been confirmed on-chain.
 */
export async function commitSequence(
  kv: PluginKVStore,
  network: string,
  address: string,
  usedSequence: string
): Promise<void> {
  const next = (BigInt(usedSequence) + 1n).toString();
  const key = seqKey(network, address);
  try {
    await kv.set(key, { sequence: next, storedAt: Date.now() } satisfies SeqCacheEntry);
    console.debug(`[channels] Sequence committed: address=${address}, next=${next}`);
  } catch (err) {
    console.warn(`[channels] Failed to commit sequence to KV`, {
      address,
      next,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Clear cached sequence — forces a re-fetch from chain on next request.
 * Used when transaction outcome is uncertain (e.g. timeout).
 */
export async function clearSequence(kv: PluginKVStore, network: string, address: string): Promise<void> {
  const key = seqKey(network, address);
  try {
    await kv.del(key);
    console.debug(`[channels] Sequence cleared: address=${address}`);
  } catch (err) {
    console.warn(`[channels] Failed to clear sequence from KV`, {
      address,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
