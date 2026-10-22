# Site release: reconcile fixes (late activation, lock, undo retry, identity, atomic history)

Repo `work/enclave`, HEAD `45801c22`. Nothing is committed and nothing was staged.

**What I did not do:** no deployment, production use, real SSH hosts, GitHub settings, wallet use or commits.

**What I did not edit:** CLI core, browser, storage, Windows, custody, ipns-publisher or contract files.

The release-pointer proposal is unchanged and held for review.

Source hashes are in `work/site-release-final-source-inventory.json`, regenerated after the last test run.

## The defects, and the fixes in `scripts/site-release/root-state.mjs` and `rollout.mjs`

### 1. A late activation committed after resolve had reported "reverted" (confirmed by the coordinator's repro)

- **Cause:** resolve settled a lost send with a read (`result`), and "unknown-op" was taken as "not received".
- **Fix:** a lost operation is now settled with **`cancel`**, under the root lock:
  - if the operation already ran, cancel returns its recorded result, so compensation then proceeds, fenced;
  - otherwise cancel writes a durable **tombstone** in `ops/<opId>.json`. A later arrival of that same opId finds it and
    returns `cancelled` (a replay); it never runs.
- An unreachable cancel keeps the target `unknown`, so the rollout stays `pending`. Nothing is inferred from silence.
- **Evidence:**
  - the coordinator's original script `work/site-late-activation-repro.mjs` still reproduces only against the old API.
    It now stops with "activate needs … the root id", because its calls lack a root id and its journal is v1. Its files
    and its evidence are unchanged;
  - `work/site-late-activation-repro-v2.mjs` is the same scenario on the fixed API. Its output,
    `work/site-late-activation-repro-v2.json`, shows `reported: "reverted"`, target `cancelled`, late outcome
    `cancelled` (replay), and the root still at the original CID at generation 1: **`fixed: true`**;
  - both race orders are tests (below), locally and over real SSH.

### 2. The stale-PID lock takeover was racy

**The replacement:** an OS lock, `flock(2)` through util-linux `flock -x [-n|-w S] FILE cat`. Our process writes a byte
that `cat` echoes, and `cat` only runs once the kernel has granted the lock.

| Situation | What happens |
| --- | --- |
| Normal end | The holder releases by closing the helper's stdin. |
| Holder exits or crashes | Its pipe closes, `cat` gets EOF, `flock` exits, and the kernel releases the lock. |
| Lock file | Never unlinked, so there is no file-level takeover at all. |
| No `flock` available | Linux-only; the tool refuses ("there is no racy fallback"). |

**Two bugs found while testing it, both fixed:**
- **A crash on refusal (the reported EPIPE near line 56).** When `flock -n` refused, it exited before reading our byte,
  and the write's EPIPE crashed the process. A `stdin` error handler now turns that into the `LockedError` it should be.
- **The 300 s timeout in `site-rollout`.** The cause was the test's own holder fixture, not the library. The fixture
  acquired the lock and never released it; the helper handle kept its event loop alive, so a waiting contender acquired
  but never exited. The fixture now exits after its hold time, which is the "holder exits" path the kernel must clean
  up. I found and stopped 4 orphaned fixture processes of mine from the earlier hung runs (by command line); their
  `flock` helpers then exited by themselves, which confirms the crash-release property. No helper or holder remains.

### 3. A failed undo was permanent

- Undo attempts now have their own identities, `undo-<opId>-<n>` with n from 1 to 9. Each is fenced on the original
  activation's generation and CID, so A-B-A safety is kept, and an attempt after a committed one returns that commit.
- A failed attempt first goes back to the activation, **confirmed**. The outcome is `failed` (definite: still serving the
  activation), and compensation may make attempt n+1, one per run.
- A lost attempt is settled with cancel before any new attempt.

### 4. The journal mapped targets by name only

- The journal is now v2. Each entry carries the target's identity (the local root path; the SSH host, port, user,
  agent and the sha256 of each trusted host key for that host) and the root's durable `rootId`.
