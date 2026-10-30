# base-finality-proof-stage/r4: independent review (read-only; nothing edited or run)

**Scope:**
- **Files:** `src/finality_state.py`, `src/finality-core.mjs`, `wrapper/chain_service.py`, `producer/base_launch.py`, `a1gate/*.mjs`, `vendor/anchor-bootstrap.mjs`, `jobs/root-finality-r4-tests.sh`, and `integration/*.patch`. The stage's `SHA256SUMS` verifies.
- **Method:** three parallel read-only reviewers, plus my own reading of each **[V]** line below. **[R]** findings come from a reviewer and I did not re-read them.
- **Excluded,** as r5 is already fixing them: immediately-stale status, CLI/install, shared-ledger admission, and restart readiness.

## Material findings (most severe first)

**1. HIGH [V]: an ordinary restart accepts a database whose file was rewritten in place.**
- **Where:** `wrapper/chain_service.py:786-789`.
- **Defect:** for a `bootstrapped` launch, the only database check is that `(st_dev, st_ino)` of `<bindings.datadir>/db/mdbx.dat` equals the launch record. Nothing compares the database head or block hash with the anchor N or the latest finality watermark N'.
- **Failure:** while the node is stopped, the datadir owner (`rpcbase`) does any of: `cp other.mdbx mdbx.dat` (cp writes into the existing inode), `dd conv=notrunc`, or a stage unwind below N.
  - dev/ino are unchanged, so `launch_handshake` returns `[]`.
  - The node restarts **without** `--bootstrap.anchor` on a rolled-back or foreign database.
  - The test (`tests/test_finality_integration.py:210`) covers only `os.replace`, which creates a new inode.
- **Fix direction:** before the restart, require the stopped database's canonical hash at N (and at the latest N') to equal the recorded values. This is the same "stopped DB unchanged at N" proof the producer already has. Otherwise refuse, with rollback and re-anchor.

**2. MEDIUM [R, partly V]: the identity check stats a different path from the one the node runs on.**
- **Where:** `wrapper/chain_service.py:787` against `:856` and `:916`.
- **Defect:** the check uses `launch.bindings.datadir`, but the node is started with `--datadir` built from the mount (`base + '/data'`). Nothing asserts the two are equal.
- **Failure:** a correct database at the bound path passes while the node runs another one.
- **Related:** the anchored-start path (`:792-809`) never re-checks database identity after the root `arm`, even though the datadir stays writable by `rpcbase` in between.

**3. MEDIUM [V]: the finality journal directory is not bound to the launch, so terminal states can be bypassed.**
- **Where:** `src/finality_state.py:377/388` (`qualify`), `:424/427` (`status`), `:444/454` (`revoke`).
- **Defect:** `fdir` is a free argument. `entries()` only checks that the entries in it name this launch's sha, so an **empty directory is a valid, empty journal**.
- **Failure:**
  1. `/var/fin/A` ends in `contradicted` (fork or DB swap) or `revoked`.
  2. A retry with `record … /var/fin/B` (empty) passes the terminal check, runs with `prior=[]` (losing the cross-check against earlier qualified points), and `status(B)` returns `qualified:true`.
  3. `producer/base_launch.py`, which also takes `finality_dir` as an argument, keeps advancing.
- **Fix direction:** derive the finality directory from the launch directory, or record it in the launch journal.

**4. MEDIUM [R]: truncating the finality journal tail, or restoring an older copy, goes undetected.**
- **Where:** `src/finality_state.py:332-345`.
- **Defect:** each entry links only to the one before it, and no head hash or count is anchored anywhere else.
- **Failure:** deleting the last entry (`contradicted` or `revoked`) restores `qualified:true`. Restoring an older copy also shrinks `prior`.
- **Fix direction:** append each finality entry's hash to the launch journal, which the wrapper already reads, or to the watermark store.

**5. MEDIUM [V]: the A1 gate's node process inherits root's full environment. This is a regression from r2.**
- **Where:** `src/finality_state.py:201` and `:205` call the r7 harness. `base-reanchor-recovery-stage/r7/harness/a2a4.py:617-618` runs `subprocess.run([c['node'], …], env=dict(os.environ, G=…))`. r2's own gate used `PATH=/usr/bin:/bin` plus `G` only, and that was removed in `integration/finality_state-r2-to-r4.patch:89-93`.
- **Failure:** `NODE_OPTIONS=--import=/x.mjs` (or `NODE_PATH` and similar) in the caller's environment makes the gate print a forged `{"ok":true,"summary":{N,outputRoot,game…}}`. That summary feeds `rules()` and `gate_a1` (`:203-205`), so an arbitrary N' or output root qualifies.
- **Not affected:** `run_core` (`:317`) still scrubs its environment.

**6. MEDIUM [V]: the node binary behind every finality decision is not pinned.**
- **Where:** `src/finality_state.py:472`.
- **Defect:** `node` comes from `os.environ['FINALITY_NODE']` and is passed to the capture binding, the A1 gate and the core (`:315`) with no hash or version check. Per reviewer, the capture module itself pins node by hash; this entry point does not.
- **Failure:** any executable at that path that prints the expected JSON decides both the A1 and the finality verdicts.

