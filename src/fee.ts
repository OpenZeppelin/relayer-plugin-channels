/**
 * fee.ts
 *
 * Dynamic fee calculation for fee bump submissions.
 * - For Soroban transactions, use resourceFee + random inclusion fee
 * - For non-Soroban, add a fixed offset for safety
 * - Optionally clamp to env MAX_FEE via config helper
 */

import { Transaction, xdr } from "@stellar/stellar-sdk";
import { FEE } from "./constants";
import { getMaxFee } from "./config";

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
  let dynamic =
    resourceFee > 0n
      ? resourceFee + BigInt(baseInclusion)
      : BigInt(FEE.RESOURCE_FEE_OFFSET + baseInclusion);

  // Optional cap from env
  const cap = getMaxFee();
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    if (dynamic > BigInt(cap)) dynamic = BigInt(cap);
  }

  console.debug(
    `[channels] Calculated max_fee: ${Number(dynamic)} stroops (resourceFee: ${resourceFee}, baseInclusion: ${baseInclusion})`,
  );
  return Number(dynamic);
}

function getRandomInt(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}
