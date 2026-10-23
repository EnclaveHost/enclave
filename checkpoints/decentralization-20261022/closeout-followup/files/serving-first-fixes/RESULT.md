# Serving-first fixes F1 + F3: RESULT (2026-10-22)

**Status:** source only, committed locally in an isolated copy. NOT deployed, NOT pushed. Root reviews before activation.
Frozen 829/2afa, the checkpoint and the helpers were not touched. No SSH or network.

## Commit and hashes

| item | value |
|---|---|
| repo | `serving-first-fixes/candidate`: an rsync copy of `windows-serving-first/candidate` at `829a881c` (clean) |
| commit | **`e7e5057acc73d654e4ddf188bdaef89fe23d8e11`**, tree `ef5118b7b8f1289bdf414015a691938cfb8f9d55`, parent `829a881c`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `serving-first-fixes.patch` = `git diff 829a881c e7e5057a`, sha256 `1dc8e0115efb8179826fecbb005a96850fb7037dd9a2cafa11153f532418590f` (2 files, +82/−6) |
| `windows/node/host.mjs` | 829 `817389ec…` → **`ea0f6b8ab9562e95cc20e82ea0d6cc6c7a242445d0a8608195f50ebb711c00de`** |
| `windows/node/chain.mjs` | unchanged `3e9fae03…` |
| `test/windows-node-lease-renewal-keeper.test.mjs` | `519c431cec67fda2d8d2a84085760470f74517a66e74efdaa86a71ebe230f267` (+2 cases) |

Activation, as for 829, swaps two files: host `ea0f6b8a` and chain `3e9fae03`.

## Changes (host.mjs only; every gate in `#reconcileTracked` is untouched)

**F1: membership epoch.**
- `this.tracked` is now a `TrackedSet` (a `Set` subclass) that moves a per-id epoch on an add of an absent id or a delete
  of a present one. It is filled after construction. Nothing else changes: same API, same persistence (`[...tracked]`).
- `#tickOnce` snapshots the epochs right after phase 1. Phase 2 reconciles every id tracked now whose epoch differs, plus
  the deferred re-claims. That covers sweep claims and resumes, a phase-1 retire re-claimed in the same pass, and removal
  plus re-add during the sweep.
- Ids phase 1 handled that stayed tracked are not re-run (unchanged).
- The deferral is a `Symbol` (`DEFERRED`), no longer the string `"deferred"`.

**F3: per-id guard (`#reconcileGuarded`, both phases).** A throw fails only that deployment for this pass:
- `#leaseSeen.delete`: not keeper-eligible;
- `#renewVoid`: any permit taken for it is void;
- a `not-ready` readiness row for this pass's sequence, carrying the error class;
- one log line;
- the other deployments and the claim sweep continue, and it is retried next pass.

**Wallet allows are deliberately not revoked by the guard:**
- every throw path before this pass's fresh decision already revokes or holds first (`#stopApp`, `#giveUpOnce`,
  `#walletHold`), or catches internally (decision, row read, edit/resize, renewal);
- an existing allow came from a fresh decision on a fresh row, lives 90 s or less, and the refresher refreshes it only
  under its own fresh-row and fresh-decision checks;
- revoking on an adoption error would only cut a legitimately admitted app off the network.

**Unchanged:**
- tick single-flight;
- admin, platform, wallet, placement and owner gates;
- the release journal and the give-up wait for a renewal in flight;
- renewal permits and epochs;
- `retireForeignRecovered` after the sweep.

**F2 (documented, not changed).** After a MANAGER or host restart, phase-1 fresh spawns can meet the manager's 503
("recovered partitions are reconciled") until the post-sweep `retireForeignRecovered` runs.
- That is a transient hold, one pass later, with no release.
- Moving the retire earlier is wrong: the sweep re-tracks live untracked leases.
- A node-only restart is unaffected.

## Tests

Queue 512, offline (`unshare -rn --pid --fork --kill-child`, `--test-timeout`, `timeout -k`), with ssh/scp/sftp denial stubs.
Logs are in `logs/`.

| run | tree | result |
|---|---|---|
| `fx1-512` | candidate `ea0f6b8a` | keeper suite **16/16**, including the 2 new cases (peak 177 MiB) |
| `fx1-512` | `tmp/base-829` (hard-linked copy, 829 host `817389ec` as a separate file, same test file) | **14/16: F1 FAILS** (readiness `pending` ≠ `ready`); **F3 FAILS** (`Error: manager unreachable (test)` escapes the pass) |
| `fx2-reg-512` | candidate | same sets as the sibling's 829 runs: regA (capacity-boundary, giveup-once, hosting-caps, norenew, owner-set, stopapp-tick, tick-single-flight) **67/67**; regB (offchain-heartbeat-writers, wallet-grant-refresh, wallet-network-hold, wallet-policy) **29 pass, 3 skipped** (Anvil/openssl, as for 829); lease-readiness, including the pwsh gate case (PWSH 7.6.6), **9/9**; peak 293 MiB |

**New cases** (real Host plus chain.mjs; only `scanLedger` and `ensureApp` are stubbed, as in the sibling's cases):
- **F1:** an own lease ended 30 s ago, so phase 1 retires it and untracks it. A sweep that re-claims it (leaving the record,
  row and VM a landed `consider()` leaves) then lets phase 2 reconcile it in the same pass: readiness `ready`. Later the
  keeper renews it inside its window, and no operator transaction occurs.
- **F3:** `ensureApp` throws for A. The pass does not reject. The sweep runs, B reads `ready`, and A reads `not-ready` with
  its error and the log line. The keeper renews B once and A never.

**Limits:**
- The F1 sweep is emulated, not the real `consider()` claim path (the scripted sender refuses claims).
- No mutation run beyond the base control.
- No native Windows run.
- F2 has no test.
