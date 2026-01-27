/**
 * fee.ts
 *
 * Static fee calculation for fee bump submissions matching launchtube.
 * - For Soroban transactions: use resourceFee + inclusion fee (BASE_FEE * 2 + 3)
 * - For non-Soroban: use NON_SOROBAN_FEE + inclusion fee
 * - Limited contracts get reduced fee (BASE_FEE * 2 + 1)
 */

import { BASE_FEE, Transaction, xdr, StrKey, Operation } from '@stellar/stellar-sdk';
import { FEE } from './constants';

export const INCLUSION_FEE_DEFAULT = Number(BASE_FEE) * 2 + 3;
export const INCLUSION_FEE_LIMITED = Number(BASE_FEE) * 2 + 1;

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

function getInclusionFee(contractId: string | undefined, limitedContracts: Set<string>): number {
  if (contractId && limitedContracts.has(contractId)) {
    return INCLUSION_FEE_LIMITED;
  }
  return INCLUSION_FEE_DEFAULT;
}

export function calculateMaxFee(transaction: Transaction, limitedContracts: Set<string> = new Set()): number {
  const envelope = transaction.toEnvelope();

  let resourceFee = 0n;
  if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
    const sorobanData = envelope.v1().tx().ext().sorobanData();
    if (sorobanData) {
      resourceFee = sorobanData.resourceFee().toBigInt();
    }
  }

  const contractId = getContractIdFromTransaction(transaction);
  const inclusionFee = getInclusionFee(contractId, limitedContracts);

  const fee = resourceFee > 0n ? resourceFee + BigInt(inclusionFee) : BigInt(FEE.NON_SOROBAN_FEE + inclusionFee);

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, inclusionFee: ${inclusionFee})`
  );
  return Number(fee);
}
