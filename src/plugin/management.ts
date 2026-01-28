/**
 * management.ts
 *
 * Payload-based management API for channel relayerIds and fee limits.
 * - listChannelAccounts: returns relayerIds from KV
 * - setChannelAccounts: replaces relayerIds array in KV (checks lock conflicts)
 * - getFeeUsage: returns fee consumption for an API key
 * - getFeeLimit: returns custom limit for an API key (if set)
 * - setFeeLimit: sets custom limit for an API key
 * - deleteFeeLimit: removes custom limit for an API key
 */

import type { PluginContext, PluginKVStore } from '@openzeppelin/relayer-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { loadConfig } from './config';
import { HTTP_STATUS } from './constants';
import { FeeTracker } from './fee-tracking';

export function isManagementRequest(params: any): boolean {
  return Boolean(
    params && typeof params === 'object' && (params as any).management && typeof (params as any).management === 'object'
  );
}

export async function handleManagement(context: PluginContext): Promise<any> {
  const { kv, params } = context;
  const config = loadConfig();

  if (!config.adminSecret) {
    throw pluginError('Management API disabled', {
      code: 'MANAGEMENT_DISABLED',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }

  const m = params?.management || {};
  const provided = (m.adminSecret ?? '').toString();
  if (!provided || provided !== config.adminSecret) {
    throw pluginError('Unauthorized', { code: 'UNAUTHORIZED', status: HTTP_STATUS.UNAUTHORIZED });
  }

  const action = String(m.action || '');
  switch (action) {
    case 'listChannelAccounts':
      return await listChannelAccounts(kv, config.network);
    case 'setChannelAccounts':
      return await setChannelAccounts(kv, config.network, m);
    case 'getFeeUsage':
      return await getFeeUsage(kv, config.network, config.feeLimit, config.feeResetPeriodMs, m);
    case 'getFeeLimit':
      return await getFeeLimit(kv, config.network, config.feeLimit, m);
    case 'setFeeLimit':
      return await setFeeLimit(kv, config.network, m);
    case 'deleteFeeLimit':
      return await deleteFeeLimit(kv, config.network, m);
    default:
      throw pluginError('Invalid management action', { code: 'INVALID_ACTION', status: HTTP_STATUS.BAD_REQUEST });
  }
}

async function listChannelAccounts(kv: PluginKVStore, network: 'testnet' | 'mainnet'): Promise<any> {
  const key = `${network}:channel:relayer-ids`;
  try {
    const doc: any = await (kv as any).get?.(key);
    const relayerIds: string[] = Array.isArray(doc?.relayerIds) ? doc.relayerIds.map(normalizeId) : [];
    return { relayerIds };
  } catch (e: any) {
    throw pluginError('KV error while listing channel accounts', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

async function getFeeUsage(
  kv: PluginKVStore,
  network: 'testnet' | 'mainnet',
  defaultLimit: number | undefined,
  resetPeriodMs: number | undefined,
  payload: any
): Promise<any> {
  const apiKey = payload?.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    throw pluginError('Invalid payload: apiKey is required', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  try {
    const tracker = new FeeTracker({ kv, network, apiKey, defaultLimit, resetPeriodMs });
    return await tracker.getUsageInfo();
  } catch (e: any) {
    throw pluginError('KV error while reading fee usage', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

async function getFeeLimit(
  kv: PluginKVStore,
  network: 'testnet' | 'mainnet',
  defaultLimit: number | undefined,
  payload: any
): Promise<any> {
  const apiKey = payload?.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    throw pluginError('Invalid payload: apiKey is required', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  try {
    const tracker = new FeeTracker({ kv, network, apiKey, defaultLimit });
    const customLimit = await tracker.getCustomLimit();
    return {
      limit: customLimit ?? defaultLimit,
    };
  } catch (e: any) {
    throw pluginError('KV error while reading fee limit', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

async function setFeeLimit(kv: PluginKVStore, network: 'testnet' | 'mainnet', payload: any): Promise<any> {
  const apiKey = payload?.apiKey;
  const limit = payload?.limit;

  if (!apiKey || typeof apiKey !== 'string') {
    throw pluginError('Invalid payload: apiKey is required', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw pluginError('Invalid payload: limit must be a non-negative number', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  try {
    const tracker = new FeeTracker({ kv, network, apiKey });
    await tracker.setCustomLimit(Math.floor(limit));
    return { ok: true, limit: Math.floor(limit) };
  } catch (e: any) {
    throw pluginError('KV error while setting fee limit', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

async function deleteFeeLimit(kv: PluginKVStore, network: 'testnet' | 'mainnet', payload: any): Promise<any> {
  const apiKey = payload?.apiKey;

  if (!apiKey || typeof apiKey !== 'string') {
    throw pluginError('Invalid payload: apiKey is required', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  try {
    const tracker = new FeeTracker({ kv, network, apiKey });
    await tracker.deleteCustomLimit();
    return { ok: true };
  } catch (e: any) {
    throw pluginError('KV error while deleting fee limit', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

async function setChannelAccounts(kv: PluginKVStore, network: 'testnet' | 'mainnet', payload: any): Promise<any> {
  const incoming = payload?.relayerIds;
  if (!Array.isArray(incoming)) {
    throw pluginError('Invalid payload: relayerIds must be an array', {
      code: 'INVALID_PAYLOAD',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }
  // Normalize, validate, unique
  const relayerIds = unique(incoming.map(normalizeId).filter(validRelayerId));

  // Read current
  const listKey = `${network}:channel:relayer-ids`;
  const current = await readStoredRelayerIds(kv, listKey);

  // Check for locked removals
  const removals = current.filter((id) => !relayerIds.includes(id));
  const locked: string[] = [];
  for (const id of removals) {
    if (await isRelayerIdLocked(kv, network, id)) {
      locked.push(id);
    }
  }
  if (locked.length > 0) {
    throw pluginError('Locked relayer IDs cannot be removed', {
      code: 'LOCKED_CONFLICT',
      status: HTTP_STATUS.CONFLICT,
      details: { locked },
    });
  }

  // Write new list
  try {
    await kv.set(listKey, { relayerIds });
    return { ok: true, appliedRelayerIds: relayerIds };
  } catch (e: any) {
    throw pluginError('KV error while saving channel accounts', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
}

function normalizeId(id: string): string {
  return String(id).trim().toLowerCase();
}

function validRelayerId(id: string): boolean {
  if (!id) return false;
  if (id.length > 128) return false;
  return /^[a-z0-9:_-]+$/.test(id);
}

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

async function readStoredRelayerIds(kv: PluginKVStore, key: string): Promise<string[]> {
  try {
    const doc: any = await (kv as any).get?.(key);
    return Array.isArray(doc?.relayerIds) ? doc.relayerIds.map(normalizeId) : [];
  } catch (error) {
    throw pluginError('KV error while reading channel accounts', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: { key, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function isRelayerIdLocked(kv: PluginKVStore, network: 'testnet' | 'mainnet', id: string): Promise<boolean> {
  const key = `${network}:channel:in-use:${id}`;
  try {
    return await kv.exists(key);
  } catch (error) {
    throw pluginError('KV error while checking relayer lock', {
      code: 'KV_ERROR',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: { relayerId: id, key, message: error instanceof Error ? error.message : String(error) },
    });
  }
}
