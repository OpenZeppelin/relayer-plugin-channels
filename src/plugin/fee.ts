/**
 * fee.ts
 *
 * Static fee calculation for fee bump submissions matching launchtube.
 * - For Soroban transactions: use resourceFee + inclusion fee
 * - For non-Soroban: use NON_SOROBAN_FEE + inclusion fee
 * - Limited contracts (from LIMITED_CONTRACTS env) get reduced fee
 * - Inclusion fees are configurable via INCLUSION_FEE_DEFAULT and INCLUSION_FEE_LIMITED env vars
 */

import { Transaction, xdr, StrKey, Operation } from '@stellar/stellar-sdk';
import { FEE } from './constants';

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
 * Compute the maximum fee (in stroops) for a transaction: the Soroban resource
 * fee declared in the envelope's sorobanData (0 for classic transactions) plus
 * the inclusion fee, which is higher when the invoked contract is rate-limited.
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

  // Safety floor: fee bump max_fee must always cover the actual inner transaction fee.
  // This protects against upstream fee-field mismatches that can produce a larger inner fee.
  const fee = computedFee >= innerTxFee ? computedFee : innerTxFee + BigInt(inclusionFee);

  if (fee !== computedFee) {
    console.warn(
      `[channels] Fee mismatch detected: computed=${computedFee}, innerTxFee=${innerTxFee}. Using max_fee=${fee}`
    );
  }

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, inclusionFee: ${inclusionFee}, innerTxFee: ${innerTxFee})`
  );
  return Number(fee);
}
