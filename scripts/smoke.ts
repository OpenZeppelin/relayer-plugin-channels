/*
 Channel Accounts Plugin — Smoke Test Script

 What it does
 - Health-checks your relayer
 - XDR submit-only: signs a small self-payment and submits via fee bump
 - func+auth (no auth): calls smoke-contract `no_auth_bump(42)` using a channel account
 - func+auth (address auth): calls `write_with_address_auth(addr, 777)` and signs auth entries

 Prerequisites
 - Node.js 18+ (global fetch available)
 - A Stellar key via CLI (`stellar keys`)
 - Deployed smoke-contract (see contracts/smoke-contract/contract.sh build|optimize|deploy)

 Usage Examples

   # Relayer mode (default) - local relayer with 'channels' plugin
   tsx scripts/smoke.ts --api-key YOUR_API_KEY

   # Relayer mode - custom relayer URL
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://my-relayer.com \
     --plugin-id channels

   # Direct HTTP mode - standalone plugin service
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://plugin-service.com

   # Run specific test with custom contract
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --test-id xdr-payment \
     --contract-id CAM5NSLGILAYZ6UMPDOT5MBO2MUM65VM2PMUE7Z2TTBGNEKZZRPFML5W

   # Test with fee tracking (logs fee usage after tests)
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --admin-secret ADMIN_SECRET \
     --log-fees-spent

 Flags / env (args > env > defaults)
   --api-key (API_KEY)             required: API key for authentication
   --plugin-id (PLUGIN_ID)         default: 'channels' (enables relayer mode)
                                   omit this flag to use direct HTTP mode
   --base-url (BASE_URL)           default: http://localhost:8080 (when using plugin-id)
                                   required when omitting plugin-id (direct HTTP mode)
   --account-name (ACCOUNT_NAME)   default: test-account (must exist in `stellar keys`)
   --contract-id (CONTRACT_ID)     default: bundled smoke-contract on testnet
   --network (NETWORK)             default: testnet | also supports: mainnet
   --rpc-url (RPC_URL)             default: https://soroban-testnet.stellar.org
   --test-id (TEST_ID)             optional: run only one test
                                   options: xdr-payment, func-auth-no-auth, func-auth-address-auth
   --concurrency (CONCURRENCY)     optional: parallel requests per test (default: 1)
   --debug                         optional: print full plugin response with logs/traces
   --api-key-header (API_KEY_HEADER) optional: header name for API key in relayer mode (default: x-api-key)
   --admin-secret (ADMIN_SECRET)   optional: admin secret for management operations
   --log-fees-spent                optional: query and log fee usage after tests (requires admin-secret)

 Client Modes
   Relayer mode:      Uses ChannelsClient with pluginId
                      Routes through relayer's PluginsApi at /api/v1/plugins/{pluginId}/call
                      Default when --plugin-id is provided (defaults to 'channels')

   Direct HTTP mode:  Uses ChannelsClient without pluginId
                      Connects directly to plugin service at /api/v1/plugins/channels/call
                      Used when --plugin-id is omitted and --base-url points to plugin service
*/

import { execSync } from 'child_process';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  rpc,
  Contract,
  xdr,
  Address,
  authorizeInvocation,
} from '@stellar/stellar-sdk';
import { ChannelsClient } from '../src/client/index';

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.includes('=') ? a.split('=') : [a, undefined];
    const key = k.replace(/^--/, '').trim();
    if (v !== undefined) out[key] = v;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function np(net: 'testnet' | 'mainnet') {
  return net === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

async function healthCheck(baseUrl: string, apiKey: string): Promise<void> {
  const url = `${baseUrl}/api/v1/health`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  } as any).catch((e: any) => ({ ok: false, statusText: e?.message || String(e) }) as any);
  if (!res.ok) throw new Error(`Relayer health check failed: ${res.status} ${res.statusText}`);
}

function getKeypair(accountName?: string): { keypair: Keypair; address: string } {
  const name = accountName || 'test-account';
  const address = execSync(`stellar keys address ${name}`, { encoding: 'utf8' }).trim();
  const secret = execSync(`stellar keys show ${name}`, { encoding: 'utf8' }).trim();
  return { keypair: Keypair.fromSecret(secret), address };
}

