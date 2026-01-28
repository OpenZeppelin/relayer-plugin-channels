/**
 * fee.ts
 *
 * Static fee calculation for fee bump submissions matching launchtube.
 * - For Soroban transactions: use resourceFee + inclusion fee (BASE_FEE * 2 + 3)
 * - For non-Soroban: use NON_SOROBAN_FEE + inclusion fee
 * - KALE contract gets reduced fee (BASE_FEE * 2 + 1)
 */

import { BASE_FEE, Transaction, xdr, StrKey, Operation } from '@stellar/stellar-sdk';
import { FEE } from './constants';

export const KALE_CONTRACT = 'CDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIGWA';
export const INCLUSION_FEE_DEFAULT = Number(BASE_FEE) * 2 + 3;
export const INCLUSION_FEE_KALE = Number(BASE_FEE) * 2 + 1;

function getInclusionFee(transaction: Transaction): number {
  try {
    if (transaction.operations.length !== 1) return INCLUSION_FEE_DEFAULT;

    const op = transaction.operations[0];
    if (op.type !== 'invokeHostFunction') return INCLUSION_FEE_DEFAULT;

    const invokeOp = op as Operation.InvokeHostFunction;
    if (invokeOp.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      return INCLUSION_FEE_DEFAULT;
    }

    const invokeContract = invokeOp.func.invokeContract();
    const contract = StrKey.encodeContract(invokeContract.contractAddress().contractId() as unknown as Buffer);

    return contract === KALE_CONTRACT ? INCLUSION_FEE_KALE : INCLUSION_FEE_DEFAULT;
  } catch {
    return INCLUSION_FEE_DEFAULT;
  }
}

export function calculateMaxFee(transaction: Transaction): number {
  const envelope = transaction.toEnvelope();

  let resourceFee = 0n;
  if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
    const sorobanData = envelope.v1().tx().ext().sorobanData();
    if (sorobanData) {
      resourceFee = sorobanData.resourceFee().toBigInt();
    }
  }

  const inclusionFee = getInclusionFee(transaction);

  const fee = resourceFee > 0n ? resourceFee + BigInt(inclusionFee) : BigInt(FEE.NON_SOROBAN_FEE + inclusionFee);

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, inclusionFee: ${inclusionFee})`
  );
  return Number(fee);
}
