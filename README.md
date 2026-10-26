# Channels Plugin

A plugin for OpenZeppelin Relayer that enables parallel transaction submission on Stellar using channel accounts with fee bumping. Channel accounts provide unique sequence numbers for parallel transaction submission, preventing sequence number conflicts.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
  - [Install from npm](#1-install-from-npm-recommended)
  - [Use a local build](#2-use-a-local-build-for-development--debugging)
  - [Create the plugin wrapper](#create-the-plugin-wrapper)
  - [Configure the Relayer](#configure-the-relayer)
  - [Configure Environment Variables](#configure-environment-variables)
  - [Initialize Channel Accounts](#initialize-channel-accounts)
- [Development](#development)
- [Overview](#overview)
- [Architecture](#architecture)
- [Alternative Fund Relayers](#alternative-fund-relayers)
- [Per-Fund-Relayer Configuration](#per-fund-relayer-configuration)
  - [Dynamic Inclusion Fees](#dynamic-inclusion-fees)
  - [Timeout Overrides](#timeout-overrides)
  - [Transaction Parameter Overrides](#transaction-parameter-overrides)
  - [Configuration Precedence](#configuration-precedence)
- [Contract Capacity Limits](#contract-capacity-limits)
- [Management API](#management-api)
  - [List Channel Accounts](#list-channel-accounts)
  - [Set Channel Accounts](#set-channel-accounts)
  - [Get Fee Usage](#get-fee-usage)
  - [Get Fee Limit](#get-fee-limit)
  - [Set Fee Limit](#set-fee-limit)
  - [Delete Fee Limit](#delete-fee-limit)
- [Plugin Client](#plugin-client)
  - [Installation](#installation)
  - [Quick Start](#quick-start-1)
  - [Client Modes](#client-modes)
  - [Usage Examples](#usage-examples)
  - [Error Handling](#error-handling)
  - [Metadata and Debugging](#metadata-and-debugging)
  - [TypeScript Types](#typescript-types)
  - [Configuration Options](#configuration-options)
- [API Usage](#api-usage)
  - [Submit with Transaction XDR](#submit-with-transaction-xdr)
  - [Submit with Function and Auth](#submit-with-function-and-auth)
  - [Parameters](#parameters)
  - [Fire-and-Forget with skipWait](#fire-and-forget-with-skipwait)
  - [Idempotent Submissions](#idempotent-submissions)
  - [Get Transaction by ID](#get-transaction-by-id)
  - [Response](#response)
- [How It Works](#how-it-works)
- [Validation Rules](#validation-rules)
- [KV Schema](#kv-schema)
- [Error Codes](#error-codes)
- [Smoke Test Contract](#smoke-test-contract)
- [License](#license)

## Quick Start

**Want to get started quickly?** Check out the [Channels Plugin Example](https://github.com/OpenZeppelin/openzeppelin-relayer/tree/main/examples/channels-plugin-example) which includes a pre-configured relayer setup, Docker Compose configuration, and step-by-step instructions. This is the fastest way to get the Channels plugin up and running.

For manual installation and configuration details, continue reading below.

## Prerequisites

- Node.js >= 18
- pnpm >= 10
- OpenZeppelin Relayer

## Installation & Setup

The Channels plugin can be added to any OpenZeppelin Relayer in two ways:

### 1. Install from npm (recommended)

```bash
# From the root of your Relayer repository
cd plugins
mkdir channels
cd channels
pnpm add @openzeppelin/relayer-plugin-channels
```

### 2. Use a local build (for development / debugging)

```bash
# Clone and build the plugin
git clone https://github.com/openzeppelin/relayer-plugin-channels.git
cd relayer-plugin-channels
pnpm install
pnpm build
```

Now reference the local build from your Relayer's `plugins/package.json`:

```jsonc
{
  "dependencies": {
    "@openzeppelin/relayer-plugin-channels": "file:../../relayer-plugin-channels",
  },
}
```

Install dependencies:

```bash
pnpm install
```

---

### Create the plugin wrapper

Inside the Relayer create a directory for the plugin and expose its handler:

```bash
mkdir -p plugins/channels
```

`plugins/channels/index.ts`

```ts
export { handler } from '@openzeppelin/relayer-plugin-channels';
```

### Configure the Relayer

Before setting environment variables, you need to configure your Relayer's `config.json` with the fund account and channel accounts. Create or update your `config/config.json`:

```json
{
  "relayers": [
    {
      "id": "channels-fund",
      "name": "Channels Fund Account",
      "network": "testnet",
      "paused": false,
      "network_type": "stellar",
      "signer_id": "channels-fund-signer",
      "policies": {
        "concurrent_transactions": true
      }
    },
    {
      "id": "channel-001",
      "name": "Channel Account 001",
      "network": "testnet",
      "paused": false,
      "network_type": "stellar",
      "signer_id": "channel-001-signer"
    },
    {
      "id": "channel-002",
      "name": "Channel Account 002",
      "network": "testnet",
      "paused": false,
      "network_type": "stellar",
      "signer_id": "channel-002-signer"
    }
  ],
  "notifications": [],
  "signers": [
    {
      "id": "channels-fund-signer",
      "type": "local",
      "config": {
        "path": "config/keys/channels-fund.json",
        "passphrase": {
          "type": "env",
          "value": "KEYSTORE_PASSPHRASE_FUND"
        }
      }
    },
    {
      "id": "channel-001-signer",
      "type": "local",
      "config": {
        "path": "config/keys/channel-001.json",
        "passphrase": {
          "type": "env",
          "value": "KEYSTORE_PASSPHRASE_CHANNEL_001"
        }
      }
    },
    {
      "id": "channel-002-signer",
      "type": "local",
      "config": {
        "path": "config/keys/channel-002.json",
        "passphrase": {
          "type": "env",
          "value": "KEYSTORE_PASSPHRASE_CHANNEL_002"
        }
      }
    }
  ],
  "networks": "./config/networks",
  "plugins": [
    {
      "id": "channels",
      "path": "channel/index.ts",
      "timeout": 30,
      "emit_logs": true,
      "emit_traces": true
    }
  ]
}
```

**Important Configuration Notes:**

- **Fund Account** (`channels-fund`): Must have `"concurrent_transactions": true` in policies to enable parallel transaction processing
- **Channel Accounts**: Create at least 2 for better throughput (you can add more as `channel-003`, etc.)
- **Network**: Use `testnet` for testing or `mainnet` for production
- **Signers**: Each relayer references a signer by `signer_id`, and signers are defined separately with keystore paths
- **Keystore Files**: You'll need to create keystore files for each account - see [OpenZeppelin Relayer documentation](https://docs.openzeppelin.com/relayer) for details on creating and managing keys
- **Plugin Registration**: The `path` points to your plugin wrapper file relative to the plugins directory

For more details on Relayer configuration, see the [OpenZeppelin Relayer documentation](https://docs.openzeppelin.com/relayer).

### Configure Environment Variables

Set the required environment variables for the plugin:

```bash
# Required environment variables
export STELLAR_NETWORK="testnet"        # or "mainnet"
export FUND_RELAYER_ID="channels-fund"
export PLUGIN_ADMIN_SECRET="your-secret-here"  # Required for management API

# Optional environment variables
# Comma-separated list of allowed alternative fund relayers (e.g., for x402 or similar flows)
export ALLOWED_FUND_RELAYER_IDS="x402-channels-fund"
export LOCK_TTL_SECONDS=10              # default: 30, min: 3, max: 60

# Fee tracking (optional)
export FEE_LIMIT=1000000                  # Default max fee per API key in stroops (disabled if not set)
export FEE_RESET_PERIOD_SECONDS=86400     # Reset fee consumption every N seconds (e.g., 86400 = 24 hours)
export API_KEY_HEADER="x-api-key"         # Header name to extract API key (default: x-api-key)

# Contract capacity limits (optional)
export LIMITED_CONTRACTS="CDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIGWA"  # Comma-separated contract addresses
export CONTRACT_CAPACITY_RATIO=0.8        # Max ratio of pool for limited contracts (default: 0.8 = 80%)

# Inclusion fee overrides (optional)
export INCLUSION_FEE_DEFAULT=203           # Inclusion fee in stroops for regular contracts (default: BASE_FEE * 2 + 3 = 203)
export INCLUSION_FEE_LIMITED=201           # Inclusion fee in stroops for limited contracts (default: BASE_FEE * 2 + 1 = 201)

# Sequence number cache (optional)
export SEQUENCE_NUMBER_CACHE_MAX_AGE_MS=120000  # Max age of cached sequence numbers in ms (default: 120000)

# Auth expiry validation (optional)
export MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER=2  # Minimum ledger margin for auth entry signatureExpirationLedger (default: 2)

# Transaction timebounds (optional)
export MAX_TIME_BOUND_OFFSET_SECONDS=60  # Max future offset for tx maxTime in seconds (default: 60)

# Request timeouts (optional)
export PLUGIN_GLOBAL_TIMEOUT_MS=30000    # Overall request timeout in ms (default: 30000)
export PLUGIN_POLLING_TIMEOUT_MS=25000   # Transaction polling timeout in ms (default: 25000)

# Idempotency-Key retention (optional)
export IDEMPOTENCY_KEY_TTL_SECONDS=3600 # How long a key returns its transaction (default: 3600, min: 300)
```

Your Relayer should now contain:

```
relayer/
└─ plugins/
   └─ channels/
      ├─ package.json           # lists the dependency
      └─ index.ts
```

### Initialize Channel Accounts

Before using the Channels plugin, you must configure channel accounts using the management API:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "setChannelAccounts",
        "adminSecret": "your-secret-here",
        "relayerIds": ["channel-0001", "channel-0002", "channel-0003"]
      }
    }
  }'
```

The Channels plugin is now ready to serve Soroban transactions 🚀

## Development

### Building from Source

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm build

# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm format
```

## Overview

The Channels plugin accepts Soroban operations and handles all the complexity of getting them on-chain:

- Automatic fee bumping using a dedicated fund account
- Parallel transaction execution with a pool of channel accounts
- Transaction simulation and resource management
- Error handling and confirmation waiting

## Architecture

- **Fund Account**: Holds funds and pays for fee bumps
- **Channel Accounts**: Provide unique sequence numbers for parallel transaction submission
- The channel account is the transaction source and signer; the fund account wraps it in a fee bump

## Alternative Fund Relayers

The plugin supports optional secondary fund relayers for [x402](https://www.x402.org/) and similar payment flows. Pass `fundRelayerId` in the request and allowlist that ID through `ALLOWED_FUND_RELAYER_IDS`.

### Configuration

```bash
export ALLOWED_FUND_RELAYER_IDS="x402-fund"
```

Every allowed alternative fund relayer must reference a relayer configured in your Relayer's `config.json`, just like the primary fund account. Add it alongside your existing relayers:

```json
{
  "id": "x402-fund",
  "name": "x402 Fund Account",
  "network": "testnet",
  "paused": false,
  "network_type": "stellar",
  "signer_id": "x402-fund-signer",
  "policies": {
    "concurrent_transactions": true,
    "fee_payment_strategy": "relayer"
  }
}
```

### Preferred usage

Pass `fundRelayerId` in any `xdr` or `func`+`auth` request to route fee bumping through the specified fund relayer:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "xdr": "AAAAAgAAAAB...",
      "fundRelayerId": "x402-fund"
    }
  }'
```

Or with `func`+`auth`:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "func": "AAAABAAAAAEAAAAGc3ltYm9s...",
      "auth": ["AAAACAAAAAEAAAA..."],
      "fundRelayerId": "x402-fund"
    }
  }'
```

### Notes

- If `fundRelayerId` is provided but not listed in `ALLOWED_FUND_RELAYER_IDS`, the plugin rejects the request
- When `fundRelayerId` is omitted, the primary `FUND_RELAYER_ID` is used
- `fundRelayerId` must be a non-empty string
- `getTransaction` requests can also include `fundRelayerId`; polling should use the same relayer selection as submission

## Per-Fund-Relayer Configuration

Individual fund relayers can have custom settings for fees, timeouts, and transaction parameters. This is configured via the plugin's `config` field in the relayer's `config.json`, not via environment variables.

Environment variables define **global defaults**. Per-fund-relayer settings **override** them for requests that use that fund relayer. Requests using fund relayers without overrides (or the default fund relayer) use the global env-var defaults unchanged.

### Setup

Add a `config` block to the plugin definition in your relayer's `config.json`:

```json
{
  "plugins": [
    {
      "id": "channels",
      "path": "channels/index.ts",
      "config": {
        "fundRelayers": {
          "x402-fund": {
            "dynamicFee": {
              "enabled": true,
              "percentile": "p50",
              "cacheTtlMs": 10000
            },
            "timeouts": {
              "globalTimeoutMs": 45000,
              "pollingTimeoutMs": 40000
            },
            "transactionParams": {
              "maxTimeBoundOffsetSeconds": 120,
              "minSignatureExpirationLedgerBuffer": 5
            }
          }
        }
      }
    }
  ]
}
```

All sections (`dynamicFee`, `timeouts`, `transactionParams`) are optional. You can configure any combination.

### Dynamic Inclusion Fees

When enabled, the plugin fetches real-time fee data from Soroban RPC `getFeeStats` and uses a percentile of `sorobanInclusionFee` as the inclusion fee, instead of the static 201/203 stroops.

| Field        | Type    | Default | Description                                                                                                 |
| ------------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `enabled`    | boolean | —       | Must be `true` to activate dynamic fees                                                                     |
| `percentile` | string  | `"p50"` | Which percentile to use. Valid: `p10`, `p20`, `p30`, `p40`, `p50`, `p60`, `p70`, `p80`, `p90`, `p95`, `p99` |
| `cacheTtlMs` | number  | `10000` | How long to cache the fee stats result (ms). Shared across all workers via KV store                         |

When dynamic fees are active, the same fee is used for both limited and non-limited contracts (the limited/non-limited distinction is static tuning that dynamic fees replace).

On any RPC or cache failure, the plugin falls back to the global static fees (`INCLUSION_FEE_DEFAULT` / `INCLUSION_FEE_LIMITED`), preserving the limited/non-limited split.

### Timeout Overrides

Override request timeouts for specific fund relayers. Useful when certain traffic sources (e.g., x402) need longer processing windows.

| Field              | Type   | Default                                 | Description                                    |
| ------------------ | ------ | --------------------------------------- | ---------------------------------------------- |
| `globalTimeoutMs`  | number | env `PLUGIN_GLOBAL_TIMEOUT_MS` (30000)  | Overall request timeout in ms                  |
| `pollingTimeoutMs` | number | env `PLUGIN_POLLING_TIMEOUT_MS` (25000) | Transaction confirmation polling timeout in ms |

### Transaction Parameter Overrides

Override transaction construction and validation parameters per fund relayer.

| Field                                | Type   | Default                                          | Description                                                                             |
| ------------------------------------ | ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `maxTimeBoundOffsetSeconds`          | number | env `MAX_TIME_BOUND_OFFSET_SECONDS` (60)         | Max future offset for tx `maxTime`. Also controls validation of incoming XDR timebounds |
| `minSignatureExpirationLedgerBuffer` | number | env `MIN_SIGNATURE_EXPIRATION_LEDGER_BUFFER` (2) | Minimum ledger margin required for auth entry `signatureExpirationLedger`               |

### Configuration Precedence

Settings are resolved per request in this order (first match wins):

1. **Per-fund-relayer override** — from `config.fundRelayers[fundRelayerId]` in `config.json`
2. **Global env var** — from the corresponding environment variable
3. **Built-in default** — hardcoded constant in the plugin

Example: a request with `fundRelayerId: "x402-fund"` where the plugin config has `timeouts.globalTimeoutMs: 45000` and the env var `PLUGIN_GLOBAL_TIMEOUT_MS=30000`:

- The x402-fund request uses 45000ms
- All other requests use 30000ms (env var default)

## Contract Capacity Limits

High-volume contracts can monopolize the channel pool, starving other traffic. Contract capacity limits allow you to reserve a portion of the pool for non-limited contracts.

### Configuration

```bash
# Comma-separated list of contract addresses to limit (case-insensitive)
export LIMITED_CONTRACTS="CDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIGWA,CABC123..."

# Maximum ratio of pool that limited contracts can use (default: 0.8)
export CONTRACT_CAPACITY_RATIO=0.8
```

### How It Works

- **Limited contracts** can only acquire from a deterministic subset of channels (e.g., 80% of pool)
- **Unlisted contracts** have full access to all channels
- The subset is selected deterministically using a hash-based partition, ensuring stable channel assignment
- Minimum 1 channel is always guaranteed, even at very low ratios

### Example

With 10 channel accounts and `CONTRACT_CAPACITY_RATIO=0.8`:

- Limited contracts can use up to 8 channels (`floor(10 * 0.8)`)
- 2 channels are always reserved for non-limited traffic
- If all 8 limited slots are in use, limited contracts get `POOL_CAPACITY` error while non-limited contracts can still acquire

### Notes

- Contract IDs are matched case-insensitively (normalized to uppercase internally)
- If contract ID cannot be extracted from the request (non-`invokeContract` operations), no limit is applied
- Zero runtime overhead for unlimited contracts

## Management API

The Channels plugin provides a management API to dynamically configure channel accounts. This API requires authentication via the `PLUGIN_ADMIN_SECRET` environment variable.

### List Channel Accounts

Get the current list of configured channel accounts:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "listChannelAccounts",
        "adminSecret": "your-secret-here"
      }
    }
  }'
```

**Response:**

```json
{
  "relayerIds": ["channel-0001", "channel-0002", "channel-0003"]
}
```

### Set Channel Accounts

Configure the channel accounts that the plugin will use. This replaces the entire list:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "setChannelAccounts",
        "adminSecret": "your-secret-here",
        "relayerIds": ["channel-0001", "channel-0002", "channel-0003"]
      }
    }
  }'
```

**Response:**

```json
{
  "ok": true,
  "appliedRelayerIds": ["channel-0001", "channel-0002", "channel-0003"]
}
```

### Get Fee Usage

Query fee consumption for a specific API key:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "getFeeUsage",
        "adminSecret": "your-secret-here",
        "apiKey": "client-api-key-to-query"
      }
    }
  }'
```

**Response:**

```json
{
  "consumed": 500000,
  "limit": 1000000,
  "remaining": 500000,
  "periodStartAt": "2024-01-15T00:00:00.000Z",
  "periodEndsAt": "2024-01-16T00:00:00.000Z"
}
```

- `limit`: Effective fee limit (custom if set, otherwise default)
- `remaining`: Remaining fee budget in stroops
- `periodStartAt`: Datetime string when current period started (if reset period configured)
- `periodEndsAt`: Datetime string when period will reset (if reset period configured)

### Get Fee Limit

Query fee limit configuration for a specific API key:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "getFeeLimit",
        "adminSecret": "your-secret-here",
        "apiKey": "client-api-key-to-query"
      }
    }
  }'
```

**Response:**

```json
{
  "limit": 500000
}
```

### Set Fee Limit

Set a custom fee limit for a specific API key:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "setFeeLimit",
        "adminSecret": "your-secret-here",
        "apiKey": "client-api-key",
        "limit": 500000
      }
    }
  }'
```

**Response:**

```json
{
  "ok": true,
  "limit": 500000
}
```

Note: If custom limit is set to 0 it will block all transactions

### Delete Fee Limit

Remove a custom fee limit for a specific API key (reverts to default limit):

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "deleteFeeLimit",
        "adminSecret": "your-secret-here",
        "apiKey": "client-api-key"
      }
    }
  }'
```

**Response:**

```json
{
  "ok": true
}
```

### Get Pool Stats

Returns pool health metrics, configuration, and fee info.

```bash
curl -X POST http://localhost:8080/... \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "management": {
        "action": "stats",
        "adminSecret": "your-secret-here"
      }
    }
  }'
```

**Response:**

```json
{
  "pool": {
    "size": 5,
    "locked": 2,
    "available": 3
  },
  "config": {
    "network": "testnet",
    "lockTtlSeconds": 30,
    "feeLimit": 10000,
    "feeResetPeriodSeconds": 3600,
    "contractCapacityRatio": 0.8,
    "limitedContracts": []
  },
  "fees": {
    "inclusionFeeDefault": 203,
    "inclusionFeeLimited": 201
  }
}
```

> **Note:** If lock checks fail, `locked` and `available` will be `undefined` rather than causing the request to fail. The `size` and config info are always returned.

**Important Notes:**

- You must configure at least one channel account before the plugin can process transactions
- The management API will prevent removing accounts that are currently locked (in use). On failure it throws a plugin error with status 409, code `LOCKED_CONFLICT`, and `details.locked` listing blocked IDs.
- All relayer IDs must exist in your OpenZeppelin Relayer configuration
- The `adminSecret` must match the `PLUGIN_ADMIN_SECRET` environment variable

## Plugin Client

The Channels plugin provides a TypeScript client for easy integration into your applications. The client automatically handles request/response formatting, error handling, and supports both relayer mode and direct HTTP mode.

### Installation

```bash
npm install @openzeppelin/relayer-plugin-channels
# or
pnpm add @openzeppelin/relayer-plugin-channels
```

### Quick Start

```typescript
import { ChannelsClient } from '@openzeppelin/relayer-plugin-channels';

// Connecting to OpenZeppelin's managed Channels service
const client = new ChannelsClient({
  baseUrl: 'https://channels.openzeppelin.com',
  apiKey: 'your-api-key',
});

// Connecting to your own Relayer with Channels plugin
const relayerClient = new ChannelsClient({
  baseUrl: 'http://localhost:8080',
  pluginId: 'channels',
  apiKey: 'your-relayer-api-key',
  adminSecret: 'your-admin-secret', // Optional: Required for management operations
});
```

### Configuration

**Managed Service**

When connecting to OpenZeppelin's managed Channels service (which runs behind Cloudflare and a load balancer), provide just the `baseUrl` and `apiKey`:

```typescript
// Mainnet
const client = new ChannelsClient({
  baseUrl: 'https://channels.openzeppelin.com',
  apiKey: 'your-api-key',
});

// Testnet
const testnetClient = new ChannelsClient({
  baseUrl: 'https://channels.openzeppelin.com/testnet',
  apiKey: 'your-api-key',
});
```

**Generate API Keys:**

- Testnet: https://channels.openzeppelin.com/testnet/gen
- Mainnet: https://channels.openzeppelin.com/gen

**Self-Hosted Relayer**

When connecting directly to your own OpenZeppelin Relayer instance, include the `pluginId`:

```typescript
const client = new ChannelsClient({
  baseUrl: 'http://localhost:8080',
  pluginId: 'channels',
  apiKey: 'your-relayer-api-key',
  adminSecret: 'your-admin-secret', // Optional: Required for management operations
});
```

The client automatically routes requests appropriately based on whether `pluginId` is provided

### Usage Examples

#### Submit Signed XDR Transaction

```typescript
// Submit a complete, signed transaction
const result = await client.submitTransaction({
  xdr: 'AAAAAgAAAAC...', // Complete transaction envelope XDR
});

console.log(result.hash); // Transaction hash
console.log(result.status); // Transaction status
console.log(result.transactionId); // Relayer transaction ID
```

#### Submit Soroban Function with Auth

```typescript
// Submit func+auth (uses channel accounts and simulation)
const result = await client.submitSorobanTransaction({
  func: 'AAAABAAAAAEAAAAGc3ltYm9s...', // Host function XDR (base64)
  auth: ['AAAACAAAAAEAAAA...'], // Auth entry XDRs (base64)
});

console.log(result.hash);
```

#### Submit with Alternative Fund Relayer

```typescript
// Submit using an alternative fund relayer for fee bumping
const result = await client.submitTransaction({
  xdr: 'AAAAAgAAAAC...', // Complete transaction envelope XDR
  fundRelayerId: 'x402-fund',
});

// Also works with func+auth
const result2 = await client.submitSorobanTransaction({
  func: 'AAAABAAAAAEAAAAGc3ltYm9s...',
  auth: ['AAAACAAAAAEAAAA...'],
  fundRelayerId: 'x402-fund',
});
```

#### List Channel Accounts (Management)

```typescript
// Initialize client with admin secret
const adminClient = new ChannelsClient({
  baseUrl: 'http://localhost:8080',
  apiKey: 'your-api-key',
  pluginId: 'channels',
  adminSecret: 'your-admin-secret', // Required for management operations
});

// List configured channel accounts
const accounts = await adminClient.listChannelAccounts();
console.log(accounts.relayerIds); // ['channel-001', 'channel-002', ...]
```

#### Set Channel Accounts (Management)

```typescript
// Configure channel accounts (requires adminSecret)
const result = await adminClient.setChannelAccounts(['channel-001', 'channel-002', 'channel-003']);

console.log(result.ok); // true
console.log(result.appliedRelayerIds); // ['channel-001', 'channel-002', 'channel-003']
```

#### Get Fee Usage (Management)

```typescript
// Query fee consumption for an API key (requires adminSecret)
const usage = await adminClient.getFeeUsage('client-api-key');

console.log(usage.consumed); // 500000 (stroops)
console.log(usage.limit); // 1000000 (effective limit)
console.log(usage.remaining); // 500000 (remaining budget)
console.log(usage.periodStartAt); // '2024-01-15T00:00:00.000Z'
console.log(usage.periodEndsAt); // '2024-01-16T00:00:00.000Z'
```

#### Get Fee Limit (Management)

```typescript
// Query fee limit configuration for an API key (requires adminSecret)
const limitInfo = await adminClient.getFeeLimit('client-api-key');

console.log(limitInfo.limit); // 500000 (custom limit if set, otherwise default)
```

#### Set Fee Limit (Management)

```typescript
// Set a custom fee limit for an API key (requires adminSecret)
const result = await adminClient.setFeeLimit('client-api-key', 500000);

console.log(result.ok); // true
console.log(result.limit); // 500000
```

#### Delete Fee Limit (Management)

```typescript
// Remove custom fee limit, revert to default (requires adminSecret)
const result = await adminClient.deleteFeeLimit('client-api-key');

console.log(result.ok); // true
```

#### Get Pool Stats (Management)

```typescript
// Get pool health metrics (requires adminSecret)
const stats = await adminClient.getStats();

console.log(stats.pool.size); // total channels
console.log(stats.pool.locked); // currently in-use
console.log(stats.pool.available); // size - locked
console.log(stats.config.network); // 'testnet' or 'mainnet'
console.log(stats.fees); // inclusion fee values
```

### Error Handling

The client provides three types of errors:

```typescript
import {
  PluginTransportError,
  PluginExecutionError,
  PluginUnexpectedError,
} from '@openzeppelin/relayer-plugin-channels';

try {
  const result = await client.submitTransaction({ xdr: '...' });
} catch (error) {
  if (error instanceof PluginTransportError) {
    // Network/HTTP failures (connection refused, timeout, 500/502/503)
    console.error('Transport error:', error.message);
    console.error('Status code:', error.statusCode);
  } else if (error instanceof PluginExecutionError) {
    // Plugin rejected the request (validation, business logic, on-chain failure)
    console.error('Execution error:', error.message);
    console.error('Details:', error.errorDetails);
  } else if (error instanceof PluginUnexpectedError) {
    // Client-side parsing/validation errors
    console.error('Unexpected error:', error.message);
  }
}
```

### Metadata and Debugging

Responses include optional metadata (logs and traces) when the plugin is configured with `emit_logs` and `emit_traces`:

```typescript
const result = await client.submitTransaction({ xdr: '...' });

// Access metadata if available
if (result.metadata) {
  console.log('Logs:', result.metadata.logs);
  console.log('Traces:', result.metadata.traces);
}
```

### TypeScript Types

All request and response types are fully typed:

```typescript
import type {
  ChannelsXdrRequest, // includes optional x402 field
  ChannelsFuncAuthRequest, // includes optional x402 field
  ChannelsTransactionResponse,
  ListChannelAccountsResponse,
  SetChannelAccountsResponse,
  GetFeeUsageResponse,
  GetFeeLimitResponse,
  SetFeeLimitResponse,
  DeleteFeeLimitResponse,
} from '@openzeppelin/relayer-plugin-channels';
```

### Configuration Options

```typescript
interface ChannelsClientConfig {
  // Required
  baseUrl: string; // Service URL
  apiKey: string; // API key for authentication

  // Optional
  pluginId?: string; // Include when connecting to a Relayer directly
  adminSecret?: string; // Required for management operations
  timeout?: number; // Request timeout in ms (default: 30000)
  apiKeyHeader?: string; // Header name for API key (default: 'x-api-key')
  pluginApiKey?: string; // Caller's own plugin API key, sent in apiKeyHeader (default: apiKey)
}
```

## API Usage

### Submit with Transaction XDR

Submit a complete, signed transaction:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "xdr": "AAAAAgAAAAB..."
    }
  }'
```

### Submit with Function and Auth

Submit just the Soroban function and auth entries:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "func": "AAAABAAAAAEAAAAGc3ltYm9s...",
      "auth": ["AAAACAAAAAEAAAA..."]
    }
  }'
```

### Parameters

- `xdr` (string): Complete transaction envelope XDR (signed, not fee-bump)
- `func` (string): Soroban host function XDR (base64)
- `auth` (array): Array of Soroban authorization entry XDRs (base64)
- `skipWait` (boolean, optional): When `true`, returns immediately after submitting the transaction without waiting for confirmation. Defaults to `false`. Must be a boolean — non-boolean values (e.g., `"false"`, `1`) are rejected.
- `fundRelayerId` (string, optional): Uses the specified alternative fund relayer for fee bumping instead of the primary fund account. Must be present in `ALLOWED_FUND_RELAYER_IDS`.
- `getTransaction` (object, optional): Poll for a transaction's status by ID. Cannot be combined with other parameters.

**Note**: Provide either `xdr` OR `func`+`auth` OR `getTransaction`, not a combination.

### Fire-and-Forget with `skipWait`

When `skipWait: true` is passed with an `xdr` or `func`+`auth` request, the plugin submits the transaction and returns immediately with status `"pending"` instead of waiting for on-chain confirmation. This is useful for high-throughput scenarios where the caller handles confirmation separately.

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "xdr": "AAAAAgAAAAB...",
      "skipWait": true
    }
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "transactionId": "tx_123456",
    "status": "pending",
    "hash": null
  }
}
```

Use the returned `transactionId` with `getTransaction` to poll for the final status.

### Idempotent Submissions

Send an `Idempotency-Key` header with an `xdr` or `func`+`auth` submission to make retrying it safe. If the reply to a submission is lost (timeout, dropped connection), resend the same request with the same key: the plugin returns the transaction the first request created instead of submitting a second one.

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "x-api-key: YOUR_PLUGIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2a9e-3b6d-4f2e-9c1a-0d7e5b2f8a41" \
  -d '{
    "params": {
      "func": "AAAABgAAAA...",
      "auth": ["AAAABwAAAA..."],
      "skipWait": true
    }
  }'
```

With the plugin client, pass `{ idempotencyKey }` as the second argument of `submitTransaction` or `submitSorobanTransaction`.

**Requires OpenZeppelin Relayer 1.9.0 or later.** The plugin sends every transaction for a key with a fund relayer idempotency key, and relies on the Relayer to create at most one transaction per fund relayer key and to return it to a repeated send. Older Relayers ignore that key. Keep the Relayer's `IDEMPOTENCY_KEY_TTL_SECONDS` (default 24 hours) at least as long as the plugin's.

| Repeated request with the same key                                                         | Result                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same request, first one created a transaction                                              | That transaction, with its current `status` and `hash` (the first request's wait is not repeated; poll with `getTransaction`). A transaction that failed on chain returns the same `ONCHAIN_FAILED` error as the first request                                                                                                                                     |
| Same request, first one is sending and its reply may still arrive (up to about 35 seconds) | `409 IDEMPOTENCY_KEY_IN_PROGRESS`; retry shortly                                                                                                                                                                                                                                                                                                                   |
| Same request, first one sent its transaction but the reply was lost                        | The identical signed transaction is resent under the same fund relayer key, so the Relayer returns the transaction it created (or creates it if it has none). The response carries that transaction's `status`; one that failed on chain returns `ONCHAIN_FAILED`                                                                                                  |
| Same request, and the fund relayer answers that resend with an error                       | `503 IDEMPOTENCY_KEY_SEND_FAILED`; retry with the same key, never a new one. The error (for example a paused relayer) does not show whether the original transaction exists, so the key keeps its stored transaction. Once that transaction's `maxTime` has passed, the response is `422 IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` instead, so you can check it and move on |
| Same request, and the Relayer no longer has the transaction (pruned after it became final) | `422 IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`; see below                                                                                                                                                                                                                                                                                                                   |
| Same request, first one has not sent yet                                                   | `409 IDEMPOTENCY_KEY_IN_PROGRESS`; retry shortly                                                                                                                                                                                                                                                                                                                   |
| Different request                                                                          | `422 IDEMPOTENCY_KEY_REUSED`                                                                                                                                                                                                                                                                                                                                       |
| First one failed before sending                                                            | Processed as a new request                                                                                                                                                                                                                                                                                                                                         |
| First one's send got a fund relayer error                                                  | The first request already returned `503 IDEMPOTENCY_KEY_SEND_FAILED`. A repeat resends the stored transaction right away (no `409` wait), as in the lost-reply row                                                                                                                                                                                                 |

Notes:

- A signed `xdr` sent with a key must set `timeBounds.maxTime` (`400 TIMEBOUNDS_REQUIRED` otherwise): the stored transaction is resent until it lands or expires, and one that never expires could leave its key retrying for ever. `func`+`auth` and unsigned `xdr` transactions are built with time bounds.
- The key is 1 to 255 visible ASCII characters (the Relayer drops header values with other characters, which would make the call not idempotent). Keys are scoped to the caller: the API key header (`x-api-key`, or `API_KEY_HEADER`), or the `Authorization` header when there is no API key. A key sent with neither is rejected with `400 API_KEY_REQUIRED`. The Relayer has a single API key, so callers that rely on the `Authorization` fallback, or that send the Relayer API key as their plugin API key, share one namespace. Give each caller its own plugin API key to keep their keys apart; with the plugin client in Relayer mode, set `pluginApiKey` (by default the client sends the Relayer API key in `apiKeyHeader`).
- Keys are kept for `IDEMPOTENCY_KEY_TTL_SECONDS` from the first request; repeats do not extend that (default 1 hour, minimum 5 minutes; raised automatically to the transaction's lifetime when that is longer). This is the longest a caller can wait before retrying a lost reply: a retry after the key has expired is processed as a new request.
- Choose the key's scope to match what you want deduplicated. Use a key unique to one logical operation, for example one settlement attempt; reusing a key across operations makes them share a transaction.
- Before sending, the plugin stores the exact signed fee bump request under the key, and it never builds a second transaction for a key that has one. Once the transaction id is recorded, the stored request is dropped and the record shrinks to about 200 bytes.
- Once the transaction is stored under the key, a send error never frees the key, and the response is `503 IDEMPOTENCY_KEY_SEND_FAILED` telling the caller to retry the same key: the Relayer checks the relayer (paused, disabled) and its storage before it looks an idempotency key up, and can fail after storing a transaction, so an error does not show that no transaction exists. Only the stored transaction is ever sent again, which is always safe: the Relayer returns the transaction it holds for the fund relayer key, or creates it once. For `func`+`auth` and unsigned `xdr`, the channel account stays locked until the transaction expires, since a repeat resends on its sequence. During a fund relayer outage each such request holds its channel account until the transaction expires, so keyed traffic can use up the pool.
- A transaction the Relayer failed because it could not queue its jobs ("Queue unavailable", no hash) was never submitted: it returns `502 TRANSACTION_NOT_SUBMITTED` instead of `ONCHAIN_FAILED`, and a repeat does not charge it. Other failures without a hash are still reported as `ONCHAIN_FAILED`, since the Relayer clears the hash when it resets a transaction after a bad sequence. Every repeat returns the same error, since the key is bound to that transaction: resubmit with a new key, which is safe.
- `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` means the outcome cannot be read from the Relayer: the stored transaction expired while resends kept getting errors, or the Relayer no longer has the key's transaction: it completed and was removed from the Relayer's storage (`TRANSACTION_EXPIRATION_HOURS`, by default 4 hours after it became final), or its create stopped before storing it. Keep the plugin's `IDEMPOTENCY_KEY_TTL_SECONDS` below that age to avoid it. The error gives `details.innerHash`, `details.source` (the channel account), `details.sequence` and `details.maxTime`. `innerHash` is the hash of the inner transaction; the fund relayer wraps it in a fee bump, which the network records under a different hash, so a lookup by `innerHash` can come back empty for a transaction that landed. Search the transactions of `details.source` for a fee bump whose inner transaction hash is `innerHash` before retrying with a new key.
- A transaction sent under a key is charged against the API key's fee budget once, whether by the first request or by a repeat (for example when the first request's wait timed out or its reply was lost). As for a request without a key, it is charged when it is `confirmed` or `failed` on chain, or at send with `skipWait` (before its outcome is known); a repeat that finds it still pending, expired or not submitted does not charge it.
- If the first request stopped after reserving the key but before sending, a retry gets `409` until the request budget (global timeout plus `maxTimeBoundOffsetSeconds` plus one ledger of channel cooldown) has passed, then is processed as a new request.

### Get Transaction by ID

Poll for the status of a previously submitted transaction using its `transactionId`. This is typically used after a `skipWait` submission to check whether the transaction has been confirmed.

```bash
curl -X POST http://localhost:8080/api/v1/plugins/channels/call \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "getTransaction": {
        "transactionId": "tx_123456"
      }
    }
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "transactionId": "tx_123456",
    "status": "confirmed",
    "hash": "1234567890abcdef..."
  }
}
```

The `status` field reflects the transaction's current state (e.g., `"pending"`, `"sent"`, `"submitted"`, `"confirmed"`, `"failed"`, `"expired"`). The `hash` field is `null` until the transaction is submitted.

### Response

Responses follow the Relayer envelope `{ success, data, error }`.

Success example:

```json
{
  "success": true,
  "data": {
    "transactionId": "tx_123456",
    "status": "confirmed",
    "hash": "1234567890abcdef..."
  },
  "error": null
}
```

Plugin error example:

```json
{
  "success": false,
  "data": {
    "code": "POOL_CAPACITY",
    "details": {}
  },
  "error": "Too many transactions queued. Please try again later"
}
```

## How It Works

1. **Request Validation**: Validates input parameters (xdr OR func+auth)
2. **Channel Account Pool**: Acquires an available channel account from the pool
3. **Transaction Building**: For func+auth, builds transaction with channel as source
4. **Simulation**: Simulates transaction to obtain sorobanData and resource fee
5. **Signing**: Channel account signs the transaction
6. **Fee Calculation**: Calculates dynamic max_fee based on resource fee
7. **Fee Bumping**: Fund account wraps transaction with fee bump
8. **Submission**: Sends to Stellar network and waits for confirmation
9. **Pool Release**: Returns channel account to the pool

## Validation Rules

### Input Validation

- Must provide `xdr` OR `func`+`auth` (not both)
- XDR must not be a fee-bump envelope
- All parameters must be valid base64 XDR

### Transaction Validation (XDR mode)

- Envelope type must be `envelopeTypeTx` (not fee bump)
- TimeBounds maxTime must be within 30 seconds from now

## KV Schema

### Membership List

- **Key**: `<network>:channel:relayer-ids`
- **Value**: `{ relayerIds: string[] }`

### Channel Locks

- **Key**: `<network>:channel:in-use:<relayerId>`
- **Value**: `{ token: string, lockedAt: ISOString }`
- **TTL**: Configured by `LOCK_TTL_SECONDS`.

### Fee Tracking

- **Key**: `<network>:api-key-fees:<apiKey>`
- **Value**: `{ consumed: number, periodStart?: number }` (fees in stroops, period start timestamp in ms)

### Custom Fee Limits

- **Key**: `<network>:api-key-limit:<apiKey>`
- **Value**: `{ limit: number }` (custom fee limit in stroops)

### Sequence Number Cache

- **Key**: `<network>:channel:seq:<address>`
- **Value**: `{ sequence: string, storedAt: number }` (sequence number and cache timestamp in ms)

### Idempotency Keys

- **Key**: `<network>:idempotency:<sha256(scope + "\n" + key)>`, where `scope` is `api-key:<API key>` or `authorization:<Authorization header>`
- **Value**: `{ fingerprint, reservedAt, expiresAt, payload?, sentAt?, maxFee?, transactionId?, transaction? }`. While a send is unresolved the record holds the signed fee bump request (`payload`, about 2 KB) and its send time; once the transaction is created it holds `transactionId`, `maxFee` and the inner transaction's `{ innerHash, source, sequence, maxTime }` (about 400 bytes).
- **TTL**: `IDEMPOTENCY_KEY_TTL_SECONDS` (default 1 hour), counted from the reservation. The record stores this fixed expiry (`expiresAt`), and every later write keeps it
- **Fund relayer key**: `channels-idempotency:<digest>:<reservedAt>`, sent with every send for a reservation
- **Fee marker key**: `<network>:idempotency:<digest>:<reservedAt>:fee`, one per reservation (a marker can outlive its record, and a later reservation of the key is a new transaction), kept 5 minutes past the record's expiry so a repeat never finds the record without it, written right after the transaction's fee is added to the API key's consumption (under the same lock), so a repeat does not charge it again. A failed consumption update leaves no marker, so a later repeat records the fee.

## Error Codes

### Configuration

- `CONFIG_MISSING`: Missing required environment variable
- `CONFIG_INVALID`: Invalid configuration value (e.g., invalid contract address in `LIMITED_CONTRACTS`)
- `UNSUPPORTED_NETWORK`: Invalid network type

### Request Validation

- `INVALID_PARAMS`: Invalid request parameters
- `INVALID_XDR`: Failed to parse XDR
- `INVALID_ENVELOPE_TYPE`: Not a regular transaction envelope
- `INVALID_UNSIGNED_XDR`: Unsigned XDR must contain exactly one `invokeHostFunction` operation
- `INVALID_TIME_BOUNDS`: TimeBounds too far in the future
- `TIMEBOUNDS_EXPIRED`: Transaction timebounds have expired
- `TIMEBOUNDS_TOO_FAR`: Transaction timebounds maxTime too far in the future
- `TIMEBOUNDS_REQUIRED`: A signed XDR sent with an `Idempotency-Key` has no `timeBounds.maxTime` (HTTP 400)
- `FEE_MISMATCH`: Fee mismatch in signed transaction
- `INVALID_OPERATION_SOURCE`: Operation source does not match transaction source
- `INVALID_IDEMPOTENCY_KEY`: `Idempotency-Key` header is empty, longer than 255 characters, or has characters outside visible ASCII (HTTP 400)
- `IDEMPOTENCY_KEY_IN_PROGRESS`: Another request with this `Idempotency-Key` has not created its transaction yet (HTTP 409)
- `IDEMPOTENCY_KEY_REUSED`: `Idempotency-Key` reused with a different request (HTTP 422)
- `IDEMPOTENCY_KEY_SEND_FAILED`: The fund relayer returned an error for the transaction stored under this `Idempotency-Key`; it may still have been stored, so retry with the same key, never a new one (HTTP 503)
- `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`: The outcome of the transaction sent for this `Idempotency-Key` cannot be read from the Relayer (it expired while resends got errors, or the Relayer no longer has it); check whether it landed before using a new key (HTTP 422)
- `TRANSACTION_NOT_SUBMITTED`: The fund relayer failed the transaction before submitting it to the network because it could not queue it. Under an `Idempotency-Key` the key is spent; nothing reached the network, so resubmitting with a new key is safe (HTTP 502)

### Pool & Channel

- `NO_CHANNELS_CONFIGURED`: No channel accounts have been configured via management API
- `POOL_CAPACITY`: All channel accounts in use
- `RELAYER_UNAVAILABLE`: Relayer not found
- `FAILED_TO_GET_SEQUENCE`: Failed to fetch channel account sequence number
- `ACCOUNT_NOT_FOUND`: Channel account not found on the ledger
- `CHANNEL_LOCK_LOST`: The channel account lock expired before the transaction was sent; nothing was sent, retry the request (HTTP 503)

### Simulation & Assembly

- `SIMULATION_FAILED`: Transaction simulation failed
- `SIMULATION_NETWORK_ERROR`: Simulation network request failed (HTTP 502)
- `SIMULATION_RPC_FAILURE`: Simulation RPC provider error (HTTP 502)
- `SIMULATION_SIGNED_AUTH_VALIDATION_FAILED`: Signed auth entry validation failed in enforce-mode simulation
- `AUTH_EXPIRY_TOO_SHORT`: Auth entry `signatureExpirationLedger` too close to current ledger
- `ASSEMBLY_FAILED`: Transaction assembly failed

### Submission

- `INVALID_SIGNATURE`: Invalid channel signature response
- `ONCHAIN_FAILED`: Transaction failed on-chain
- `WAIT_TIMEOUT`: Transaction wait timeout

### Fee Tracking

- `API_KEY_REQUIRED`: API key header missing when `FEE_LIMIT` is configured, or an `Idempotency-Key` sent with neither an API key nor an `Authorization` header
- `FEE_LIMIT_EXCEEDED`: API key has exceeded its fee limit (HTTP 429)

### Management

- `MANAGEMENT_DISABLED`: Management API not enabled
- `UNAUTHORIZED`: Invalid admin secret
- `INVALID_ACTION`: Invalid management action
- `INVALID_PAYLOAD`: Invalid management request payload
- `LOCKED_CONFLICT`: Cannot remove locked channel accounts
- `KV_ERROR`: KV store operation failed

## License

MIT
