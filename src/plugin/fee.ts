/**
 * fee.ts
 *
 * Dynamic fee calculation for fee bump submissions.
 * - For Soroban transactions: use resourceFee + random inclusion fee
 * - For non-Soroban: use NON_SOROBAN_FEE
 */

import { Transaction, xdr } from '@stellar/stellar-sdk';
import { FEE } from './constants';

export function calculateMaxFee(transaction: Transaction): number {
  const envelope = transaction.toEnvelope();

  let resourceFee = 0n;
  if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
    const sorobanData = envelope.v1().tx().ext().sorobanData();
    if (sorobanData) {
      resourceFee = sorobanData.resourceFee().toBigInt();
    }
  }

  const baseInclusion = getRandomInt(FEE.MIN_BASE_FEE, FEE.MAX_BASE_FEE);

  const fee = resourceFee > 0n ? resourceFee + BigInt(baseInclusion) : BigInt(FEE.NON_SOROBAN_FEE + baseInclusion);

  console.debug(
    `[channels] Calculated max_fee: ${Number(fee)} stroops (resourceFee: ${resourceFee}, baseInclusion: ${baseInclusion})`
  );
  return Number(fee);
}

function getRandomInt(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}
