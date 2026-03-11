import type { PluginKVStore } from '@openzeppelin/relayer-sdk';

type Entry = { value: any; expiresAt?: number };

export class FakeKV implements PluginKVStore {
  private store = new Map<string, Entry>();

  async get<T = any>(key: string): Promise<T | null> {
    const now = Date.now();
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }
    return e.value as T;
  }

  async set(key: string, value: any, opts?: { ttlSec?: number }): Promise<boolean> {
    const entry: Entry = { value };
    if (opts?.ttlSec && opts.ttlSec > 0) {
      entry.expiresAt = Date.now() + opts.ttlSec * 1000;
    }
    this.store.set(key, entry);
    return true;
  }

  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const v = await this.get(key);
    return v !== null && v !== undefined;
  }

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { ttlSec?: number; onBusy?: 'throw' | 'skip' }
  ): Promise<T | null> {
    // Synchronous check-and-set to simulate atomic lock acquisition.
    // Using await between check and set would allow interleaving in Promise.all.
    const now = Date.now();
    const entry = this.store.get(key);
    const isLocked = entry && (!entry.expiresAt || entry.expiresAt > now);
    if (isLocked) {
      if (opts?.onBusy === 'skip') return null;
      throw new Error('lock busy');
    }
    const ttl = opts?.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : 1;
    this.store.set(key, { value: { token: 'lock' }, expiresAt: now + ttl * 1000 });
    try {
      return await fn();
    } finally {
      this.store.delete(key);
    }
  }

  async listKeys(pattern?: string): Promise<string[]> {
    const now = Date.now();
    const prefix = pattern?.endsWith('*') ? pattern.slice(0, -1) : undefined;
    const keys: string[] = [];
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.store.delete(key);
        continue;
      }
      if (prefix && !key.startsWith(prefix)) continue;
      keys.push(key);
    }
    return keys;
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}