- **`resolve` refuses** a targets file whose same-name entry differs: status `pending`, "identity mismatch", nothing
  touched.
- **Every activate, undo, cancel and result names the rootId.** A replaced root (a new `state.json`) refuses with
  `wrong-root`, which is never read as "not received".
- A v1 journal is refused, with an instruction to settle it by hand.
- The rootId is public and grants nothing.

### 5. History files could be partial, and reload failures were swallowed

- `ops/<id>.json` is written to `ops/.tmp-*`, fsynced, then `link`ed: it never overwrites and is never partial. Stray
  tmp files are removed under the lock, and a history entry lost after the state commit is re-published from
  `state.lastOp`.
- **A rollback whose reload or probe fails stays pending.** The outcome is `pending`, and `state.pending.restore`
  records where it must go. Nothing new runs on that root until a later operation confirms the restore. Rollback
  restores now probe the release they restore.
- **This changed one earlier expectation, deliberately.** A stand-in front that keeps serving stale bytes now yields
  b = `unknown` (pending), not `rolled-back`, because the rollback cannot be confirmed. Once the front is fixed,
  `resolve` confirms it, and the rollout becomes `reverted`.

**Also:** `site/deploy.sh` now passes `resolve` through; it was documented but missing. `docs/site-release.md` describes
all of the above.

## Tests: exact runs (serial, foreground, each bounded)

Every run was under `/tmp/s6/run-768.sh` (own-group cap 768 MiB, MemAvailable floor 16 GiB, 900 s) and an outer
`timeout`. No guard kill occurred. Available memory at the start was 18.6 GiB.

| Run | Result | Exit | Group peak | Min available |
| --- | --- | --- | --- | --- |
| `site-rollout` (before the fixture fix) | the lock test hung; the file timed out at 300 s, 2 of 8 having passed (the run in progress when the session was interrupted) | 1 | 220 MiB | 17543 MiB |
| `site-rollout`, lock test only (after removing an in-test `test.after`) | the file timed out at 90 s: the same fixture hang | 1 | 222 MiB | 17286 MiB |
| standalone lock reproduction | diagnosed: the holder never exits, so the waiting contender never exits | 124 (timeout 60 s) | — | — |
| **`site-rollout`** (the fixture exits after its hold) | **8/8** | **0** | 253 MiB | 18275 MiB |
| **`site-delivery`** (the new grammar, `cancel`, delay/drop/cut fixture, real undo retry) | **11/11**, first run | **0** | 488 MiB | 17447 MiB |
| `site-release` | 9/9 | 0 | 242 MiB | 18030 MiB |
| **`site-publish`** | **4/4** | **0** | 437 MiB | 17100 MiB |
| repro v2 (`work/site-late-activation-repro-v2.mjs`) | `fixed: true` | 0 | 45 MiB | 17452 MiB |
| **`site-release`**, after the `site/deploy.sh` change | **9/9** | **0** | 237 MiB | 17773 MiB |

**Production payload** (in `site-delivery`): a 39,931,034-byte CAR over real SSH. The agent peaked at **249 MiB**
receiving and **159 MiB** activating, unchanged and within 384 MiB.

### What the new tests prove

- **`site-rollout`** (real files and child processes):
  - rootId refusal, compare-and-swap, replay, A-B-A superseded, undo as a new generation;
  - a tombstone, then a late activation that returns `cancelled`; a cancel of an activation that ran returns
    `committed`;
  - **the coordinator's scenario in both orders:** cancel first gives `reverted`/`cancelled` and the late arrival does
    not run; activation first gives cancel returning `committed`, so the rollout is `active`;
  - **the legacy algorithm, verbatim, in two real processes,** paused deterministically before `rmSync`: A takes over
    first, then B removes A's new lock, so **both report "acquired"**. Under the kernel lock, B is refused five times
    while A holds it; A is SIGKILLed; a waiting C then acquires; and the lock file is never removed;
  - **atomic history:** after deleting the final file and leaving a partial `.tmp-*`, `cancel` returns `committed`
    (from `lastOp`), not a tombstone, and the tmp is removed;
  - **reload failure:** an activation's rollback reload fails, giving `pending`. The root refuses new work ("stays
    pending"), and cancel answers `pending`. Once the reload works, `rolled-back` is confirmed at generation 1;
  - **identity:** a same-name target with another root path gives `identity mismatch`, with nothing touched. A root
    replaced in place refuses the journal's rootId, and the replacement is untouched;
  - the earlier interleaved-rollouts and killed-orchestrator tests, both passing on the new code.
