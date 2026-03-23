import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getCachedRelayerInfo, clearRelayerInfoCache } from '../src/plugin/handler';

function fakeRelayer(address: string, network_type = 'stellar') {
  return {
    getRelayer: vi.fn().mockResolvedValue({ address, network_type }),
  };
}

describe('getCachedRelayerInfo', () => {
  beforeEach(() => {
    clearRelayerInfoCache();
  });

  test('calls getRelayer on cache miss and returns info', async () => {
    const relayer = fakeRelayer('GABC123', 'stellar');

    const info = await getCachedRelayerInfo('testnet', 'r-miss-1', relayer as any);

    expect(info).toEqual({ address: 'GABC123', network_type: 'stellar' });
    expect(relayer.getRelayer).toHaveBeenCalledTimes(1);
  });

  test('returns cached value without calling getRelayer on cache hit', async () => {
    const relayer1 = fakeRelayer('GABC456', 'stellar');
    const relayer2 = fakeRelayer('GABC456', 'stellar');

    // First call populates cache
    await getCachedRelayerInfo('testnet', 'r-hit-1', relayer1 as any);
    // Second call should use cache
    const info = await getCachedRelayerInfo('testnet', 'r-hit-1', relayer2 as any);

    expect(info).toEqual({ address: 'GABC456', network_type: 'stellar' });
    expect(relayer2.getRelayer).not.toHaveBeenCalled();
  });

  test('returns null when getRelayer returns no address', async () => {
    const relayer = { getRelayer: vi.fn().mockResolvedValue({ network_type: 'stellar' }) };

    const info = await getCachedRelayerInfo('testnet', 'r-null-1', relayer as any);
    expect(info).toBeNull();
  });
});
