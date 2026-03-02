import { describe, test, expect, vi } from 'vitest';
import type { PluginAPI, Relayer } from '@openzeppelin/relayer-sdk';
import { buildStellarLabTransactionUrl, submitWithFeeBumpAndWait } from '../src/plugin/submit';

describe('submitWithFeeBumpAndWait returnTxHash', () => {
  test('returns raw labUrl (URL only) in failed response when returnTxHash is true', async () => {
    const txHash = 'deadbeef';
    const fundRelayer = {
      sendTransaction: vi.fn().mockResolvedValue({
        id: 'tx-1',
        hash: txHash,
      }),
    } as unknown as Relayer;

    const api = {
      transactionWait: vi.fn().mockResolvedValue({
        id: 'tx-1',
        status: 'failed',
        hash: txHash,
        status_reason: 'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxFailed.',
      }),
    } as unknown as PluginAPI;

    const result = await submitWithFeeBumpAndWait(
      fundRelayer,
      'signed-xdr',
      'testnet',
      1000,
      api,
      undefined,

      { returnTxHash: true }
    );

    expect(result.status).toBe('failed');
    expect(result.error?.labUrl).toBe(buildStellarLabTransactionUrl('testnet', txHash));
    expect(result.error?.reason).toContain('Debug this failure in Stellar Lab (click "Load Transaction")');
  });
});
