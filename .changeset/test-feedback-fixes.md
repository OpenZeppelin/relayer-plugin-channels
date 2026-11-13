---
'@openzeppelin/relayer-plugin-channels': minor
---

Fix error reporting and fee accounting issues found in external testing, and add sponsorship guardrails.

**Breaking**

- A signed transaction (`xdr` mode) must set `timeBounds.maxTime`. One without it is rejected with HTTP 400 `TIMEBOUNDS_MISSING`. Previously it was accepted and skipped the `MAX_TIME_BOUND_OFFSET_SECONDS` limit.
- A transaction whose fee bid (`max_fee`) exceeds `MAX_TRANSACTION_FEE` is rejected with HTTP 400 `MAX_FEE_EXCEEDED`. The new variable defaults to 100,000,000 stroops (10 XLM); operators that sponsor more expensive transactions must raise it.
- An invalid `FEE_LIMIT` (negative or not a number) is now a configuration error: every request, including management calls, fails with HTTP 500 `CONFIG_INVALID` until it is corrected. Previously the limit was silently disabled.

**Fixes**

- A transaction the network never accepted (the Relayer could not prepare it, or the network rejected it on submission) now returns `TRANSACTION_REJECTED` instead of `ONCHAIN_FAILED`. Clients that match on `ONCHAIN_FAILED` for these cases need to handle the new code.
- A transaction the Relayer reports as `expired` now returns `TRANSACTION_EXPIRED` (HTTP 400) instead of a successful response with `status: "expired"`.
- `details.resultCode` is populated for the Relayer 1.5.0+ failure reason format (`Outer` or `Outer:Inner`).
- Validation failures keep the Relayer's message instead of its last colon-separated fragment (previously `"20000000"` or `"MAX"`).
- The fee budget debits the fee the ledger charged for a confirmed transaction instead of `max_fee`, and debits nothing for a transaction the network never accepted. `WAIT_TIMEOUT` now debits `max_fee`, like `skipWait`, since the transaction may still land.
- `max_fee` is raised to the fee-bump minimum for the inner transaction, so a classic inner fee above 50,101 stroops no longer always fails. The bid for a classic transaction therefore follows the inner fee the client set, up to `MAX_TRANSACTION_FEE`.
- Malformed XDR returns HTTP 400 `INVALID_XDR`, a fee-bump envelope returns HTTP 400 `INVALID_ENVELOPE_TYPE`, and `getTransaction` with an unknown ID returns HTTP 404 `TRANSACTION_NOT_FOUND`. All three previously returned HTTP 500.
