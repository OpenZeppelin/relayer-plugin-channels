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
- [Management API](#management-api)
  - [List Channel Accounts](#list-channel-accounts)
  - [Set Channel Accounts](#set-channel-accounts)
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
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export FUND_RELAYER_ID="channels-fund"
export PLUGIN_ADMIN_SECRET="your-secret-here"  # Required for management API

# Optional environment variables
export LOCK_TTL_SECONDS=10              # default: 30, min: 3, max: 30
export MAX_FEE=1000000                  # default: 1,000,000 stroops
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
  ChannelsXdrRequest,
  ChannelsFuncAuthRequest,
  ChannelsTransactionResponse,
  ListChannelAccountsResponse,
  SetChannelAccountsResponse,
} from '@openzeppelin/relayer-plugin-channels';
```

### Configuration Options

```typescript
interface ChannelsClientConfig {
  // Required
  baseUrl: string; // Service or Relayer URL
  apiKey: string; // API key for authentication

  // Optional
  pluginId?: string; // Include when connecting to a Relayer directly
  adminSecret?: string; // Required for management operations
  timeout?: number; // Request timeout in ms (default: 30000)
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

**Note**: Provide either `xdr` OR `func`+`auth`, not both.

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

## Error Codes

- `CONFIG_MISSING`: Missing required environment variable
- `UNSUPPORTED_NETWORK`: Invalid network type
- `INVALID_PARAMS`: Invalid request parameters
- `INVALID_XDR`: Failed to parse XDR
- `INVALID_ENVELOPE_TYPE`: Not a regular transaction envelope
- `INVALID_TIME_BOUNDS`: TimeBounds too far in the future
- `NO_CHANNELS_CONFIGURED`: No channel accounts have been configured via management API
- `POOL_CAPACITY`: All channel accounts in use
- `RELAYER_UNAVAILABLE`: Relayer not found
- `SIMULATION_FAILED`: Transaction simulation failed
- `ONCHAIN_FAILED`: Transaction failed on-chain
- `WAIT_TIMEOUT`: Transaction wait timeout
- `MANAGEMENT_DISABLED`: Management API not enabled
- `UNAUTHORIZED`: Invalid admin secret
- `LOCKED_CONFLICT`: Cannot remove locked channel accounts

## License

MIT
