# Independent review: base-forward-sync-stage (static source review only; nothing edited, run, built or changed)

**Sources read:**
- `base-forward-sync-stage/src/forward_sync.py`, `units/*.service`, `integration/r6-producer-bound-binary.patch`, `r6-followup/producer/base_launch.py`;
- the r6 harness `base-finality-proof-stage/r6/harness/a2a4.py` (sha `710c3483…`, the pin forward_sync executes) and the r6 wrapper `coverage_activation`;
- `logs/claude-historical-blob-live-0547.md`.

**Status of tests:** the stage's own 8 tests (fake reth) are being run by root now; their result is not known to this review. Root's pinned help `logs/base-live-help-0603/help.txt` was **not** read here. **Out of scope:** a compromised root (it can rewrite any root-owned record).

## A. Proven from source (fix before any live use)
1. **Production binary pin is no longer enforced by code in `bound_config` (`r6-followup/producer/base_launch.py:406`).**
   - r6.1 replaced `c['baseBinarySha256'] != HARNESS_BINARY_SHA256` with a comparison to the launch record's `bindings.harnessBinarySha256`.
   - In production that binding is still the constant: `main()` calls `produce(...)` (`:784`) without overriding `harness_binary_sha`, whose default is `HARNESS_BINARY_SHA256` (`:248`, recorded at `:324`). So this is **not an exploitable bypass for launches made by this code**.
   - But arm/rearm/permit now accept **any** binary a launch record names: a test-made, older or otherwise-produced record. That breaks the requirement that production pin enforcement remains in code.
   - **Minimal remedy:** require both — `c['baseBinarySha256'] == b['harnessBinarySha256'] == HARNESS_BINARY_SHA256`. Let the r7-ported fixtures bind their stand-in with `patch.object(P, 'HARNESS_BINARY_SHA256', cfg['baseBinarySha256'])` for the test's duration, and add one negative test: unpatched, a stand-in config refuses with exactly `binary_pin`.
2. **The flag capability check is a substring test (`forward_sync.py` `capability()`).** `missing = {x for x in argv if x.startswith('--') and x not in h}` searches the concatenated help *text*, so a flag passes if it is a substring of any documented flag. For example, `--port` ⊂ `--http.port`/`--discovery.port`, and `--addr` ⊂ `--http.addr`/`--rpc.addr`. It also does not check that a flag is valid for its position (`--chain` before `rpc`, the rest after).
   - **Remedy:** parse the help into an exact token set (`re.findall(r'(?<![\w-])--[a-z0-9][a-z0-9.-]*', h)`), separately for global and `rpc` help, and require set membership by position.
   - Before any live run, check `node_argv()` exactly against root's `logs/base-live-help-0603/help.txt`. These flags are not established: `--rpc.addr/--rpc.port`, `--p2p.listen.ip/.tcp/.udp`, `--upgrade-signal.mode`, `--l1.rpc-timeout-ms`, `--discovery.v5.*`.
3. **The blob precondition is a one-slot probe (`authenticate()`, `forward_sync.py` ~175–183).**
   - It fetches block + blobs only at `coverage_activation(...)['blobSlot']`. `coverage_activation` does require `coverageVerified: true` plus acceptance hashes (wrapper assertion), so whole-range KZG coverage is delegated to the coverage gate. That is correct, but the probe itself is **not** coverage validation.
   - A forward sync also needs the blobs to **stay** available from the origin to the sync cursor while the beacon prunes (`prune_blobs` true, margin 0; oldest_data_slot ≈ head − 131k slots per `claude-historical-blob-live-0547.md`).
   - **Remedy:** in `authenticate` and at each `run` start, read Lighthouse `/lighthouse/database/info` `data_info.oldest_data_slot`, refuse unless it is ≤ the coverage `need_from` slot, and record the retention time remaining against `targetMarginBlocks`.
4. **Production state is re-checked only at `authenticate`.** `run()` and `verify()` do not call `production_rolled_back()`; per the stage report, `handoff` does. `Conflicts=enclave-base-holder.service` covers only that unit.
   - **Remedy:** call `production_rolled_back(W, c, top)` at the start of `run()` and `verify()` (one line each).

## B. Not blocking (checked)
- **`gate_static` does not make post-sync `verify` impossible.**
  - `gate_download` (harness `:777–830`) checks the receipt fields, manifest/selection, the download unit's last `Result=success`, the empty marker and the datadir dev/ino. These are static and survive a sync. The rest of `gate_static` (prune config, no `proofs/`, capacity, pinned help, `storage_v2`) is also content-independent.
  - Note: `gate_download` refuses `first_pass_only`, so the FINAL 134-archive download (`final-h48000000-s52500000`) must be complete and receipted first.
- **Crash, locks and child cleanup** are acceptable:
  - the flock is held for the whole `run`;
  - the child runs in its own session and is stopped by `stop_group` (TERM → grace → KILL);
  - systemd `KillMode=mixed` kills leftovers in the unit cgroup;
  - a restart records a dead `started` child as `stopped`;
  - `holders()` refuses while any process still holds datadir files, failing closed if the runner died between `Popen` and the `started` append.
- **Datadir identity:** the receipt binds the datadir dev/ino (harness). `run`/`verify` re-check `identity()`, and `verify` compares full identity before/after.
- **Ports:** `SYNC_PORTS` ∩ `PRODUCTION_PORTS` = ∅ is enforced in `run`. HTTP/RPC listen on 127.0.0.1 only.

## C. Unverified risks (need source or real-DB evidence; do not assume)
1. **Highest:** `verify` requires **all five** stage checkpoints (`headers`, `bodies`, `execution`, `merkle-execute`, `finish`, from `head_checkpoints`) ≥ floor. Whether pinned reth 7134be3 **live sync** (engine/persistence path, not the pipeline) advances all five is **not established**. If it does not, `verify` can never pass. The fake-reth tests cannot prove this. Check the reth persistence code (`save_blocks` / stage-checkpoint updates) or a real stopped DB after a short isolated sync.
2. `authenticate` requires all five checkpoints == `SNAPSHOT_HEAD` on the extracted snapshot. That the snapshot actually sets all five is unverified until the extraction exists.
3. `GRACE_SEC` (not read) against `TimeoutStopSec=900`: if the grace exceeds 900, systemd's SIGKILL pre-empts the clean stop.
4. **Isolation is by port convention:** any local process can query `127.0.0.1:28545`. Consumers are configured for 18545, but nothing enforces it.

## Priorities
1. A1 (restore the constant conjunction plus fixture-scoped override).
2. A2 (exact-token capability check, validated against root's help.txt).
3. C1 (establish checkpoint advancement before relying on `verify`).
4. A3 (contiguous retention check plus time budget).
5. A4 (re-check production rollback).

**No live use until 1–4 are settled. Production remains unqualified.**
