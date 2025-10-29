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

 Usage
   ts-node scripts/smoke.ts \
     --base-url http://localhost:8080 \
     --api-key $RELAYER_API_KEY \
     --account-name default \
     --contract-id <CONTRACT_ID>

 Flags / env (args > env > defaults)
   --base-url (BASE_URL)           default: http://localhost:8080
   --api-key (API_KEY)             required: relayer API key
   --test-id (TEST_ID)             optional: run only one test id
   --network (NETWORK)             default: testnet | also supports mainnet
   --rpc-url (RPC_URL)             default: https://soroban-testnet.stellar.org
   --account-name (ACCOUNT_NAME)   default: test-account
   --contract-id (CONTRACT_ID)     optional: defaults to bundled smoke-contract contract id
   --concurrency (CONCURRENCY)     optional: number of parallel requests per test (default: 1)
   --debug                         optional: print plugin logs/traces in responses
*/

import { execSync } from "child_process";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  SorobanRpc,
  Contract,
  xdr,
  Address,
  authorizeInvocation,
} from "@stellar/stellar-sdk";

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.includes("=") ? a.split("=") : [a, undefined];
    const key = k.replace(/^--/, "").trim();
    if (v !== undefined) out[key] = v;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function np(net: "testnet" | "mainnet") {
  return net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

async function healthCheck(baseUrl: string, apiKey: string): Promise<void> {
  const url = `${baseUrl}/api/v1/health`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  } as any).catch(
    (e: any) => ({ ok: false, statusText: e?.message || String(e) }) as any,
  );
  if (!res.ok)
    throw new Error(
      `Relayer health check failed: ${res.status} ${res.statusText}`,
    );
}

async function callPlugin(
  baseUrl: string,
  apiKey: string,
  params: any,
): Promise<any> {
  const url = `${baseUrl}/api/v1/plugins/channels/call`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ params }),
  } as any);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok)
    throw new Error(
      `Plugin call failed: HTTP ${res.status} ${res.statusText} -> ${JSON.stringify(data)}`,
    );
  return data;
}

function getKeypair(accountName?: string): {
  keypair: Keypair;
  address: string;
} {
  const name = accountName || "test-account";
  const address = execSync(`stellar keys address ${name}`, {
    encoding: "utf8",
  }).trim();
  const secret = execSync(`stellar keys show ${name}`, {
    encoding: "utf8",
  }).trim();
  return { keypair: Keypair.fromSecret(secret), address };
}

async function buildSignedSelfPayment(
  rpc: SorobanRpc.Server,
  passphrase: string,
  address: string,
  keypair: Keypair,
) {
  const account = await rpc.getAccount(address);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        source: address,
        destination: address,
        asset: Asset.native(),
        amount: "0.0000010",
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx;
}

