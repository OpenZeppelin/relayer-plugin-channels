import { describe, test, expect } from 'vitest';
import { ChannelPool } from '../src/plugin/pool';
import { FakeKV } from './helpers/fakeKV';

describe('ChannelPool busy mutex', () => {
  test('acquire retries when global mutex is busy, then succeeds', async () => {
    const kv = new FakeKV();
    const pool = new ChannelPool('testnet', kv as any, 30);

    // Configure a single relayer
    await kv.set('testnet:channel:relayer-ids', { relayerIds: ['p1'] });

    // Simulate busy global mutex briefly, then release
    const globalKey = 'testnet:channel-pool-lock';
    await kv.set(globalKey, { token: 'busy' });
    setTimeout(() => {
      void kv.del(globalKey);
    }, 50);

    const lock = await pool.acquire();
    expect(lock.relayerId).toBe('p1');
    // Release for cleanliness
    await pool.release(lock);
  });
});
