# Finality runtime closure: libnode identity for the finality tool (base-finality-proof-stage/runtime-pin; FROZEN, PREPARED, UNRUN)

**Stage:** `SHA256SUMS` sha256 `55c5e7b45ecc18f455ed8b1e8dcf48480f8337ab7e8beb574fa5d15573813936`.
- **Only change:** `src/finality_state.py` (`ee62ad7f…`), as r9's tool + `patches/finality_state-runtime-pin.patch`.
- **Test support:** a 2-line FakeR patch to the tool tests, and the new `tests/test_runtime_pin.py`.
- **What Claude did:** static checks only (`ast.parse`, `bash -n`).
- **Not done:** no tests, builds, queue jobs, live operations or commits.
- **Untouched:** r9 and every other stage.
- **Flags:** `FINALITY_PROTOTYPE_REVIEWED` and all review flags stay False.

## The gap (r9) and how the tool used node

- **How node ran:** `finality_state.qualify` → `node_fd()` hashed only the **launcher** and accepted it if its sha was in `R.accepted_nodes()` (the capture module's `node_accepted` keys). That launcher (`/proc/self/fd/N`, `pass_fds`) then ran:
  - the harness's A1 gate, header hash and authenticate (through `fresh_a1`, with the scrubbed env);
  - the finality core (`run_core`).
- **The hole:** the guest's Ubuntu node 18 is a 26 KB launcher whose engine is `libnode.so.109`, loaded by name. **Nothing in the finality tool checked it.**
- **How the node path reaches the tool:** `reproof.py` passes `c['node']` (`/usr/bin/node` in the closure's `base-finality-reproof.json`) to `F.qualify(node=…)`; the tool CLI passes `FINALITY_NODE`.

## The fix (finality_state only; same identities as the capture module)

| Function | What it does |
|---|---|
| `node_profile(R, sha)` | Returns the **accepted entry** from the capture module's pins (`R.load_capture()` + `A1_CAPTURE_TEST_PINS` or production `C.Pins()`), the same source as `accepted_nodes()`. Host node 22 `7af789e5` is self-contained; guest node 18 `f3f93db3` names `libnode` (`/usr/lib/x86_64-linux-gnu/libnode.so.109`, `ce7cb9cd…`). |
| `mapped_libnode(nodep, fds)` | Runs the hashed launcher fd with the capture module's exact probe, `process.report.getReport().sharedObjects` filtered to `libnode.so`, under `PATH`-only env. Returns distinct realpaths. |
| `libnode_identity(acc, nodep, fds)` | **Split profile:** the libnode file must be an `OWNER`-owned regular file, not group/other writable, with the accepted sha (hashed from an open fd), **and** the launcher must map **exactly** that one path. Refuses wrong bytes, missing, extra/duplicate and unapproved mappings (`node_lib`). **Self-contained profile:** must map **no** libnode. Records dev, ino, size and mtime. |
| core self-report | The finality core's node process now prints its **own** `sharedObjects` libnode list with the verdict. `core_libs_ok` requires exactly the verified libnode (or none). |
| `libnode_unchanged(lib)` | Before any append: the libnode file is still the same object (dev, ino, size, mtime), covering every node run of the decision (gate, header hash, authenticate, core). Otherwise `node_lib_changed`, and nothing is recorded. |
| CLI `runtime-verify <node>` | Root, after install or after any apt upgrade: launcher plus libnode identity, or refusal. |

**Evidence:** the qualified evidence's `code` gains `'libnode': <sha|null>`.

**Explicitly NOT pinned** (stated in code and here): node's other shared libraries (libuv, libssl/libcrypto, libicu, libnghttp2, libcares, libbrotli, libz, libstdc++) and the Python stdlib. The loader resolves `libnode.so.109` by name via root-owned `ld.so.cache`, with `LD_*` absent (scrubbed env). A root-level replacement of the system library that preserves its inode is outside this threat model.

## Tests (`tests/test_runtime_pin.py`, 10, plus affected suites)

| # | Case |
|---|---|
| 1 | the **real** capture-module accepted profiles: host 22 self-contained, guest 18 with libnode path/sha; an unknown sha refuses `node_pin` |
| 2 | **real** host node process.report: maps no libnode, accepted as self-contained |
| 3 | split guest profile accepted (a launcher stand-in reporting sharedObjects plus a libnode stand-in) |
| 4 | wrong libnode bytes refuse |
| 5 | missing mapping refuses |
| 6 | **duplicate** libnode mappings refuse |
| 7 | unapproved path with identical bytes, or a libnode on a self-contained profile, refuses |
| 8 | writable libnode refuses |
| 9 | libnode replaced mid-decision refuses (`node_lib_changed`) |
| 10 | the core's own report must match exactly |

## Root job (UNRUN)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/runtime-pin
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-runtime-pin-tests.guard -- unshare -rn bash $ST/jobs/root-runtime-pin-tests.sh > $ST/logs/root-runtime-pin-tests.out 2>&1; echo $? > $ST/logs/root-runtime-pin-tests.rc
```
- **Setup:** loopback up and checked, `tar` copies (no recursion), r9, closure and fake pinned, files equal r9 + patch.
- **Where it runs:** a private r9 copy with the tool swapped, and r9's private fixture WORK.
- **Suites:**
  - runtime-pin 10;
  - tool 34 (FakeR accessors);
  - integration 17 (the real core run now checks its own `sharedObjects`);
  - reproof 9 (drives `qualify`).
- **Pass rule:** exact `Ran N tests in` + bare OK.
- **Queue:** 1024 MiB, like r9. Nothing else is affected: the harness, capture module, wrapper, forward_sync and readiness are unchanged.

## Consumers and pins needing recomposition (one recompose of r9; no new stage family)

| Consumer | Change |
|---|---|
| `producer/base_launch.py` | `FINALITY_STATE_SHA256` → `ee62ad7f…` (the producer's sha then changes) |
| `src/reproof.py` | `FINALITY_STATE` → `ee62ad7f…`; `PRODUCER` → the recomposed producer sha |
| `install/MANIFEST.json` | entries for `/opt/enclave-rpc/finality/src/finality_state.py`, `/opt/enclave-rpc/base-launch/base_launch.py`, `/opt/enclave-rpc/finality/src/reproof.py` |
| `COMPOSITION.tsv` and the r9 job | its pin checks |
| **unchanged** | harness `2efc6d66`, first harness `dbd4cbe3`, capture `fc16b26c`, wrapper `4fc3b970`, forward_sync `e0a8592b` |
| **L1 checkpoint** (authentic, existing; no user action) | `outputs/rpc-production-final-20261025/l1-authority-live-1941/checkpoint.json`, sha `2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33`, `enclave-l1-checkpoint/v1`, slot 15511008, recorded 2026-10-25T19:38:24Z from own Lighthouse. Add as a manifest config entry → `/etc/enclave-rpc/l1-checkpoint.json` (the `checkpointFile` of `l1-authority.json`). With `maxCheckpointAgeSec` 604800 it is usable until about **2026-11-01T19:38Z**; after that, a new reviewed checkpoint record is needed. |

## Remaining (actual)

- **Unrun:** this stage and the recomposition.
- **Guest canary:** 6d24's guest canary is still the real proof that node 18 + libnode actually run the A1 modules, viem and the finality core. This patch makes the finality tool **refuse** any other libnode, but does not by itself prove compatibility.
