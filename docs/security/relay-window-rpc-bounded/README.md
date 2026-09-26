# The rpc-bounded relay window

This follows enclave-87's order of 2026-09-26. It runs AFTER rs-12. It is ONE api-relay restart, allowed mid-soak on these terms:
- ≥10 min after the previous restart;
- the NucBox mutex taken with the peer's ACK before starting;
- nucbox-k11 attach ACCEPTED;
- not during the reboot freeze.

## What gets pushed

relay/rpc-bounded @ 323d89db: one commit on main c6347dd2, bf GO, patch-id 7f8cc934.
- **(b)** The agreeing-RPC clients (catalogClients) get `retryCount: 1`: 2 attempts × 6 s, so about 12 s per provider per read,
  with both providers read in parallel.
- **(c)** `timedStep` logs ONE line when the confirmed ledger read or the prediction, on /v1/expected-guest or a release, takes
  over 5 s: "[secrets-release] slow <what> <id>: <step> took N s". Values and errors pass through unchanged.
- **(a)** Pinning DEPLOYMENTS_ADDRESS is HELD: a static pin would outlive a ledger migration.

## bf's notes (no change to the commit)

1. confirmRow is TWO sequential agreeing reads when confirmedLedger's 10-min cache has expired: the address book's deployments
   address, then get(id). The worst case is therefore about 24 s, not 12. The integration test stalls the providers from the
   first read, so it shows the first phase only.
2. catalogClients also feed the predictor's catalog reads (catalogReader) and versionConfigFor, so those get one retry too.
   Transient provider trouble surfaces somewhat more often as catalog_unreachable or "warming" 503s. Guests and clients retry
   those. This is INTENDED: a bounded answer instead of a 25 s hang. It is not a regression.

## Scripts

These are relay-window-20260926c's pacing scripts (bf GO, run and accepted at 06:44:45Z), with only the changes below.

**rb-push.sh:**
- the pins;
- 1 commit instead of 2;
- DRY must be exactly 0 or 1 (enclave-5d's gate finding: DRY=true must never read as a live run);
- nucbox-k11's row recorded before.

**rb-accept.sh:**
- the pushed files (api-relay.js 5b6c7e36, secrets-release.mjs 81d3f623);
- rs-11/rs-12's nucbox-k11 block: its attach line in the NEW invocation within 180 s, off the relay under 10 min, and the row
  equal to the one recorded before.

**rb-rollback.sh:** pace-rollback plus the owner-grace window's Deploy watch, requiring nan to run BASE's two files again.

**rb-recut.sh:** pace-recut, renamed.

**What stays the same:**
- the context guard;
- plain commit(s), with no symlink or node_modules path;
- the patch-id and the file list;
- no Deploy in progress, and the last Deploy on main = BASE + success;
- the ≥10 min restart age;
- the instant predictor probe, with automatic revert;
- health with CERT_SEPARATE, ADMIT = R (aee2059f alone after rs-12).

## Executed before review

- **rb-selftest.sh, 10/10.** It is read-only and calls no production path:
  - hv_row and hv_attach_line on the box and on a missing name;
  - files_are_pc refusing before the push;
  - rb-push.sh's DRY gate ONLY as a sandboxed copy (MAIN redirected; git, gh, ssh and curl as failing, logging shims):
    DRY=true, " 1", yes and 2 each refuse with rc 2, and no fetch, push, gh, ssh or curl is attempted.
- **DRY at 07:47:17Z PASSED.** It ran with ADMIT="5db18199 aee2059f", because rs-12 has not run yet. At the window, the default
  (R alone) applies.
