import { describe, test, expect } from 'vitest';
import { TransactionBuilder, Account, Networks, Contract, Operation, Asset, xdr } from '@stellar/stellar-sdk';
import { extractFuncAuthFromUnsignedXdr } from '../src/plugin/handler';

describe('extractFuncAuthFromUnsignedXdr', () => {
  const passphrase = Networks.TESTNET;
  const sourceAccount = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');

  test('extracts func and auth from unsigned invokeHostFunction transaction', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('test_method', xdr.ScVal.scvU32(42));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const result = extractFuncAuthFromUnsignedXdr(tx);

    expect(result).not.toBeNull();
    expect(result!.func).toBeDefined();
    expect(result!.auth).toBeDefined();
    expect(Array.isArray(result!.auth)).toBe(true);
  });

  test('returns null for non-invokeHostFunction operation', () => {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: passphrase,
    })
      .addOperation(
        Operation.payment({
          destination: 'GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON',
          asset: Asset.native(),
          amount: '100',
        })
      )
      .setTimeout(30)
      .build();

    const result = extractFuncAuthFromUnsignedXdr(tx);

    expect(result).toBeNull();
  });

  test('returns null for transaction with multiple operations', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op1 = contract.call('method1', xdr.ScVal.scvU32(1));
    const op2 = contract.call('method2', xdr.ScVal.scvU32(2));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '200',
      networkPassphrase: passphrase,
    })
      .addOperation(op1)
      .addOperation(op2)
      .setTimeout(30)
      .build();

    const result = extractFuncAuthFromUnsignedXdr(tx);

    expect(result).toBeNull();
  });
});
