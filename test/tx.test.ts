import { describe, test, expect } from 'vitest';
import { TransactionBuilder, Account, Networks, Transaction } from '@stellar/stellar-sdk';
import { validateExistingTransactionForSubmitOnly } from '../src/plugin/tx';

function buildTxWithTimeBounds(passphrase: string, minTime: number, maxTime: number): Transaction {
  const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
  const builder = new TransactionBuilder(acc, {
    fee: '100',
    networkPassphrase: passphrase,
    timebounds: { minTime, maxTime },
  });
  return builder.build();
}

describe('tx validation', () => {
  const passphrase = Networks.TESTNET;
  const config = { maxTimeBoundOffsetSeconds: 60 };

  test('throws on far future timebounds', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(300).build();
    expect(() => validateExistingTransactionForSubmitOnly(tx, config)).toThrow('too far into the future');
  });

  test('throws on expired timebounds', () => {
    const pastTime = Math.floor(Date.now() / 1000) - 60;
    const tx = buildTxWithTimeBounds(passphrase, 0, pastTime);
    expect(() => validateExistingTransactionForSubmitOnly(tx, config)).toThrow('expired');
  });

  test('passes on short timeout', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(30).build();
    const out = validateExistingTransactionForSubmitOnly(tx, config);
    expect(out).toBe(tx);
  });

  test('accepts 90s timeout when override allows 120s', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(90).build();
    const out = validateExistingTransactionForSubmitOnly(tx, { maxTimeBoundOffsetSeconds: 120 });
    expect(out).toBe(tx);
  });

  test('rejects 90s timeout when default 60s is used', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(90).build();
    expect(() => validateExistingTransactionForSubmitOnly(tx, config)).toThrow('too far into the future');
  });
});
