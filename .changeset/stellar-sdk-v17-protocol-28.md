---
'@openzeppelin/relayer-plugin-channels': minor
---

Upgrade `@stellar/stellar-sdk` to v17 (Stellar Protocol 28). The plugin now parses and validates CAP-71 `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries. These were introduced in Protocol 27, are emitted by default by `@stellar/stellar-sdk` v17 clients, and per the [Stellar Protocol 27 upgrade guide](https://stellar.org/blog/foundation-news/stellar-zipper-protocol-27-upgrade-guide) replace the legacy `SOROBAN_CREDENTIALS_ADDRESS` type at the Protocol 28 upgrade (mainnet vote scheduled for 2026-09-16). Previously such entries were rejected with `Invalid func or auth encoding`, and auth entries returned by RPC simulation in v2 form failed to parse. Legacy v1 entries continue to be accepted. The auth expiry check (`AUTH_EXPIRY_TOO_SHORT`) now covers all address credential variants.
