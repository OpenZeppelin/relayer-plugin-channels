/**
 * tx.ts
 *
 * Transaction validation helpers for the XDR submit-only path.
 */

import { Transaction } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import type { ChannelAccountsConfig } from './config';
import { HTTP_STATUS } from './constants';

/**
 * Validate a client-built transaction for the XDR submit-only path.
 *
 * Rejects fee-bump envelopes, Soroban transactions whose fee exceeds the
 * declared resource fee plus the base inclusion fee, and a `timeBounds.maxTime`
 * that is already in the past or further out than the configured maximum offset.
 */
export function validateExistingTransactionForSubmitOnly(
  tx: Transaction,
  config: Pick<ChannelAccountsConfig, 'maxTimeBoundOffsetSeconds'>
): Transaction {
  const { maxTimeBoundOffsetSeconds } = config;
  const now = Math.floor(Date.now() / 1000);

  // Reject fee-bump envelopes
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    throw pluginError('Input must be a regular transaction envelope (fee-bump not allowed)', {
      code: 'INVALID_ENVELOPE_TYPE',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Soroban sanity checks
  const ext = envelope.v1.tx.ext;
  if (ext.type === 'sorobanData') {
    const resourceFee = ext.sorobanData.resourceFee;
    if (BigInt(tx.fee) > resourceFee + 201n) {
      throw pluginError('Transaction fee must be equal to the resource fee', {
        code: 'FEE_MISMATCH',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { fee: tx.fee, resourceFee: resourceFee.toString() },
      });
    }
  }

  // Time bounds sanity
  if (tx.timeBounds?.maxTime && Number(tx.timeBounds.maxTime) > 0) {
    const maxTime = Number(tx.timeBounds.maxTime);

    if (maxTime < now) {
      throw pluginError('Transaction has expired: `timeBounds.maxTime` is in the past', {
        code: 'TIMEBOUNDS_EXPIRED',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { maxTime, now },
      });
    }

    if (maxTime - now > maxTimeBoundOffsetSeconds) {
      throw pluginError(
        `Transaction \`timeBounds.maxTime\` too far into the future. Must be no greater than ${maxTimeBoundOffsetSeconds} seconds`,
        {
          code: 'TIMEBOUNDS_TOO_FAR',
          status: HTTP_STATUS.BAD_REQUEST,
        }
      );
    }
  }

  return tx;
}
