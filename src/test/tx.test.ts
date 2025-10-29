import { describe, test, expect } from 'vitest';
import { TransactionBuilder, Account, Networks } from '@stellar/stellar-sdk';
import { validateExistingTransactionForSubmitOnly } from '../tx';

describe('tx validation', () => {
  const passphrase = Networks.TESTNET;

  test('throws on far future timebounds', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(300).build();
    expect(() => validateExistingTransactionForSubmitOnly(tx)).toThrow('too far into the future');
  });

  test('passes on short timeout', () => {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    const tx = new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(30).build();
    const out = validateExistingTransactionForSubmitOnly(tx);
    expect(out).toBe(tx);
  });
});
