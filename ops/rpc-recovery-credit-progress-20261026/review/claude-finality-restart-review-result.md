# Finality restart review: result (PREPARED; design only; nothing run; restart qualification NOT integrated)

**Output:** `base-finality-proof-stage/restart-review/`. `SHA256SUMS` sha256 is `b451861f7136001fa318229785da227fcf8b5de6928873d045fc62e12b277566`:

| File | sha256 |
|---|---|
| `DESIGN.md` | `bdc7e38a4c5bc9779248c7b644c3e968a149f2d78596cfde99fed8f015750e8b` |
| `README.md` | `e9d3e042f2d12fd6f301c44ae0e0a92faed890c46eb00c62d0290064a1f14d26` |

**Untouched (checked):**
- the frozen parent stage, whose `SHA256SUMS` `e21761c2…` still verifies;
- launcher r3, whose `MANIFEST.sha256` verifies;
- the M10 and harness sources (read only).

**HOLD flags:** all three are still `False`: `FINALITY_PROOF_REVIEWED` (r3 producer), `LAUNCH_PRODUCER_REVIEWED` (r3 wrapper) and
`FINALITY_PROTOTYPE_REVIEWED` (prototype).

**What Claude did:** reads, sha256 and writing text only. No tests, builds, queue jobs, SSH or network access, live actions or commits.

## Findings, traced in the real code

1. **Today a crash or reboot fails closed, with no recovery path.**
   - The unit's `Restart=on-failure` (every 300 s) re-runs the wrapper.
   - `launch_handshake` refuses the `consumed` journal (`chain_service.py:647`).
   - `rearm` requires the stopped DB unchanged at N, with no header above N (`base_launch.py:253-280`), so it refuses once the node has run.
   - Even with an allowed journal, the wrapper always passes `--bootstrap.anchor N:hash` (`:663`). M10's precondition then requires EL `latest` == N exactly, with labels ≤ N, so it fails closed.
   - There is no replay, and also no restart.
2. **The prototype cannot enable restart** (root's review is confirmed). `status()` qualifies only the same running process, and the optional patch adds no transition. This is an integration gap.
3. **Recommended design R-A: re-anchor restart.** Each step already exists as reviewed code:
   1. roll back the old launch (terminal);
   2. capture a fresh A1 for a newer N'';
   3. A2: header N'' is authenticated;
   4. A3: offline unwind of the DB head to N'', which discards every unauthenticated block above it;
   5. A4: full merkle rebuild at N'', the only real full-state DB proof in source;
   6. bytecodes and release;
   7. `produce` a new launch record, then root pins it;
   8. `arm`, which catches post-proof DB tamper;
   9. an anchored start: M10 checks head == N'' and wipes the SafeDB.

   New rules: a monotonic anchor (N'' > the previous N and > any served height; a new game), a predecessor binding in the
   launch record, no use of the old process's finality status or node labels, and N'' inside the held changeset floor.
4. **R-A is not executable yet.** Four source changes, owned by others, are missing:
   - the harness N bound `[52,500,000, 53,048,526)` (`a2a4.py:116-117`), plus a root decision on `gate_download` for a DB that has run;
   - the producer's single A1 pin `b9a90847…` (`base_launch.py:145`), which needs a per-launch pin or fresh-initial with capture binding;
   - launch-record predecessor fields, verified by the wrapper;
   - the capture binding of the A1 runner.

   Restart cost (unwind plus full rebuild) has not been measured.
5. **Rejected design R-B: fast resume.** No cheap, real proof of a stopped DB's full state exists in source:
   - mdbx identity doesn't detect content changes;
   - the finality journal describes a process, not disk bytes;
   - a clean-stop seal doesn't exist and is impossible after a crash;
   - an unanchored start would trust our own unsafe and finalized labels and SafeDB.

   **The missing real DB proof is exactly this:** a full-state verification of the *stopped* DB at an *authenticated* height without unwinding. Only A4 (after unwinding to that height) provides one.
6. **Producer provenance gaps.** Root-owned files are not capture evidence. `run.py`'s run record does not bind:
   - its own sha;
   - `a1-config.json`, the l1-authority config, or the ASR source `portal-result.json`;
   - `l1_authority.py` and the node binary;
   - `ANCHOR_DEPS_ROOT` dependencies.

   It also hashes modules by path before executing the same paths, and writes `run-result.json` non-exclusively. The prototype's same-directory `run.py` check is **not** a capture binding. The required runner revision is specified in DESIGN §4 and is **not** written.
7. **Correction.** Replace "no newer finalized game exists" with **"no fresh newer A1 receipt has been captured here"**.
   - Root's recheck `l1-a1-recheck-retry-2152/recheck.json` (2026-10-25T21:53:07Z) records a latest-anchor **observation**: game `0x27d5e3b9…`, N 52,869,960, `advanced: true`, `accepted: false`.
   - It is not an A1-authenticated receipt.
   - No network was used, so nothing newer is known.
8. **Root's prototype run (0211):** JS 20/20; Python 26/27. In the failing test, the `older` fixture writes a byte-identical run record, so `replayed` fires before `not_newer`. The tool's replay check is correct. The fix belongs in a new revision: give each fixture run a distinct valid run identity, never weaken replay. It is not applied: the stage is frozen.

## Why no code or tests

Every change R-A needs lives in other owners' in-flight files: the launcher r3+, the harness and the A1 runner. R-B is
rejected. No code here could supply the missing DB proof, so adding code would only fork those owners' work. There is
therefore **no root test job** for this revision.

## Next steps (root decisions)

1. Accept or reject R-A.
2. If accepted, assign the four source changes and a reviewed A1-runner capture-binding revision.
3. Fix the prototype fixture in a new revision.
4. Measure the A3/A4 cost on the real DB.
5. Until all of these land and pass, Base must stay down after any crash or reboot. That is today's fail-closed behaviour, and nothing here changes it.
