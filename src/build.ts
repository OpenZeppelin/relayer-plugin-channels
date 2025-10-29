/**
 * build.ts
 *
 * Transaction rebuild logic to use channel account as source.
 */

import { Transaction, xdr, StrKey } from "@stellar/stellar-sdk";
import { pluginError } from "@openzeppelin/relayer-sdk";
import { HTTP_STATUS, TIME } from "./constants";

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
  const {
    inputXdr,
    channelAddress,
    channelSequence,
    fundAddress,
    networkPassphrase,
  } = params;

  // Parse input transaction
  let inputTx: Transaction;
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(inputXdr, "base64");

    // Ensure it's a regular transaction envelope (not fee bump)
    if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
      throw pluginError(
        "Input must be a regular transaction envelope (not fee bump)",
        {
          code: "INVALID_ENVELOPE_TYPE",
          status: HTTP_STATUS.BAD_REQUEST,
        },
      );
    }

    inputTx = new Transaction(envelope, networkPassphrase);
  } catch (error) {
    if ((error as any).code === "INVALID_ENVELOPE_TYPE") {
      throw error;
    }
    throw pluginError("Failed to parse input transaction XDR", {
      code: "INVALID_XDR",
      status: HTTP_STATUS.BAD_REQUEST,
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  // Validate timeBounds
  if (inputTx.timeBounds) {
    const now = Math.floor(Date.now() / 1000);
    const maxTime = Number(inputTx.timeBounds.maxTime);

    if (maxTime > 0) {
      const maxAllowedTime = now + TIME.MAX_TIME_BOUND_OFFSET_SECONDS;
      if (maxTime > maxAllowedTime) {
        throw pluginError(
          `Transaction maxTime is too far in the future. Max allowed: ${TIME.MAX_TIME_BOUND_OFFSET_SECONDS} seconds from now`,
          {
            code: "INVALID_TIME_BOUNDS",
            status: HTTP_STATUS.BAD_REQUEST,
            details: { maxTime, maxAllowedTime },
          },
        );
      }
    }
  }

  // Validate operations: all operation sources must be fund address or missing
  for (let i = 0; i < inputTx.operations.length; i++) {
    const op = inputTx.operations[i];
    if (op.source && op.source !== fundAddress) {
      throw pluginError(
        `Operation ${i} has source ${op.source} but must be ${fundAddress} or omitted`,
        {
          code: "INVALID_OPERATION_SOURCE",
          status: HTTP_STATUS.BAD_REQUEST,
          details: {
            operationIndex: i,
            operationSource: op.source,
            expectedSource: fundAddress,
          },
        },
      );
    }
  }

  // Manipulate the transaction envelope XDR directly to change source and sequence
  // This is the most reliable approach that preserves all transaction details

  const envelope = inputTx.toEnvelope();
  const txBody = envelope.v1().tx();

  // Update source account to channel address
  const channelAccountId = StrKey.decodeEd25519PublicKey(channelAddress);
  const channelMuxed = xdr.MuxedAccount.keyTypeEd25519(channelAccountId);
  txBody.sourceAccount(channelMuxed);

  // Update sequence number
  // Sequence numbers in Stellar are represented as Int64 in XDR
  const seqNum = xdr.Int64.fromString(channelSequence);
  txBody.seqNum(seqNum);

  // Update operation sources to fund address if not set
  const fundAccountId = StrKey.decodeEd25519PublicKey(fundAddress);
  const fundMuxed = xdr.MuxedAccount.keyTypeEd25519(fundAccountId);

  const operations = txBody.operations();
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    // If operation doesn't have a source, set it to fund address
    if (!op.sourceAccount()) {
      op.sourceAccount(fundMuxed);
    }
  }

  // Create new transaction from modified envelope
  return new Transaction(envelope, networkPassphrase);
}
