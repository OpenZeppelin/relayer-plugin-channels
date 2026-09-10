---
'@openzeppelin/relayer-plugin-channels': minor
---

Upgrade `@stellar/stellar-sdk` to v17 (Stellar Protocol 28). The plugin now parses and validates CAP-71 `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries, introduced in Protocol 27 and emitted by default by `@stellar/stellar-sdk` v17 clients. Previously such entries were rejected with `Invalid func or auth encoding`, and v2 auth entries returned by RPC simulation failed to parse. Legacy `SOROBAN_CREDENTIALS_ADDRESS` (v1) entries continue to be accepted; the plugin does not enforce a v1 cutoff. The auth expiry check (`AUTH_EXPIRY_TOO_SHORT`) now covers all address credential variants, including `SOROBAN_CREDENTIALS_ADDRESS_WITH_DELEGATES`.
