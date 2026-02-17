import { describe, test, expect } from 'vitest';
import { calculateMaxFee, InclusionFees } from '../src/plugin/fee';
import { TransactionBuilder, Account, Networks, BASE_FEE, Contract, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { FEE } from '../src/plugin/constants';

describe('fee', () => {
  const passphrase = Networks.TESTNET;
  const sourceAccount = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
  const LIMITED_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const OTHER_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';

  const DEFAULT_FEES: InclusionFees = {
    inclusionFeeDefault: Number(BASE_FEE) * 2 + 3, // 203
    inclusionFeeLimited: Number(BASE_FEE) * 2 + 1, // 201
  };

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

  describe('non-Soroban transactions', () => {
    test('uses NON_SOROBAN_FEE + default inclusion fee', () => {
      const tx = buildSimpleTx();
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + DEFAULT_FEES.inclusionFeeDefault);
    });
  });

  describe('Soroban transactions', () => {
    test('adds default inclusion fee to resourceFee', () => {
      const resourceFee = 50000n;
      const tx = buildSorobanTxWithResourceFee(resourceFee);
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(Number(resourceFee) + DEFAULT_FEES.inclusionFeeDefault);
    });

    test('non-limited contract gets default inclusion fee (203)', () => {
      const tx = buildContractCallTx(OTHER_CONTRACT);
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + DEFAULT_FEES.inclusionFeeDefault);
    });

    test('limited contract gets reduced inclusion fee (201)', () => {
      const limitedContracts = new Set([LIMITED_CONTRACT]);
      const tx = buildContractCallTx(LIMITED_CONTRACT);
      const fee = calculateMaxFee(tx, limitedContracts, DEFAULT_FEES);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + DEFAULT_FEES.inclusionFeeLimited);
    });

    test('same contract without being in limited set gets default fee', () => {
      const tx = buildContractCallTx(LIMITED_CONTRACT);
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + DEFAULT_FEES.inclusionFeeDefault);
    });
  });

  describe('custom inclusion fees via env override', () => {
    test('uses custom inclusion fees when provided', () => {
      const customFees: InclusionFees = {
        inclusionFeeDefault: 500,
        inclusionFeeLimited: 300,
      };
      const tx = buildSimpleTx();
      const fee = calculateMaxFee(tx, new Set(), customFees);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + 500);
    });

    test('limited contract uses custom limited fee', () => {
      const customFees: InclusionFees = {
        inclusionFeeDefault: 500,
        inclusionFeeLimited: 300,
      };
      const limitedContracts = new Set([LIMITED_CONTRACT]);
      const tx = buildContractCallTx(LIMITED_CONTRACT);
      const fee = calculateMaxFee(tx, limitedContracts, customFees);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + 300);
    });
  });
});
