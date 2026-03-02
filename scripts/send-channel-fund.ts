/**
 * Build a payment transaction, sign with two relayers, merge signatures, and submit.
 *
 * Usage:
 *   npx tsx scripts/build-sign-submit.ts
 */

import { TransactionBuilder, Operation, Networks, Asset, Account, Memo } from '@stellar/stellar-sdk';

// ── Network ─────────────────────────────────────────────────────────────────
const NETWORK: 'testnet' | 'mainnet' = 'mainnet';

const NETWORK_CONFIG = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
  },
} as const;

// ── Relayer config ──────────────────────────────────────────────────────────
const RELAYER_1_URL = '<channels_mainnet_url>/api/v1/relayers/<channel-account-id>/sign-transaction';
const RELAYER_1_TOKEN = '';

const RELAYER_2_URL = '<channels_mainnet_url>/api/v1/relayers/<channel-fund-id>/sign-transaction';
const RELAYER_2_TOKEN = '';

// ── Transaction params ──────────────────────────────────────────────────────
const TX_SOURCE = '<channel-account-address>'; // Replace with your channel account address
const FUND_SOURCE = 'GA2JRQOF6EA3HQWDCEDBPPMLYPJCFLDDGYZLEQGMS5SOBQIB3BAFHVAW'; // Fund account address (must be a signer on the channel account)
const DEST = '<destination-address>'; // Replace with your destination address
const MEMO_ID = '<memo-id>'; // Replace with your desired memo ID

// ── Fetch sequence from Horizon ─────────────────────────────────────────────
async function fetchSequence(address: string): Promise<string> {
  const { horizonUrl } = NETWORK_CONFIG[NETWORK];
  const res = await fetch(`${horizonUrl}/accounts/${address}`);

  if (!res.ok) {
    throw new Error(`Failed to fetch account ${address}: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { sequence?: string };
  if (!json.sequence) {
    throw new Error(`Account not found: ${address}`);
  }

  return json.sequence;
}

// ── Build ───────────────────────────────────────────────────────────────────
function buildTransaction(sequence: string): string {
  const { passphrase } = NETWORK_CONFIG[NETWORK];
  const account = new Account(TX_SOURCE, sequence);
  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        source: FUND_SOURCE,
        destination: DEST,
        asset: Asset.native(),
        amount: '1', // 1 XLM
      })
    )
    .addMemo(Memo.id(MEMO_ID))
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

// ── Sign via relayer ────────────────────────────────────────────────────────
async function signWithRelayer(unsignedXdr: string, url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ unsigned_xdr: unsignedXdr }),
  });

  if (!res.ok) {
    throw new Error(`Relayer responded ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    success: boolean;
    data?: { signedXdr: string };
    error?: string;
  };

  if (!json.success || !json.data?.signedXdr) {
    throw new Error(`Relayer error: ${json.error ?? 'no signedXdr in response'}`);
  }

  return json.data.signedXdr;
}

// ── Merge & submit ──────────────────────────────────────────────────────────
async function main() {
  const { horizonUrl, passphrase } = NETWORK_CONFIG[NETWORK];
  console.log(`Network: ${NETWORK}`);

  // 1. Fetch current sequence
  console.log(`\nFetching sequence for ${TX_SOURCE}...`);
  const sequence = await fetchSequence(TX_SOURCE);
  console.log(`Sequence: ${sequence}`);

  // 2. Build unsigned transaction
  const unsignedXdr = buildTransaction(sequence);
  console.log('\nUnsigned XDR:', unsignedXdr);

  // 3. Sign with both relayers in parallel
  console.log('\nSigning with both relayers...');
  const [signedXdr1, signedXdr2] = await Promise.all([
    signWithRelayer(unsignedXdr, RELAYER_1_URL, RELAYER_1_TOKEN),
    signWithRelayer(unsignedXdr, RELAYER_2_URL, RELAYER_2_TOKEN),
  ]);
  console.log('Relayer 1 signed.');
  console.log('Relayer 2 signed.');

  // 4. Merge signatures
  const base = TransactionBuilder.fromXDR(signedXdr1, passphrase);
  const other = TransactionBuilder.fromXDR(signedXdr2, passphrase);

  for (const sig of other.signatures) {
    base.addDecoratedSignature(sig);
  }

  const mergedXdr = base.toXDR();
  console.log(`\nMerged ${base.signatures.length} signature(s)`);
  console.log('Hash:', base.hash().toString('hex'));

  console.log('Merged XDR:', mergedXdr);

  // 5. Submit to Horizon
  console.log(`\nSubmitting to ${horizonUrl}...`);
  const res = await fetch(`${horizonUrl}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `tx=${encodeURIComponent(mergedXdr)}`,
  });

  const json = await res.json();

  if (res.ok) {
    console.log('Success! Hash:', json.hash);
    console.log('Ledger:', json.ledger);
  } else {
    console.error('Failed:', json.title);
    console.error('Detail:', json.detail);
    if (json.extras?.result_codes) {
      console.error('Result codes:', JSON.stringify(json.extras.result_codes));
    }
  }
}

main().catch(console.error);
