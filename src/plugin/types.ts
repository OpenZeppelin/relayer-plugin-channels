/**
 * types.ts
 *
 * Type definitions for the channel accounts plugin.
 */

/**
 * Plugin request parameters:
 * - Submit-only: signed regular transaction XDR
 * - Channel build: func + auth (always simulated)
 */
import type { xdr } from '@stellar/stellar-sdk';

export type ChannelAccountsRequest =
  | { type: 'xdr'; xdr: string; returnTxHash?: boolean }
  | { type: 'func-auth'; func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[]; returnTxHash?: boolean };

/**
 * Plugin response format aligned with launchtube
 */
export interface ChannelAccountsResponse {
  transactionId: string | null;
  status: string | null;
  hash: string | null;
  /** Present only for read-only calls: the base64-encoded xdr.ScVal return value */
  returnValue?: string;
  /** Present only for read-only calls: the latest ledger at simulation time */
  latestLedger?: number;
  /** Present when returnTxHash is set and the transaction failed on-chain */
  error?: {
    reason?: string;
    resultCode?: string | null;
    labUrl?: string | null;
  };
}

/**
 * Management request structure
 */
export interface ManagementRequest {
  management: {
    adminSecret: string;
    action: 'listChannelAccounts' | 'setChannelAccounts';
    relayerIds?: string[];
  };
}

/**
 * Management response for listing channel accounts
 */
export interface ListChannelAccountsResponse {
  relayerIds: string[];
}

/**
 * Management response for setting channel accounts
 */
export interface SetChannelAccountsResponse {
  ok: boolean;
  appliedRelayerIds: string[];
}

/**
 * Channel account info
 */
export interface ChannelAccountInfo {
  relayerId: string;
  address: string;
  sequenceNumber: string;
}

/**
 * Fund account info
 */
export interface FundAccountInfo {
  relayerId: string;
  address: string;
}
