/**
 * fee.ts
 *
 * Static fee calculation for fee bump submissions matching launchtube.
 * - For Soroban transactions: use resourceFee + inclusion fee
 * - For non-Soroban: use NON_SOROBAN_FEE + inclusion fee
 * - Limited contracts (from LIMITED_CONTRACTS env) get reduced fee
 * - Inclusion fees are configurable via INCLUSION_FEE_DEFAULT and INCLUSION_FEE_LIMITED env vars
 */

import { BASE_FEE, Transaction, xdr, StrKey, Operation } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { FEE, HTTP_STATUS } from './constants';

export interface InclusionFees {
  inclusionFeeDefault: number;
  inclusionFeeLimited: number;
}

/**
 * Extract contract ID from a HostFunction (for func+auth flow)
 */
export function getContractIdFromFunc(func: xdr.HostFunction): string | undefined {
  try {
    if (func.type !== 'hostFunctionTypeInvokeContract') {
      return undefined;
    }
    const contractAddress = func.invokeContract.contractAddress;
    if (contractAddress.type !== 'scAddressTypeContract') {
      return undefined;
    }
    return StrKey.encodeContract(contractAddress.contractId.toBytes());
  } catch {
    return undefined;
  }
}

/**
 * Extract contract ID from a Transaction (for XDR flow)
 */
export function getContractIdFromTransaction(transaction: Transaction): string | undefined {
  try {
    if (transaction.operations.length !== 1) return undefined;

    const op = transaction.operations[0];
    if (op.type !== 'invokeHostFunction') return undefined;

    const invokeOp = op as Operation.InvokeHostFunction;
    return getContractIdFromFunc(invokeOp.func);
  } catch {
    return undefined;
  }
}

function getInclusionFee(contractId: string | undefined, limitedContracts: Set<string>, fees: InclusionFees): number {
  if (contractId && limitedContracts.has(contractId)) {
    return fees.inclusionFeeLimited;
  }
  return fees.inclusionFeeDefault;
}

/**
 * Minimum fee the Relayer accepts for a fee bump of this transaction (CAP-15):
 * the inner inclusion fee rate, at least the base fee, for every inner
 * operation plus one, with the Soroban resource fee counted once.
 */
function feeBumpMinimumFee(innerTxFee: bigint, resourceFee: bigint, operationCount: number): bigint {
  const innerOps = BigInt(Math.max(operationCount, 1));
  const innerInclusionFee = innerTxFee > resourceFee ? innerTxFee - resourceFee : 0n;
  const ratePerOp = (innerInclusionFee + innerOps - 1n) / innerOps; // rounded up
  const baseFee = BigInt(BASE_FEE);
  return (ratePerOp > baseFee ? ratePerOp : baseFee) * (innerOps + 1n) + resourceFee;
}

/**
 * Compute the maximum fee (in stroops) for a transaction: the Soroban resource
 * fee declared in the envelope's sorobanData (0 for classic transactions) plus
 * the inclusion fee, which is higher when the invoked contract is rate-limited.
 * Raised to the fee-bump minimum when the inner transaction's own fee needs more.
 */
export function calculateMaxFee(transaction: Transaction, limitedContracts: Set<string>, fees: InclusionFees): number {
  const envelope = transaction.toEnvelope();

  let resourceFee = 0n;
  if (envelope.type === 'envelopeTypeTx') {
    const ext = envelope.v1.tx.ext;
    if (ext.type === 'sorobanData') {
      resourceFee = ext.sorobanData.resourceFee;
    }
  }

  const contractId = getContractIdFromTransaction(transaction);
  const inclusionFee = getInclusionFee(contractId, limitedContracts, fees);

  const computedFee =
    resourceFee > 0n ? resourceFee + BigInt(inclusionFee) : BigInt(FEE.NON_SOROBAN_FEE + inclusionFee);
  const innerTxFee = BigInt(transaction.fee);

  // A fee bump below the minimum for its inner transaction is rejected before submission
  const minimumFee = feeBumpMinimumFee(innerTxFee, resourceFee, transaction.operations.length);
  const fee = computedFee >= minimumFee ? computedFee : minimumFee;

  if (fee !== computedFee) {
    console.warn(
      `[channels] Inner transaction fee needs a higher fee bump: computed=${computedFee}, innerTxFee=${innerTxFee}. Using max_fee=${fee}`
    );
  }

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, inclusionFee: ${inclusionFee}, innerTxFee: ${innerTxFee})`
  );
  return Number(fee);
}

/**
 * Reject a transaction whose fee bid is above what the fund relayer sponsors
 * for one transaction. The bid comes from the client's envelope (the Soroban
 * resource fee, or the inner fee of a classic transaction) or from simulation,
 * so without a cap a single request could bid any amount.
 */
export function checkMaxTransactionFee(fee: number, maxTransactionFee: number): void {
  if (fee > maxTransactionFee) {
    throw pluginError(
      `Transaction fee (${fee} stroops) exceeds the maximum sponsored per transaction (${maxTransactionFee} stroops)`,
      {
        code: 'MAX_FEE_EXCEEDED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { fee, maxTransactionFee },
      }
    );
  }
}