**7. MEDIUM [V]: the harness pin does not cover what actually runs.**
- **Where:** `src/finality_state.py:156-163` hash-checks and execs `a2a4.py`'s bytes, then puts its directory on `sys.path`. r7 `a2a4.py:33-34` does `import selection as SEL`, which is unpinned and could also be loaded from `__pycache__/*.pyc`.
- **Also:** `producer/base_launch.py:62-69` hashes `a2a4.py`, then re-reads it by path through `spec_from_file_location`. That allows a swap between the hash and the load, and lets a matching `.pyc` run in place of the source.
- **Also:** `producer/base_launch.py:597-602` and `src/finality_state.py:467` import `chain_service` from `/opt/enclave-rpc` with no pin. That module supplies the journal, watermark, lineage and lock rules.
- **Failure:** a modified `selection.py`, `chain_service.py` or `.pyc` changes capture binding, game selection or the journal rules, while the evidence still records the pinned sha.

**8. MEDIUM [R]: a first-bootstrap launch ignores a watermark already on disk.**
- **Where:** `wrapper/chain_service.py:696-697` (used at `:792`) and `producer/base_launch.py:525`.
- **Defect:** with no predecessor, `produce`, `arm` and the anchored start do not consult the existing watermark store. The only guard is that the archive is empty, and `retire` is optional.
- **Failure:**
  1. Launch L1 reaches N'=1000.
  2. Root deletes its launch directory instead of retiring it.
  3. A new first-bootstrap launch at N=500 starts with `--bootstrap.anchor 500:…`, below the persisted watermark.

**9. MEDIUM [R]: `rearm` and `arm` re-prove "database unchanged at N" with a caller-supplied config.**
- **Where:** `producer/base_launch.py:351-355`, used at `:524` and `:547`.
- **Defect:** the config is never compared with `launch.bindings.configSha256`, and `baseBinarySha256 == HARNESS_BINARY_SHA256` is not re-checked; `produce` checks it at `:202`.
- **Failure:** the proof runs with unreviewed tools or reth config, then reopens the one-shot anchor.

**10. LOW-MEDIUM [R]: the integration evidence is not tied to the reviewed bytes, and the job trusts unhashed reused logs.**
- **Unchecked code:** `tests/test_finality_integration.py:16-23` imports and runs `…/a2-v2-release-bound-prepared/stage/test/test_a2a4.py`, which runs a bare `node make_fixture.mjs`, and loads the r7 harness. None of these is in any checked manifest. `-B` does not stop reading an existing `.pyc`.
- **Self-referential checks:** `jobs/root-finality-r4-tests.sh:22-24` checks r2 and r7 against manifests stored next to them, with no pinned manifest hash.
- **Unhashed reuse:** `:33-37` reuses r2 "JS core 20" and r7 "baseline 34" results by grepping log, `.rc` and `.out` files that are not hashed.
- **Environment:** `:26-27` and `:50-52` take node, python and the tools from the caller's PATH and environment.
- **Removed tests:** `integration/test_finality_state-r2-to-r4.patch:147-203` removed r2's real tests of the A1 rules (stale receipt, ASR/type/code-hash, window, symlink). The new tests fake those error codes, so a mis-wired `FRESH_A1_MAX_AGE_SEC` would still pass.

**11. LOW [R]: liveness and evidence-accuracy issues.**
- **Process binding is incomplete:** `src/finality_state.py:244/251-255` does not filter listeners by local address, requires exactly one owning pid rather than ownership of every inode on the port, and skips processes whose fd scan raises `OSError`.
- **Code hashes re-read late:** `:414-415` re-reads the code hashes after a run of up to an hour, rather than recording the bytes that executed.
- **Stale A1 read:** the A1 freshness check happens before a run of up to 3600 s and is not repeated before `append` (`:416-417`).
- **Transient states recorded as terminal:** the core (`finality-core.mjs:32/79`) records `contradicted` for node states that may only be temporary (an unsafe reorg at N' that is not yet derived). This fails closed, but it strands the launch.
- **Crash recovery can strand the launch:** after a machine crash between the watermark append and the journal append (`producer/base_launch.py:435-445`, `469-480`), recovery needs the same node process, so the launch can only be rolled back. Nothing is wrongly accepted.

## Reviewed, nothing material found
- **Append crash safety:** temp file plus fsync, `os.link` with no overwrite, directory fsync, verify after write; torn or partial entries are refused. The full hash chain, sequence and launch binding are checked on every load.
- **The core walk:** every hash is recomputed and chunks are linked by authenticated `parentHash`. It ends exactly at N, matching root and anchor; labels are refused and the chain id is checked.
- **Replay and monotonicity rules:** strict increase of N and the L1 number, with captures de-duplicated.
- **A1 modules:** the MPT and RLP checks are strict. The L1 header is bound to Helios's finalized hash, L1 chain id 1 is enforced, the recheck requires a strictly newer L1 block, and nothing compares the anchor with itself.
- **`vendor/anchor-bootstrap.mjs`:** sound.
- **Child environment for reth:** a fresh environment, no shell, absolute exec path.
- **Launch lock and pid handling:** flock on a root 0600 file, start time bound.
- **HOLD flags:** source constants that cannot be overridden.

## Not established
- Nothing was executed.
- Findings marked [R] were not re-read by me line by line.
