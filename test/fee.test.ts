import { describe, test, expect } from 'vitest';
import { calculateMaxFee, KALE_CONTRACT, INCLUSION_FEE_DEFAULT, INCLUSION_FEE_KALE } from '../src/plugin/fee';
import { TransactionBuilder, Account, Networks, BASE_FEE, Contract, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { FEE } from '../src/plugin/constants';

describe('fee', () => {
  const passphrase = Networks.TESTNET;
  const sourceAccount = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
  const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  function buildSimpleTx(): any {
    return new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: passphrase }).setTimeout(30).build();
  }

  function buildContractCallTx(contractAddress: string): any {
    const contract = new Contract(contractAddress);
    const op = contract.call('test_method');
    return new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: passphrase })
      .addOperation(op)
      .setTimeout(30)
      .build();
  }

  function buildSorobanTxWithResourceFee(resourceFee: bigint): any {
    const contract = new Contract(OTHER_CONTRACT);
    const op = contract.call('test_method');
    const sorobanData = new SorobanDataBuilder().setResourceFee(resourceFee).build();
    return new TransactionBuilder(sourceAccount, {
      fee: resourceFee.toString(),
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setSorobanData(sorobanData)
      .setTimeout(30)
      .build();
  }

  describe('inclusion fee constants', () => {
    test('default inclusion fee matches launchtube (BASE_FEE * 2 + 3 = 203)', () => {
      expect(INCLUSION_FEE_DEFAULT).toBe(203);
      expect(INCLUSION_FEE_DEFAULT).toBe(Number(BASE_FEE) * 2 + 3);
    });

    test('KALE inclusion fee matches launchtube (BASE_FEE * 2 + 1 = 201)', () => {
      expect(INCLUSION_FEE_KALE).toBe(201);
      expect(INCLUSION_FEE_KALE).toBe(Number(BASE_FEE) * 2 + 1);
    });
  });

  describe('non-Soroban transactions', () => {
    test('uses NON_SOROBAN_FEE + default inclusion fee', () => {
      const tx = buildSimpleTx();
      const fee = calculateMaxFee(tx);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + INCLUSION_FEE_DEFAULT);
    });
  });

  describe('Soroban transactions', () => {
    test('adds default inclusion fee to resourceFee', () => {
      const resourceFee = 50000n;
      const tx = buildSorobanTxWithResourceFee(resourceFee);
      const fee = calculateMaxFee(tx);
      expect(fee).toBe(Number(resourceFee) + INCLUSION_FEE_DEFAULT);
    });

    test('non-KALE contract gets default inclusion fee (203)', () => {
      const tx = buildContractCallTx(OTHER_CONTRACT);
      const fee = calculateMaxFee(tx);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + INCLUSION_FEE_DEFAULT);
    });

    test('KALE contract gets reduced inclusion fee (201)', () => {
      const tx = buildContractCallTx(KALE_CONTRACT);
      const fee = calculateMaxFee(tx);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + INCLUSION_FEE_KALE);
    });
  });
});
