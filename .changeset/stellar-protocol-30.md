---
'@openzeppelin/relayer-plugin-channels': patch
---

Bump `@stellar/stellar-sdk` to `^17.4.0` for Stellar Protocol 30 (Bell). SDK releases before 17.3.0 cannot decode CAP-84 muxed contract (W...) addresses, so XDR carrying them failed to parse after the upgrade.