function buildNoAuthFuncPayload(contractId: string) {
  const contract = new Contract(contractId);
  const op = contract.call("no_auth_bump", xdr.ScVal.scvU32(42));
  const body = (op as any).body();
  const invokeOp = body.invokeHostFunctionOp();
  const func = invokeOp.hostFunction();
  const auth = invokeOp.auth() ?? [];
  return {
    func: func.toXDR("base64"),
    auth: auth.map((a: any) => a.toXDR("base64")),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = String(
    args["base-url"] || process.env.BASE_URL || "http://localhost:8080",
  );
  const apiKey = String(args["api-key"] || process.env.API_KEY || "REPLACE_ME");
  const network = String(
    args.network || process.env.NETWORK || "testnet",
  ).toLowerCase() as "testnet" | "mainnet";
  const passphrase = np(network);
  const rpcUrl = String(
    args["rpc-url"] ||
      process.env.RPC_URL ||
      "https://soroban-testnet.stellar.org",
  );
  const accountName = String(
    args["account-name"] || process.env.ACCOUNT_NAME || "test-account",
  );
  const testId = (args["test-id"] || process.env.TEST_ID) as string | undefined;
  const debug = Boolean(args["debug"] || process.env.DEBUG);
  const concurrency = parseInt(
    String(args["concurrency"] || process.env.CONCURRENCY || "1"),
    10,
  );
  const contractId = String(
    args["contract-id"] ||
      process.env.CONTRACT_ID ||
      "CD3P6XI7YI6ATY5RM2CNXHRRT3LBGPC3WGR2D2OE6EQNVLVEA5HGUELG",
  );

  if (!apiKey || apiKey === "REPLACE_ME") {
    console.warn("⚠ Set --api-key or API_KEY to your relayer API key");
  }

  await healthCheck(baseUrl, apiKey);

  const rpc = new SorobanRpc.Server(rpcUrl);
  const { keypair, address } = getKeypair(accountName);

  type Ctx = {
    baseUrl: string;
    apiKey: string;
    rpc: SorobanRpc.Server;
    passphrase: string;
    keypair: Keypair;
    address: string;
    contractId: string;
    debug: boolean;
  };
  const ctx: Ctx = {
    baseUrl,
    apiKey,
    rpc,
    passphrase,
    keypair,
    address,
    contractId,
    debug,
  };

  const TESTS: {
    id: string;
    label: string;
    run: (ctx: Ctx) => Promise<void>;
  }[] = [
    {
      id: "xdr-payment",
      label: "XDR submit-only: signed self-payment",
      run: async ({
        baseUrl,
        apiKey,
        rpc,
        passphrase,
        address,
        keypair,
        debug,
      }) => {
        const tx = await buildSignedSelfPayment(
          rpc,
          passphrase,
          address,
          keypair,
        );
        const res = await callPlugin(baseUrl, apiKey, { xdr: tx.toXDR() });
        printResult("xdr-payment", res, debug);
      },
    },
    {
      id: "func-auth-no-auth",
      label: "func+auth: no_auth_bump(42)",
      run: async ({ baseUrl, apiKey, contractId, debug }) => {
        const payload = buildNoAuthFuncPayload(contractId);
        const res = await callPlugin(baseUrl, apiKey, {
          func: payload.func,
          auth: payload.auth,
        });
        printResult("func-auth-no-auth", res, debug);
      },
    },
    {
      id: "func-auth-address-auth",
      label: "func+auth: write_with_address_auth(addr, 777)",
      run: async ({
        baseUrl,
        apiKey,
        rpc,
        passphrase,
        address,
        keypair,
        contractId,
        debug,
      }) => {
        const latest = await rpc.getLatestLedger();
        const validUntil = Number(latest.sequence) + 64;
        const invokeArgs = new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId).toScAddress(),
          functionName: "write_with_address_auth",
          args: [Address.fromString(address).toScVal(), xdr.ScVal.scvU32(777)],
        });
        const func =
          xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
        const rootInv = new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              invokeArgs,
            ),
          subInvocations: [],
        });
        const signedEntry = await authorizeInvocation(
          keypair,
          validUntil,
          rootInv,
          address,
          passphrase,
        );
        const res = await callPlugin(baseUrl, apiKey, {
          func: func.toXDR("base64"),
          auth: [signedEntry.toXDR("base64")],
        });
        printResult("func-auth-address-auth", res, debug);
      },
    },
  ];

  const selected = testId ? TESTS.filter((t) => t.id === testId) : TESTS;
  if (selected.length === 0) {
    console.error(
      `Unknown --test-id '${testId}'. Available: ${TESTS.map((t) => t.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log("════════════════════════════════════════════════════════");
  console.log("  Channels Plugin Smoke Tests");
  console.log("════════════════════════════════════════════════════════\n");

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
      `📊 Running ${selected.length} test${selected.length > 1 ? "s" : ""} with ${concurrency}x concurrency...\n`,
    );
    for (const t of selected) {
      console.log(`📋 ${t.label} (x${concurrency} parallel)...`);
      const testStart = Date.now();
      const promises = Array.from({ length: concurrency }, (_, i) =>
        t.run(ctx).then(
          () => ({ index: i, success: true, error: null }),
          (err) => ({ index: i, success: false, error: err }),
        ),
      );
      const results = await Promise.all(promises);
      const testElapsed = Date.now() - testStart;
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      console.log(
        `   ✓ Completed ${concurrency} requests in ${testElapsed}ms (${succeeded} succeeded, ${failed} failed)`,
      );
      if (failed > 0) {
        console.log("   Errors:");
        results
          .filter((r) => !r.success)
          .forEach((r) => {
            console.log(`     [${r.index}]: ${r.error?.message || r.error}`);
          });
      }
      console.log("");
    }
  }

  const elapsed = Date.now() - start;
  console.log("════════════════════════════════════════════════════════");
  console.log(`✓ All tests completed in ${elapsed}ms`);
  console.log("════════════════════════════════════════════════════════");
}

declare const fetch: any;

main().catch((e) => {
  // Attempt to print compact error from plugin envelope
  const msg = e?.message || String(e);
  try {
    const jsonStart = msg.indexOf("{");
    if (jsonStart >= 0) {
      const env = JSON.parse(msg.slice(jsonStart));
      printResult("error", env, Boolean(process.env.DEBUG));
    } else {
      console.error(msg);
    }
  } catch {
    console.error(msg);
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
    console.log(`   ✓ ${label}: ${hash || status || "confirmed"}`);
  } else {
    const error = envelope?.error || "unknown error";
    console.log(`   ✗ ${label}: ${error}`);
  }
}
