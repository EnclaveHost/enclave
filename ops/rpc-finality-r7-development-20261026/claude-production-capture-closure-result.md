# Production capture closure for the RPC guest: FROZEN SOURCE (prepared; nothing executed, installed or committed)

**Status:** `production-capture-closure-stage/` is **frozen**. `SHA256SUMS` is `8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172` (16 files, verified at freeze; `logs/` and `bundle/` excluded).

**Not touched:** r4, r7 (its `SHA256SUMS` still verifies), and 50cf's or 6d24's stages.

**Done here:**
- read-only SSH to the guest (`ssh -F ~/.local/state/enclave-rpc-production/ssh_config enclave-rpc`): hashes, sizes, dpkg owners, `ldd`, `node -e process.report`, `/proc/self/maps`, `ss -ltn`. No secrets were read;
- hashing of the workstation inputs, each asserted against the existing pins;
- `ast.parse` and `bash -n`.

**No test has been executed.**

## Runtime selection and checks (implemented in `src/a1_capture.py`; sha `fc16b26cd23d1d6cc768f5248b92f8750ccc14e4154a9bba4605d995485afb0d`; patch `patches/a1_capture-guest-runtime.patch`)
The guest's **own** Ubuntu 24.04 runtimes are **added** to the accepted sets. The host entries (node 22 `7af789e5`, python 3.14 `375532f8` + libpython `0a5be42f`) are kept. Every guest entry is labelled **OPERATOR-OBSERVED 2026-10-26, NOT upstream-verified**: no Ubuntu archive checksum or signature was checked.

