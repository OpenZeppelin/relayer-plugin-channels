/**
 * Request-level tests for client errors in a submitted `xdr`: the handler runs
 * with the real validation and parsing, so these fail if it stops mapping a
 * bad envelope to a 400.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginAPI, PluginContext } from '@openzeppelin/relayer-sdk';
import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { handler, clearRelayerInfoCache } from '../src/plugin/handler';
import { FakeKV } from './helpers/fakeKV';

const env = process.env;

describe('handler: invalid xdr', () => {
  let sendTransaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...env, STELLAR_NETWORK: 'testnet', FUND_RELAYER_ID: 'fund-1' };
    delete process.env.FEE_LIMIT;
    clearRelayerInfoCache();
    sendTransaction = vi.fn();
  });
  afterEach(() => {
    process.env = env;
  });

  function submit(xdr: string) {
    const fundRelayer = {
      getRelayer: vi.fn().mockResolvedValue({
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        network_type: 'stellar',
      }),
      sendTransaction,
    };
    const api = { useRelayer: vi.fn().mockReturnValue(fundRelayer) } as unknown as PluginAPI;
    return handler({ api, kv: new FakeKV(), params: { xdr }, headers: {} } as unknown as PluginContext);
  }

  function buildTx() {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(acc, { fee: '100', networkPassphrase: Networks.TESTNET }).setTimeout(30).build();
  }

  test('malformed xdr returns 400 INVALID_XDR and nothing is sent', async () => {
    await expect(submit('not-a-transaction!!')).rejects.toMatchObject({ code: 'INVALID_XDR', status: 400 });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test('a fee-bump envelope returns 400 INVALID_ENVELOPE_TYPE and nothing is sent', async () => {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '200', buildTx(), Networks.TESTNET);

    await expect(submit(feeBump.toXdr())).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_TYPE', status: 400 });
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
