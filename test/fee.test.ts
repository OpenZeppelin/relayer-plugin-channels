import { describe, test, expect } from 'vitest';
import { calculateMaxFee, checkMaxTransactionFee, InclusionFees } from '../src/plugin/fee';
import {
  TransactionBuilder,
  Account,
  Networks,
  BASE_FEE,
  Contract,
  SorobanDataBuilder,
  Operation,
} from '@stellar/stellar-sdk';
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
      // Keep classic fee at 0 so build() adds resource fee exactly once.
      fee: '0',
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setSorobanData(sorobanData)
      .setTimeout(30)
      .build();
  }

  function buildSorobanTxWithInnerFee(classicFee: bigint, resourceFee: bigint): any {
    const contract = new Contract(OTHER_CONTRACT);
    const op = contract.call('test_method');
    const sorobanData = new SorobanDataBuilder().setResourceFee(resourceFee).build();
    return new TransactionBuilder(sourceAccount, {
      fee: classicFee.toString(),
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

  // The Relayer rejects a fee bump whose max_fee is below the CAP-15 minimum:
  // the inner inclusion fee rate (at least 100 stroops) for every inner
  // operation plus one, with the Soroban resource fee counted once.
  describe('fee-bump minimum', () => {
    function buildClassicTx(feePerOp: number, ops: number): any {
      const builder = new TransactionBuilder(sourceAccount, {
        fee: feePerOp.toString(),
        networkPassphrase: passphrase,
      });
      for (let i = 0; i < ops; i++) {
        builder.addOperation(Operation.bumpSequence({ bumpTo: '10' }));
      }
      return builder.setTimeout(30).build();
    }

    test('never bids below the base fee per operation', () => {
      // Inner fee equals the resource fee, so the inner inclusion fee rate is 0
      const tx = buildSorobanTxWithResourceFee(50_000n);
      const lowFees: InclusionFees = { inclusionFeeDefault: 150, inclusionFeeLimited: 150 };

      const fee = calculateMaxFee(tx, new Set(), lowFees);
      expect(fee).toBe(Number(BASE_FEE) * 2 + 50_000);
    });

    test('keeps the flat classic fee while it covers the minimum', () => {
      const tx = buildClassicTx(50_101, 1);
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(FEE.NON_SOROBAN_FEE + DEFAULT_FEES.inclusionFeeDefault);
    });

    test('raises a classic max_fee to twice the inner fee for one operation', () => {
      const tx = buildClassicTx(60_000, 1);
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(120_000);
    });

    test('raises a classic max_fee by one extra operation at the inner fee rate', () => {
      const tx = buildClassicTx(150_000, 2);
      expect(tx.fee).toBe('300000');
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(450_000);
    });

    test('rounds the inner fee rate up', () => {
      // 3 operations at 60,000 each, plus a fee the builder cannot produce: set it by hand
      const tx = buildClassicTx(60_000, 3);
      Object.defineProperty(tx, 'fee', { value: '180001' });
      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(60_001 * 4);
    });

    test('covers a Soroban inner inclusion fee above the base fee', () => {
      const resourceFee = 50_000n;
      // classic=201 and resource=50000 yields inner fee 50201, the most FEE_MISMATCH allows
      const tx = buildSorobanTxWithInnerFee(201n, resourceFee);
      expect(tx.fee).toBe('50201');

      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(201 * 2 + 50_000);
    });

    test('counts the Soroban resource fee once when the inner fee is the larger', () => {
      const resourceFee = 25102n;
      // With stellar-sdk >=14.1.0, build() adds resource fee on top of classic fee.
      // classic=25202 and resource=25102 yields inner fee 50304.
      const tx = buildSorobanTxWithInnerFee(25202n, resourceFee);
      expect(tx.fee).toBe('50304');

      const fee = calculateMaxFee(tx, new Set(), DEFAULT_FEES);
      expect(fee).toBe(25202 * 2 + 25102);
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

describe('checkMaxTransactionFee', () => {
  test('accepts a fee at the cap', () => {
    expect(() => checkMaxTransactionFee(100_000_000, 100_000_000)).not.toThrow();
  });

  test('rejects a fee above the cap with MAX_FEE_EXCEEDED', () => {
    expect(() => checkMaxTransactionFee(100_000_001, 100_000_000)).toThrow(
      expect.objectContaining({
        code: 'MAX_FEE_EXCEEDED',
        status: 400,
        details: { fee: 100_000_001, maxTransactionFee: 100_000_000 },
      })
    );
  });
});
