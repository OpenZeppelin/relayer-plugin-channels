/**
 * build.ts
 *
 * Transaction rebuild logic to use channel account as source.
 */

import { Transaction, xdr, StrKey } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, TIME } from './constants';

export interface RebuildParams {
  inputXdr: string;
  channelAddress: string;
  channelSequence: string;
  fundAddress: string;
  networkPassphrase: string;
}

/**
 * Rebuild transaction with channel account as source
 * - Set transaction source to channel account with current sequence
 * - Preserve memo, timeBounds, etc.
 * - Copy operations ensuring their source equals the fund address
 */
export function rebuildWithChannel(params: RebuildParams): Transaction {
  const { inputXdr, channelAddress, channelSequence, fundAddress, networkPassphrase } = params;

  // Parse input transaction
  let inputTx: Transaction;
  try {
    const envelope = xdr.TransactionEnvelope.fromXdr(inputXdr, 'base64');

    // Ensure it's a regular transaction envelope (not fee bump)
    if (envelope.type !== 'envelopeTypeTx') {
      throw pluginError('Input must be a regular transaction envelope (not fee bump)', {
        code: 'INVALID_ENVELOPE_TYPE',
        status: HTTP_STATUS.BAD_REQUEST,
      });
    }

    inputTx = new Transaction(envelope, networkPassphrase);
  } catch (error) {
    if ((error as any).code === 'INVALID_ENVELOPE_TYPE') {
      throw error;
    }
    throw pluginError('Failed to parse input transaction XDR', {
      code: 'INVALID_XDR',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  // Validate timeBounds
  if (inputTx.timeBounds) {
    const now = Math.floor(Date.now() / 1000);
    const maxTime = Number(inputTx.timeBounds.maxTime);

    if (maxTime > 0) {
      if (maxTime < now) {
        throw pluginError('Transaction has expired: maxTime is in the past', {
          code: 'TIMEBOUNDS_EXPIRED',
          status: HTTP_STATUS.BAD_REQUEST,
          details: { maxTime, now },
        });
      }

      const maxAllowedTime = now + TIME.MAX_TIME_BOUND_OFFSET_SECONDS;
      if (maxTime > maxAllowedTime) {
        throw pluginError(
          `Transaction maxTime is too far in the future. Max allowed: ${TIME.MAX_TIME_BOUND_OFFSET_SECONDS} seconds from now`,
          {
            code: 'INVALID_TIME_BOUNDS',
            status: HTTP_STATUS.BAD_REQUEST,
            details: { maxTime, maxAllowedTime },
          }
        );
      }
    }
  }

  // Validate operations: all operation sources must be fund address or missing
  for (let i = 0; i < inputTx.operations.length; i++) {
    const op = inputTx.operations[i];
    if (op.source && op.source !== fundAddress) {
      throw pluginError(`Operation ${i} has source ${op.source} but must be ${fundAddress} or omitted`, {
        code: 'INVALID_OPERATION_SOURCE',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { operationIndex: i, operationSource: op.source, expectedSource: fundAddress },
      });
    }
  }

  // Rebuild the transaction envelope with the channel account as source and the
  // channel's sequence number. XDR values are immutable in stellar-sdk v17, so a
  // fresh envelope is constructed rather than mutating the decoded one.

  const envelope = inputTx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    throw pluginError('Input must be a regular transaction envelope (not fee bump)', {
      code: 'INVALID_ENVELOPE_TYPE',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }
  const txBody = envelope.v1.tx;

  const channelMuxed = xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(channelAddress));
  const fundMuxed = xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(fundAddress));

  // Operations without an explicit source get the fund address
  const operations = txBody.operations.map((op) =>
    op.sourceAccount == null ? new xdr.Operation({ sourceAccount: fundMuxed, body: op.body }) : op
  );

  const rebuilt = xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({
      tx: new xdr.Transaction({
        sourceAccount: channelMuxed,
        fee: txBody.fee,
        seqNum: BigInt(channelSequence),
        cond: txBody.cond,
        memo: txBody.memo,
        operations,
        ext: txBody.ext,
      }),
      signatures: [...envelope.v1.signatures],
    })
  );

  return new Transaction(rebuilt, networkPassphrase);
}
