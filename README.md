# Channels Plugin

A plugin for OpenZeppelin Relayer that enables parallel transaction submission on Stellar using channel accounts with fee bumping. Channel accounts provide unique sequence numbers for parallel transaction submission, preventing sequence number conflicts.

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

### Configure Environment Variables

Set the required environment variables for the plugin:

```bash
# Required environment variables
export STELLAR_NETWORK="testnet"        # or "mainnet"
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export FUND_RELAYER_ID="channels-fund"
export PLUGIN_ADMIN_SECRET="your-secret-here"  # Required for management API

# Optional environment variables
export LOCK_TTL_SECONDS=30              # default: 30, min: 10, max: 30
export MAX_FEE=1000000                  # default: 1,000,000 stroops
```

Your Relayer should now contain:

```
relayer/
└─ plugins/
   ├─ package.json              # lists the dependency
   └─ channels/
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

## Configuration

The Channels plugin is configured through environment variables:

**Required Environment Variables:**

- `STELLAR_NETWORK`: Either "testnet" or "mainnet"
- `SOROBAN_RPC_URL`: Stellar Soroban RPC endpoint
- `FUND_RELAYER_ID`: Relayer ID for the account that pays fees
- `PLUGIN_ADMIN_SECRET`: Secret for accessing the management API

**Optional Environment Variables:**

- `LOCK_TTL_SECONDS`: TTL for channel account locks (default: 30, range: 10-30)
- `MAX_FEE`: Cap for max_fee calculation (default: 1,000,000 stroops)

**Note:** Channel accounts are managed dynamically through the Management API (see below).

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
- **TTL**: Configured by `LOCK_TTL_SECONDS`

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

---

## Smoke Test Contract

This repo includes a minimal Soroban contract and smoke test script that exercise the Channels plugin with different authorization methods.

### Contract

- **Path**: `contracts/smoke-contract`
- **Functions**:
  - `no_auth_bump(n: u32) -> u32` — No auth required; returns n+1
  - `write_with_address_auth(addr: Address, value: u32)` — Requires address auth; writes value to storage
  - `read_value(addr: Address) -> u32` — Reads stored value for address

Build/optimize/deploy with the Stellar CLI:

```bash
# Using helper script
bash contracts/smoke-contract/contract.sh build
bash contracts/smoke-contract/contract.sh optimize
bash contracts/smoke-contract/contract.sh deploy --network testnet --account test-account
```

### Smoke Test Script

- **Path**: `scripts/smoke.ts`
- **Requirements**:
  - Node.js 18+
  - Stellar CLI (`stellar`) configured with a key
  - Channels plugin running at base URL

Environment variables:

```bash
export BASE_URL="http://localhost:8080"      # relayer origin
export API_KEY="<relayer-api-key>"           # required
export NETWORK="testnet"                     # or "mainnet"
export RPC_URL="https://soroban-testnet.stellar.org"
export ACCOUNT_NAME="test-account"           # key in `stellar keys`
export CONTRACT_ID="CDXX..."                 # deployed smoke-contract
```

Run (args override env):

```bash
pnpm ts-node scripts/smoke.ts \
  --api-key YOUR_API_KEY \
  --account-name test-account \
  --contract-id CDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Show all options in the script header
```

What it does:

- Health-checks the relayer
- XDR submit-only: signs a small self-payment and submits via fee bump
- func+auth (no auth): calls `no_auth_bump(42)` using a channel account
- func+auth (address auth): calls `write_with_address_auth(addr, 777)` with signed auth entries
