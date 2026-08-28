---
'@openzeppelin/relayer-plugin-channels': minor
---

Upgrade `@stellar/stellar-sdk` to v17 (Stellar Protocol 28). The plugin now parses and validates CAP-71 `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries, which current client SDKs emit by default and which become mandatory once Protocol 28 activates on mainnet (vote scheduled for 2026-09-16). Previously such entries were rejected with `Invalid func or auth encoding`, and auth entries returned by Protocol 28 RPC simulation failed to parse. The auth expiry check (`AUTH_EXPIRY_TOO_SHORT`) now covers all address credential variants.
