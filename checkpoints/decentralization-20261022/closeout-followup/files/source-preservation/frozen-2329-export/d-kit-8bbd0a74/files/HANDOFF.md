# HANDOFF: boot GPU-price activation kit (source only; ROOT EXECUTES every live phase)

Recorded 2026-10-23T23:02:35Z (date -u). D ran no live operation: no SSH, chain write, key or production change. Root's final log stays in root's folder copy only (logs/root-* is gitignored); its sha256 is below.

## What is tested

**The tested source:** 32 files, digest 2fb95679…0033. That is the sha256 of the sorted `sha256sum` list; the list is in
`TESTED-SOURCE.sha256`. These are exactly the files of this commit, apart from the documentation, logs and this handoff.

**Authoritative run:** root's `logs/root-final-tests.out` / `.rc`, 22:59:32Z to 23:01:25Z, queue 512, exit **0**. It started
after the last source edit (22:52:04Z).

| Check | Result |
|---|---|
| python | **47/47** |
| node | **14/14** (boot-funding, attest-price, fee-fit) |
| mutants | **78, survived 0**; the unmutated control passes |
| scans | gitleaks 0, scan-crypto-keys 0, rewritten literal 0 (63 files) |

**Kept as an honest record, NOT a pass:**
- **t3:** the source changed while it ran. It still reported 2 survivors, now covered by tests.
- **t10:** the process vanished, with no rc.
- **t1 to t9:** intermediate states.

## What the kit enforces (README.md)

- **Source and build:**
  - the build folder's pinned `precheck.py` re-derives 7dd3acd0, a single-parent child of 9f6d37bd;
  - root's real build is accepted: measurement b007d471…, supervisor 916780f9, gsup f8dee4dc, decision fe25be11;
  - `build.json` is accepted only with root's `APPROVED-BUILD.txt`.
- **Admission:** additive 37 → 38, with a new backup name.
- **Funding:** the approved decision must be setProofKey both PENDING (null) and DISCOVERED (1667). Row 834/1667, the
  same sender, 25% headroom.
- **Expectation:** the config-derived shielded-GPU expectation, through the pinned launcher.
- **Margin:**
  - **At the write:** > 1440 s on both leases (600 floor + 420 window + 120 attach + 300 adopt).
  - **Before the gate:** a FRESH verified read (block -30..105 s old, same holder, > 600 s), retried for at most 105 s, which
    seeds the watchdog.
  - **During gate v4 (unchanged):** a watchdog read every ≤ 60 s, each ≤ 45 s. The gate is stopped (its whole group) when the
    last block is > 105 s old (absolute), the holder changes, or a lease is ≤ 600 s from expiry.
  - **After a PASS:** a fresh read by the same holder with > 480 s left.
  - A stopped gate is never a PASS.
- **Signals:** SIGHUP/SIGTERM fail into the safe rollback, which then ignores signals.
- **Registry:** the boot's path and setProofKey tx are recorded, never as a pass/fail input.
- **Keep:** only an `attest-price.mjs` verdict is accepted: priceRecovery, accepted, failedChecks exactly [], the approved
  measurement and buildSha256, fresh, after attach, raw 0600.
- **Legacy limit:** the proof key is NOT SNP-bound.

## State root reported (not verified by D)

- **Build:** sha 117d0b…; b007 staged at `dist-leasegas-7dd3acd06`.
- **Relay:** 38-entry env 136a65…, recheck PASS, old control connected.
- **No control restart.**
- **Funding 22:55Z:** failed on the 25% headroom, although both actions were setProofKey. **Root must re-check
  `funding.py` before any activation**; the gate is unchanged and is not weakened.

## Open (root)

- Time the cutover just after a PAIRED renewal (both leases > 1440 s at the write).
- Run `activate.py` in a surviving session.
- Re-read the guest record digests after KEEP.
- H-REVIEW finding 5 (pool GPU price) is residual; root confirmed live 834/1667 at 22:46:12Z.
- root-final-tests.out sha256: 57c115264f5e87ff618c5cee9afd4ce2c58a4c3360a714122bc51eda66f33d50, .rc = 0