- **`site-delivery`** (actual Caddy x4, kubo RPC, OpenSSH sshd; the forced command runs the real agent behind a fault
  wrapper):
  - **delay-before-lock, cancel first:** the wrapper starts a **detached** real agent that waits on a gate file before
    it even starts, while the session ends without an answer. The rollout is `reverted` with c `cancelled`. When the
    gate opens, the late agent answers `cancelled` (replay), and c keeps its CID and generation;
  - **delay-before-lock, activation wins (cancel dropped):** the rollout is `pending` (exit 5). When the gate opens, the
    late activation **commits**, and c really serves the new CID. After the faults clear, `resolve` in a new process
    gets `committed` from cancel, then makes a fenced undo: `reverted`, and c is back;
  - **real undo retry:**
    - b's reload pins a's real Caddy to the new tree, so a's undo probe genuinely fails. The rollout is `pending`
      (exit 5) with a `undo-failed` at attempt 1, still serving its activation;
    - after the server is fixed, `resolve` makes attempt 2 and gets `undone`, `reverted`. The history shows
      `undo-…-1: failed` and `undo-…-2: committed`;
    - a second resolve changes nothing;
  - the earlier tests: cut after commit is now settled by `cancel`, which returns the commit; the unknown-then-resolve
    case; the stale front; the wrong host key and forged operations; cached tabs and CSP; the production payload. All
    pass.

## Remaining boundaries (precise)

- **No atomic commit across hosts.** During a partition, hosts can differ until `resolve` succeeds. Resolve needs the
  journal and reachability. Without the journal, each root's `state.json` and `ops/` are the record.
- **The lock is Linux-only** (util-linux `flock`). Other systems are refused, not served with a weaker lock.
- **Undo attempts are bounded at 9.** Past that, the target stays `undo-failed` (pending) for manual action.
- **Not run:** real hosts, CI on GitHub, the publisher relaunch and the IPNS result. Publication still needs the
  owner's one-time vault/session setup, or one owner `config set` per release.
- **Shared-code dependency.** Session publication relies on the uncommitted CLI work (`cli/enclave.mjs` config
  show/set through a vault session) and on the anvil rig. Both are pending the coordinator's move review, and the
  inventory marks them.
- **The coordinator's original repro script needs the port** above to run on the fixed API. The fix is root-side and
  journal-side, and the old v1 journal is deliberately refused.

## Files changed this round

- `scripts/site-release/root-state.mjs`: rewritten. It adds the lock, rootId, cancel, undo attempts, atomic history,
  confirmed-or-pending restore, and the EPIPE fix.
- `scripts/site-release/rollout.mjs`: rewritten. It adds the v2 identity-bound journal, cancel settlement and undo
  retry.
- `scripts/site-release/targets.mjs`: the async lock users.
- `scripts/site-release/agent.mjs`: the grammar now carries the rootId, plus `cancel`, numbered undo and `wrong-root`.
- `scripts/site-release/cli.mjs`: async `prune`.
- `site/deploy.sh`: `resolve` is passed through.
- `test/site-rollout.test.mjs`: rewritten.
- `test/site-delivery.test.mjs`: the fault wrapper, the new tests, the ported assertions.
- `test/site-release.test.mjs`: the async lock, and pending-then-resolve.
- `docs/site-release.md`.
- New: `work/site-late-activation-repro-v2.mjs` and `.json`.
