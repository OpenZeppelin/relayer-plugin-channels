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
    if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      return undefined;
    }
    const invokeContract = func.invokeContract();
    return StrKey.encodeContract(invokeContract.contractAddress().contractId() as unknown as Buffer);
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

export function calculateMaxFee(transaction: Transaction, limitedContracts: Set<string>, fees: InclusionFees): number {
  const envelope = transaction.toEnvelope();

  let resourceFee = 0n;
  if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
    const sorobanData = envelope.v1().tx().ext().sorobanData();
    if (sorobanData) {
      resourceFee = sorobanData.resourceFee().toBigInt();
    }
  }

  const contractId = getContractIdFromTransaction(transaction);
  const inclusionFee = getInclusionFee(contractId, limitedContracts, fees);

  const fee = resourceFee > 0n ? resourceFee + BigInt(inclusionFee) : BigInt(FEE.NON_SOROBAN_FEE + inclusionFee);

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, inclusionFee: ${inclusionFee})`
  );
  return Number(fee);
}