| Runtime | Accepted identity | Check |
|---|---|---|
| python | `/usr/bin/python3.12` sha `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f` (root's 0623 evidence), 8,020,928 B, `python3.12-minimal 3.12.3-1ubuntu0.17`, **`staticLibpython: True`** | `python_identity(pins, exe=, maps_text=)` |
| node | the launcher `/usr/bin/node` sha `f3f93db342d5ac5bb61656d0599a603a73779e98befd9342171e550002725f4d` (26,704 B, `nodejs 18.19.1+dfsg-6ubuntu5`) **plus** `libnode: /usr/lib/x86_64-linux-gnu/libnode.so.109` sha `ce7cb9cd408c412090c86dada332aaa82650679ed1b32527768c8dbd8c4028d0` (47,772,280 B, `libnode109`) | `node_lib_identity` before the run; recorded as `runtimePolicy.libnode`; re-checked by `runtime_accepted` in `verify` |

**How the python check works:** a `staticLibpython` interpreter must map **no** libpython; if it maps one, it is refused. A shared interpreter still needs exactly one accepted mapped libpython.

**How the node check works:**
- the libnode file must be root-owned, not group/other writable, and have the accepted sha;
- the accepted launcher (executed from the hashed fd) must report, through `process.report.getReport().sharedObjects`, **exactly** that one libnode (by realpath).

**Honest limits:**
- **Python 3.12's embedded libpython.** Ubuntu links libpython into the executable, so the executable sha **is** the interpreter identity. That is no weaker than r4's executable-plus-libpython pair. **Not covered, as in r4:** the stdlib `.py` files under `/usr/lib/python3.12` and the `lib-dynload` extension modules (`_hashlib`, `_json`, `_ssl`, …), plus their shared libraries (libcrypto, libz, libexpat). Those come from the root-owned distro install and are not hashed.
- **Node 18's shared-library identity:**
  - the libnode sha is checked before the run, and the mapping is checked by a **separate probe process**. The real A1 run then loads libnode again by name, so there is a TOCTOU window on a root-owned system path;
  - **only libnode is pinned.** Node's other shared libraries (libuv, libssl/libcrypto 3, libicu 74, libnghttp2, libcares, libbrotli, libz, libstdc++) are not covered, as in r4;
  - the A1 run uses the **copied launcher** (`bin/node` in the capture), which resolves libnode through the system loader path, not from the capture.
- **Rejected alternative:** shipping the host runtimes. The host node 22 needs **GLIBC_2.44** (the guest has 2.39) plus Arch's libicu 78 and others. The host python 3.14 would also need its whole stdlib and extensions, an unreviewed second runtime.

## Settings-driven sources and reproof config
- **`Sources.from_settings(path, initial_capture=None, owner=0)`:** a root-owned, not group/other writable JSON with **exactly** `format` (`enclave-a1-capture-sources/v1`), `initialDir`, `recheckDir`, `l1Authority`, `l1Config`, `portalResult`, `depsRoot`, `node` and `elUrl`. Paths must be absolute; `elUrl` must be `http://127.0.0.1:<port>`. `initial_receipt` is None.
- **`src/reproof.py`** (patch, 5 lines): `CONFIG_KEYS` gains `captureSources`, and the capture uses `C.Sources.from_settings(c['captureSources'], initial_capture=…)`.
- **`patches/harness-a1-capture-pin.patch`:** r7 `harness/a2a4.py` `A1_CAPTURE_SHA256` `db81ea49…` becomes `fc16b26c…`. **50cf/r8 must compose it and its cascade:** the harness sha inside finality_state, the r7 MANIFEST, and reproof's pinned `FINALITY_STATE`/`PRODUCER` if they change.

## Copied closure (`install/MANIFEST.json`, generated with every pin asserted)
**19 files + 13 trees**, installed under `/opt/enclave-rpc/a1-capture/` (configs under `/etc/enclave-rpc/`):

| Item | Pin |
|---|---|
| `a1_capture.py` (patched) | `fc16b26c` |
| `l1-anchor-a1/` 4 initial modules (`MODULES['initial']`) | per-file shas |
| `l1-anchor-a1/a1-config.example.json` | `2eeadf24` |
| `a1-original-game-prepared/` 6 recheck modules (`_RECHECK`) | per-file shas |
| `l1_authority.py` | `f4a5160b` |
| `bin/helios-eeffcc9` (124,722,632 B) | `cc962e2b` |
| `inputs/portal-result.json` | the existing root-verified portal result; sha in the manifest |
| `deps/package-lock.json` | `9ada1611` |
| `/etc/enclave-rpc/{a1-capture-sources,l1-authority,base-finality-reproof}.json` | from `config-templates/` |
| `deps/node_modules/<13 packages>` (viem 2.53.1, ox, abitype, @noble/*, @scure/*, ws, isows, eventemitter3, @adraffy/ens-normalize) | each tree is exactly the files the module binds; its `tree_rows` equals the pinned DEPS digest |

- **`tools/assemble_bundle.py`** (workstation) copies those bytes from `bundle-origin.json` into `bundle/`, verifying every hash.
- **`install/install_closure.py`** (guest, root) uses `install/installer_core.py`, which is r6-ops-fixes-r2's installer pinned `356e64c3…`. It runs a full preflight before any write, then a journaled commit with exact rollback. Dry-run is the default; `--commit` needs `## capture-closure rc=0` and this stage's `## capture-closure SHA256SUMS` line.
- **Bytes only:** the install changes no review flag.

## Config values and unknowns
- **Established:**
  - `elUrl` and `executionRpc` are `http://127.0.0.1:18645`, and `consensusRpc` is `http://127.0.0.1:15052`; both were seen listening on the guest;
  - `node` is `/usr/bin/node`;
  - the Helios path and pin;
  - data and home dirs under `/var/lib/enclave-rpc/l1-authority`;
  - `maxCheckpointAgeSec` 604800, `maxFinalizedAgeSec` 1800.
- **UNKNOWN / root-supplied (fail closed):**
  - **`/etc/enclave-rpc/l1-checkpoint.json`:** the reviewed L1 checkpoint record. **Not invented.**
  - **Helios listen `127.0.0.1:18550`:** chosen here; `guest/check-guest-runtime.sh` confirms it is free.
  - **Root review** of the guest runtime entries, then the `A1_CAPTURE_REVIEWED` / activation flags after qualification.

## Absolute workstation paths still in executable code (flagged)
- **`src/a1_capture.py:31-33`** define `W`, `P`, `O` and `OPS` as `/home/steven/Documents/Codex/2026-10-18/wo/...`. They feed only the **default** `Sources` fields (`:127-134`) and `capture()`'s fallback `src or Sources()` (`:410`), so a call without `src`, such as the module's own CLI `main` (`:727`), would use workstation paths. Production reproof always passes `Sources.from_settings`, and on the guest those paths do not exist, so such a call refuses (fails closed). It is still workstation-only code, left in place.
- **DEPLOYMENT BLOCKER: `src/a1_capture.py:588` `read_once(HERE / 'a1gate' / name)`.** `HERE` is the module's grandparent, so on the guest it is `/opt/enclave-rpc` and the A1 gate files are read from **`/opt/enclave-rpc/a1gate/`**.
  - **What is missing:** this closure does **not** install them there. The r6/r7 manifests install the gate at `/opt/enclave-rpc/finality/a1gate/`.
  - **Effect:** `verify` (which `recheck-capture` runs on the initial capture) would refuse with `input` and fail closed.
  - **Minimal fix for r8, choose one:** add three manifest entries `a1gate/{a1-gate,a1-recheck,a1-anchor}.mjs` → `/opt/enclave-rpc/a1gate/` with the `A1_GATE_PINS` shas (`06cc2961`, `f591f324`, `ec92b70f`), or pass the gate directory explicitly. The pins are already enforced on read.
- **No other `/home/steven` path:** none occurs in `src/reproof.py`, the installer, the guest check or the config templates. `bundle-origin.json` names workstation origins on purpose, for `assemble_bundle.py` only; it is never read on the guest.

## Root tests (PREPARED, UNRUN)
- **Workstation, offline:**
  ```
  cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh capture-closure-1 512 unshare -rn bash production-capture-closure-stage/jobs/root-capture-closure-tests.sh
  ```
  **Expected 14 tests** with no skip, giving `## capture-closure rc=0` and `## capture-closure SHA256SUMS 8608830a…`:
  - **Runtime (4):** the guest pins; a static interpreter is accepted only with no libpython mapped; a shared one needs exactly one accepted libpython; an unknown interpreter is refused.
  - **NodeLib (5):** the accepted libnode mapped is accepted; another, extra or missing mapping is refused; changed libnode bytes or an unaccepted launcher are refused; a self-contained node is accepted; the verify-side record is re-checked.
  - **Settings (2):** the template is complete and loads; missing, extra, relative, non-loopback, wrong-format or writable settings are refused.
  - **Templates (3):** the reproof config includes `captureSources`; the L1 config uses 15052/18645 and no checkpoint file is shipped; every manifest pin and dependency-tree digest matches.
- **Guest, after review (none have run):**
  1. `python3 tools/assemble_bundle.py` (workstation);
  2. copy the stage and `bundle/` to the guest;
  3. `bash guest/check-guest-runtime.sh` (read-only);
  4. `install_closure.py --qualification … --rc …` as a dry run;
  5. after the a1gate fix, a guest qualification of `a1_capture capture initial` + `verify` under `/usr/bin/python3.12` and node 18 against 15052/18645;
  6. then the reproof qualification.

## Remaining deployment blockers
1. **The a1gate location** (above).
2. **The L1 checkpoint record.**
3. **Untested compatibility:** Node 18.19.1 has never run the A1 modules, the viem closure or the finality core; Python 3.12 has never run the r7 Python stack. Static scans found no Node ≥ 20-only or Python 3.13+ APIs, but nothing has executed.
4. **Composition:** the harness pin cascade into r8.
5. **Review and activation:** root review of the operator-observed guest runtimes, then activation after qualification.

Earlier open items stand: readiness coverage settings, the bootstrap `base-a2a4-config.json`, the consumer unit list, and forward sync.
