/**
 * tx.ts
 *
 * Transaction validation helpers for the XDR submit-only path.
 */

import { Transaction, xdr } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, SIMULATION } from './constants';

export function validateExistingTransactionForSubmitOnly(tx: Transaction): Transaction {
  const now = Math.floor(Date.now() / 1000);

  // Reject fee-bump envelopes
  const envelope = tx.toEnvelope();
  const kind = envelope.switch();
  if (kind !== xdr.EnvelopeType.envelopeTypeTx()) {
    throw pluginError('Input must be a regular transaction envelope (fee-bump not allowed)', {
      code: 'INVALID_ENVELOPE_TYPE',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Soroban sanity checks
  const sorobanData = envelope.v1().tx().ext().sorobanData();
  if (sorobanData) {
    const resourceFee = sorobanData.resourceFee().toBigInt();
    if (BigInt(tx.fee) > resourceFee + 201n) {
      throw pluginError('Transaction fee must be equal to the resource fee', {
        code: 'FEE_MISMATCH',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { fee: tx.fee, resourceFee: resourceFee.toString() },
      });
    }
  }

  // Time bounds sanity
  if (tx.timeBounds?.maxTime && Number(tx.timeBounds.maxTime) - now > SIMULATION.MAX_FUTURE_TIME_BOUND_SECONDS) {
    throw pluginError(
      `Transaction \`timeBounds.maxTime\` too far into the future. Must be no greater than ${SIMULATION.MAX_FUTURE_TIME_BOUND_SECONDS} seconds`,
      {
        code: 'TIMEBOUNDS_TOO_FAR',
        status: HTTP_STATUS.BAD_REQUEST,
      },
    );
  }

  return tx;
}

