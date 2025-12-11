import { describe, test, expect } from 'vitest';
import { calculateMaxFee } from '../src/plugin/fee';
import { TransactionBuilder, Account, Networks } from '@stellar/stellar-sdk';
import { FEE } from '../src/plugin/constants';

describe('fee', () => {
  const passphrase = Networks.TESTNET;

  function buildSimpleTx(): any {
    const acc = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(acc, { fee: '100', networkPassphrase: passphrase }).setTimeout(30).build();
  }

  test('non-soroban uses NON_SOROBAN_FEE + base inclusion', () => {
    const orig = Math.random;
    Math.random = () => 0; // pick min base fee (205)
    const tx = buildSimpleTx();
    const fee = calculateMaxFee(tx);
    // NON_SOROBAN_FEE (100,000) + MIN_BASE_FEE (205) = 100,205
    expect(fee).toBe(FEE.NON_SOROBAN_FEE + FEE.MIN_BASE_FEE);
    Math.random = orig;
  });

  test('non-soroban fee is within expected range', () => {
    const tx = buildSimpleTx();
    const fee = calculateMaxFee(tx);
    // Should be NON_SOROBAN_FEE + random(MIN_BASE_FEE, MAX_BASE_FEE)
    expect(fee).toBeGreaterThanOrEqual(FEE.NON_SOROBAN_FEE + FEE.MIN_BASE_FEE);
    expect(fee).toBeLessThanOrEqual(FEE.NON_SOROBAN_FEE + FEE.MAX_BASE_FEE);
  });
});
