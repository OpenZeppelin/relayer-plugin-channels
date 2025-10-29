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
    // Simple, non-reentrant lock for testing; not robust
    if (await this.exists(key)) {
      if (opts?.onBusy === 'skip') return null;
      throw new Error('lock busy');
    }
    // Respect requested TTL to better emulate production behavior
    const ttl = opts?.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : 1;
    await this.set(key, { token: 'lock' }, { ttlSec: ttl });
    try {
      return await fn();
    } finally {
      await this.del(key);
    }
  }

  async listKeys(_pattern?: string): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}
