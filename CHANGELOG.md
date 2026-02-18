# @openzeppelin/relayer-plugin-channels

## 0.11.0

### Minor Changes

- c9d2bf3: feat: Enforce soroban auth simulation & Improve inner failure details
- a76577e: feat: Introduce sequence number cache

## 0.10.0

### Minor Changes

- 2d3da9f: feat: Directly fetch channel sequence number

## 0.9.0

### Minor Changes

- ae032ad: Increase time-bounds tolerance to 120 seconds and reject expired transactions in submit and rebuild paths.

## 0.8.0

### Minor Changes

- e1a3c84: feat: Read only logic for transactions

## 0.7.0

### Minor Changes

- 1f9f2ae: fix: update smoke test defaults for direct HTTP mode
  chore: Add prettier config
  feat: add per-contract capacity limits for channel pool

## 0.6.0

### Minor Changes

- 0c4ba59: fix: return clean error messages instead of raw SDK objects
  feat: Use getRelayer instead of getRelayerStatus for fund relayer
  fix: use static fee calculation matching launchtube
  feat: support unsigned XDR by extracting func+auth automatically

## 0.5.0

### Minor Changes

- 63ff7a7: feat: Add fee tracking and management API

## 0.4.0

### Minor Changes

- ef37a6c: feat: Use relayer for all rpc calls

## 0.3.1

### Patch Changes

- f26098a: chore: update the relayer-sdk version

## 0.3.0

### Minor Changes

- f8a5901: feat: Add plugin client

## 0.2.0

### Minor Changes

- b643183: feat: Add channels plugin
