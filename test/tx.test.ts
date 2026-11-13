import { describe, test, expect } from 'vitest';
import { TransactionBuilder, Account, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { parseTransactionXdr, validateExistingTransactionForSubmitOnly } from '../src/plugin/tx';

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

  // Without an expiry the transaction stays valid forever and skips the offset limit below
  test.each([
    ['maxTime is 0', () => buildTxWithTimeBounds(passphrase, 0, 0)],
    ['only minTime is set', () => buildTxWithTimeBounds(passphrase, 1, 0)],
  ])('throws TIMEBOUNDS_MISSING when %s', (_name, build) => {
    expect(() => validateExistingTransactionForSubmitOnly(build(), config)).toThrow(
      expect.objectContaining({ code: 'TIMEBOUNDS_MISSING', status: 400 })
    );
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

describe('parseTransactionXdr', () => {
  const passphrase = Networks.TESTNET;

  function buildTx(): Transaction {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(30).build();
  }

  test('parses a regular transaction envelope', () => {
    const tx = buildTx();
    const parsed = parseTransactionXdr(tx.toXdr(), passphrase);
    expect(parsed.hash().toString('hex')).toBe(tx.hash().toString('hex'));
  });

  test.each([
    ['text that is not base64', 'not-a-transaction!!'],
    ['base64 that is not XDR', Buffer.from('hello world').toString('base64')],
    ['a truncated envelope', buildTx().toXdr().slice(0, 40)],
  ])('rejects %s with INVALID_XDR', (_name, input) => {
    expect(() => parseTransactionXdr(input, passphrase)).toThrow(
      expect.objectContaining({ code: 'INVALID_XDR', status: 400 })
    );
  });

  test('rejects a fee-bump envelope with INVALID_ENVELOPE_TYPE', () => {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '200', buildTx(), passphrase);

    expect(() => parseTransactionXdr(feeBump.toXdr(), passphrase)).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVELOPE_TYPE', status: 400 })
    );
  });
});
