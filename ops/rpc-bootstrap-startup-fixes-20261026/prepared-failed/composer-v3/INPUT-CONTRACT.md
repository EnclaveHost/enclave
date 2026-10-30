# r13 composer v3: input contract (concise). Status of v3 itself: UNTESTED until root's receipt (below) is rc 0

## Order (fixed)
1. **Base:** r12-final (`9de0d8d7…`, root PASS 0738).
2. **Wrapper overlay:** `wrapper-pruned-identity-stage` (frozen): `wrapper/chain_service.py` `4fc3b970`→`6a4d7aa5`, plus its test-only file.
3. **Wiring overlay:** `production-bootstrap-wiring-stage`, via its `COMPOSITION-INPUT.json`.
4. **Cold readers:** `cold-proof-timeout-stage/r3` (`4a637e01…`, root PASS RESULT), re-pinned **last** by the pin-graph engine.

Every overlay replaces only the **current exact base**, so two overlays on one path refuse. A base sha that a later file still names (e.g. the wiring producer's `WRAPPER_SHA256 = 4fc3b970`) is a **cross-overlay** pin: the engine maps it to that file and re-pins it. That is expected, not stale.

## 1. External qualification (root authors it; NEVER inside a frozen input). `--wiring-qualification Q.json`, `--wrapper-qualification Q.json`
```json
{"format": "enclave-r13-input-qualification/v1",
 "stage": "<stage dir, relative to work/rpc-production-final-20261025>",
 "stageSha256sums": "<sha256 of that stage's SHA256SUMS>",
 "binds": "stageSha256sums | files",
 "receipts": [{"path": "<receipt, relative>", "sha256": "<receipt sha>", "rc": "<optional rc file, must read 0>", "lines": ["<exact receipt line>", "..."]}]}
```
- **Exact shape:** exactly these keys. Every receipt must exist with its sha and contain every listed line exactly. The `rc` file, if given, must be `0`.
- **Binding:**
  - `binds: "stageSha256sums"`: some receipt line contains the stage's sums (use this when the receipt is NOT inside the stage).
  - `binds: "files"`: the receipts contain `<sha>  <src>` for EVERY overlay src. Use this when the receipt lives inside the stage, as in the wrapper stage, whose `jobs.sh` prints those lines.
- **No hash cycle:** the frozen stage never embeds its own qualification, so a later receipt qualifies it without changing it.
- **Example only (root writes the real file from real results):** the wrapper has `binds: "files"`, with receipts `wrapper-pruned-identity-stage/logs/claude-wrapper-pruned-20261026T082645Z.out` (lines `OK`, `BASELINE REPRODUCES BLOCKER`, `rc=0`; rc file `0`) and `logs/root-wrapper-pruned-live-0836.out` (the line `Read-only live l1-ready, source 6a4d7aa5…; no install/start/restart`).

## 2. Wiring input `production-bootstrap-wiring-stage/COMPOSITION-INPUT.json` (listed in its SHA256SUMS; NO `qualification` key: refused)
```json
{"format": "enclave-r13-wiring-input/v1",
 "base": {"stage": "base-finality-proof-stage/r12-final", "sha256sums": "9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e"},
 "files": [{"path": "producer/base_launch.py", "src": "overlay/producer/base_launch.py", "action": "replace", "baseSha256": "<r12-final sha>", "sha256": "<src sha>"},
           {"path": "bootstrap/x.py", "src": "overlay/bootstrap/x.py", "action": "add", "sha256": "<src sha>"}],
 "pinEdges": {"<every added/replaced file>": {"<stage path or READER:a1-read.mjs / READER:a1-recheck-read.mjs>": "<count>"}},
 "manifest": {"add": [{"src": "...", "dest": "...", "mode": "0755", "sha256": "..."}], "replace": [{"baseSha256": "...", "entry": {}}], "addTrees": []},
 "bundleOrigin": {"add": {"bundle/...": {"origin": "/abs/real/origin", "sha256": "..."}}},
 "suites": [{"name": "a-z0-9-", "where": "stage|recovery", "argv": ["..."], "env": {}, "timeout": 1800, "kind": "unittest", "ran": "<exact N>"}]}
```

**Refusal rules:**
- **Files and pins:**
  - `replace` needs the exact current base; `add` needs an absent path; safe paths only;
  - src bytes must equal the declared sha and the stage `SHA256SUMS` line;
  - **no stale pin**: no overlay file may name the base sha of a file the SAME overlay replaces, so the wiring must be self-consistent **before** it is frozen;
  - `pinEdges` is the complete pin set with exact counts; reviewed base pins of a replaced file may not disappear;
  - registries change only through deltas.
- **Installer files:** `install_verified.py`, `test_ops_installer.py` and `MISSING.md` may be replaced only if each r12-final qualification anchor remains exactly once (r13 rewrites them).
- **Base shas:** name **base** shas for files the readers or the wrapper will change. Never pre-compute r13 shas.

## 3. Canonical commands (root)
```
# v3's own focused tests (UNTESTED until this is rc 0 with exactly "Ran 18 tests" and "OK"):
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh claude-r13-composer-v3-tests-root 512 unshare -rn /usr/bin/python3 -I -B base-finality-proof-stage/r13-compose/v3/tests/test_compose_engine.py -v
#   -> logs/claude-r13-composer-v3-tests-root.out / .rc
# the final composition, only when ALL inputs are frozen + root-qualified (creates base-finality-proof-stage/r13):
python3 -I -B base-finality-proof-stage/r13-compose/v3/compose_r13.py cold-proof-timeout-stage/r3 \
  --wiring production-bootstrap-wiring-stage --wiring-qualification <root Q.json> \
  --wrapper wrapper-pruned-identity-stage --wrapper-qualification <root Q.json>
```
Without `--wrapper` or the qualifications it refuses, except with `--dry-run-unapproved`, which writes only to `/tmp`.