async function buildSignedSelfPayment(rpcServer: rpc.Server, passphrase: string, address: string, keypair: Keypair) {
  const account = await rpcServer.getAccount(address);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase })
    .addOperation(
      Operation.payment({ source: address, destination: address, asset: Asset.native(), amount: '0.0000010' })
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx;
}

function buildNoAuthFuncPayload(contractId: string) {
  const contract = new Contract(contractId);
  const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(42));
  const body = (op as any).body();
  const invokeOp = body.invokeHostFunctionOp();
  const func = invokeOp.hostFunction();
  const auth = invokeOp.auth() ?? [];
  return { func: func.toXDR('base64'), auth: auth.map((a: any) => a.toXDR('base64')) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = String(args['api-key'] || process.env.API_KEY || 'REPLACE_ME');
  const pluginId = (args['plugin-id'] || process.env.PLUGIN_ID || 'channels') as string | undefined;
  const baseUrl = String(args['base-url'] || process.env.BASE_URL || (pluginId ? 'http://localhost:8080' : ''));
  const network = String(args.network || process.env.NETWORK || 'testnet').toLowerCase() as 'testnet' | 'mainnet';
  const passphrase = np(network);
  const rpcUrl = String(args['rpc-url'] || process.env.RPC_URL || 'https://soroban-testnet.stellar.org');
  const accountName = String(args['account-name'] || process.env.ACCOUNT_NAME || 'test-account');
  const testId = (args['test-id'] || process.env.TEST_ID) as string | undefined;
  const debug = Boolean(args['debug'] || process.env.DEBUG);
  const concurrency = parseInt(String(args['concurrency'] || process.env.CONCURRENCY || '1'), 10);
  const contractId = String(
    args['contract-id'] || process.env.CONTRACT_ID || 'CD3P6XI7YI6ATY5RM2CNXHRRT3LBGPC3WGR2D2OE6EQNVLVEA5HGUELG'
  );

  // Fee tracking flags
  const apiKeyHeader = (args['api-key-header'] || process.env.API_KEY_HEADER || 'x-api-key') as string;
  const adminSecret = (args['admin-secret'] || process.env.ADMIN_SECRET) as string | undefined;
  const logFeesSpent = Boolean(args['log-fees-spent']);

  if (!apiKey || apiKey === 'REPLACE_ME') {
    console.warn('⚠ Set --api-key or API_KEY to your API key');
  }

  if (!baseUrl) {
    console.error('❌ --base-url is required when not using relayer mode (no plugin-id)');
    process.exit(1);
  }

  if (logFeesSpent && !adminSecret) {
    console.error('❌ --admin-secret is required when using --log-fees-spent');
    process.exit(1);
  }

  await healthCheck(baseUrl, apiKey);

  const rpcServer = new rpc.Server(rpcUrl);
  const { keypair, address } = getKeypair(accountName);

  // Initialize the client
  const client = pluginId
    ? new ChannelsClient({ baseUrl, apiKey, pluginId, apiKeyHeader, adminSecret })
    : new ChannelsClient({ baseUrl, apiKey, adminSecret });

  type Ctx = {
    client: ChannelsClient;
    rpc: rpc.Server;
    passphrase: string;
    keypair: Keypair;
    address: string;
    contractId: string;
    debug: boolean;
  };
  const ctx: Ctx = { client, rpc: rpcServer, passphrase, keypair, address, contractId, debug };

  const TESTS: { id: string; label: string; run: (ctx: Ctx) => Promise<void> }[] = [
    {
      id: 'xdr-payment',
      label: 'XDR submit-only: signed self-payment',
      run: async ({ client, rpc, passphrase, address, keypair, debug }) => {
        const tx = await buildSignedSelfPayment(rpc, passphrase, address, keypair);
        const res = await client.submitTransaction({ xdr: tx.toXDR() });
        printResult('xdr-payment', { success: true, data: res }, debug);
      },
    },
    {
      id: 'func-auth-no-auth',
      label: 'func+auth: no_auth_bump(42)',
      run: async ({ client, contractId, debug }) => {
        const payload = buildNoAuthFuncPayload(contractId);
        const res = await client.submitSorobanTransaction({ func: payload.func, auth: payload.auth });
        printResult('func-auth-no-auth', { success: true, data: res }, debug);
      },
    },
    {
      id: 'func-auth-address-auth',
      label: 'func+auth: write_with_address_auth(addr, 777)',
      run: async ({ client, rpc, passphrase, address, keypair, contractId, debug }) => {
        const latest = await rpc.getLatestLedger();
        const validUntil = Number(latest.sequence) + 64;
        const invokeArgs = new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId).toScAddress(),
          functionName: 'write_with_address_auth',
          args: [Address.fromString(address).toScVal(), xdr.ScVal.scvU32(777)],
        });
        const func = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
        const rootInv = new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
          subInvocations: [],
        });
        const signedEntry = await authorizeInvocation(keypair, validUntil, rootInv, address, passphrase);
        const res = await client.submitSorobanTransaction({
          func: func.toXDR('base64'),
          auth: [signedEntry.toXDR('base64')],
        });
        printResult('func-auth-address-auth', { success: true, data: res }, debug);
      },
    },
  ];

  const selected = testId ? TESTS.filter((t) => t.id === testId) : TESTS;
  if (selected.length === 0) {
    console.error(`Unknown --test-id '${testId}'. Available: ${TESTS.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  console.log('════════════════════════════════════════════════════════');
  console.log('  Channels Plugin Smoke Tests');
  console.log('════════════════════════════════════════════════════════\n');

  const start = Date.now();

  if (concurrency <= 1) {
    // Sequential execution
    for (const t of selected) {
      console.log(`📋 ${t.label}...`);
      await t.run(ctx);
    }
  } else {
    // Parallel execution
    console.log(
      `📊 Running ${selected.length} test${selected.length > 1 ? 's' : ''} with ${concurrency}x concurrency...\n`
    );
    for (const t of selected) {
      console.log(`📋 ${t.label} (x${concurrency} parallel)...`);
      const testStart = Date.now();
      const promises = Array.from({ length: concurrency }, (_, i) =>
        t.run(ctx).then(
          () => ({ index: i, success: true, error: null }),
          (err) => ({ index: i, success: false, error: err })
        )
      );
      const results = await Promise.all(promises);
      const testElapsed = Date.now() - testStart;
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      console.log(
        `   ✓ Completed ${concurrency} requests in ${testElapsed}ms (${succeeded} succeeded, ${failed} failed)`
      );
      if (failed > 0) {
        console.log('   Errors:');
        results
          .filter((r) => !r.success)
          .forEach((r) => {
            const msg = r.error?.message || r.error;
            console.log(`     [${r.index}]: ${msg}`);
            if (ctx.debug && r.error?.errorDetails) {
              console.log(`            Details: ${JSON.stringify(r.error.errorDetails, null, 2)}`);
            }
          });
      }
      console.log('');
    }
  }

  const elapsed = Date.now() - start;
  console.log('════════════════════════════════════════════════════════');
  console.log(`✓ All tests completed in ${elapsed}ms`);
  console.log('════════════════════════════════════════════════════════');

  // Log fee usage if requested
  if (logFeesSpent) {
    console.log('\n📊 Fee Usage Report');
    console.log('────────────────────────────────────────────────────────');
    try {
      const usage = await client.getFeeUsage(apiKey);
      console.log(`   API Key: ${usage.apiKey}`);
      console.log(`   Consumed: ${usage.consumed.toLocaleString()} stroops`);
      console.log(`   Consumed: ${(usage.consumed / 10_000_000).toFixed(7)} XLM`);
    } catch (err: any) {
      console.error(`   ❌ Failed to fetch fee usage: ${err?.message || err}`);
    }
    console.log('════════════════════════════════════════════════════════');
  }
}

declare const fetch: any;

main().catch((e) => {
  // Handle client errors
  const args = parseArgs(process.argv.slice(2));
  const debug = Boolean(args['debug'] || process.env.DEBUG);

  console.error('❌ Error:', e?.message || String(e));
  if (e?.category) {
    console.error(`   Category: ${e.category}`);
  }
  if (e?.errorDetails && debug) {
    console.error(`   Details: ${JSON.stringify(e.errorDetails, null, 2)}`);
  }
  process.exit(1);
});

function printResult(label: string, envelope: any, debug: boolean) {
  if (debug) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  const data = envelope?.data || envelope?.result || {};
  const hash = data?.hash;
  const status = data?.status;
  const success = envelope?.success;

  if (success) {
    console.log(`   ✓ ${label}: ${hash || status || 'confirmed'}`);
  } else {
    const error = envelope?.error || 'unknown error';
    console.log(`   ✗ ${label}: ${error}`);
  }
}
