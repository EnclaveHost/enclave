# offchain-heartbeat-writers case 1: registration-fixture fix (PREPARED; test-only; nothing run, built, queued or committed)

**Stage:** NEW `offchain-registration-fixture-stage/` (`SHA256SUMS` sha256 `a17d9e2b98af03adabb7601dee02719cbf51bc1bb3303796f3712724a580f7cc`).
- **Files:** `patches/offchain-heartbeat-registration-adoption.patch` (`942b4ceab66ee74df0a33d00f4c07c1e5be665c5812fbd8b165395d77584c50d`), `jobs/root-offchain-registration-fixture.sh` (`d970a0e92f1f62610c6ffc832cdc2a3982af6b68d9f940acfad5ceb3f33cac3c`) and `SOURCE-PINS.txt`.
- **Untouched:** r12, the rig r2 run and its stage (`SHA256SUMS` still verifies) were only read. Product code is unchanged.

## Actual failure (rig r2 `rerun--final--…heartbeat-writers….tap`, sha256 `6189579f…413b`)
- **Result:** 2 pass / 1 fail. Case 2 (the base-supervisor negative control) and case 3 (the real Windows node) pass.
- **Case 1** timed out waiting for `[registry] registered https://host.independent.test`.
- **What the supervisor printed instead:** `[registry] adopted the existing registration of https://host.independent.test id=0x9fb1… (only the proof key differs): proofKey=0xd0Bb… tx=0x3c37…`, then `… is active on chain`.

## Production behaviour (read, unchanged)
- **The rig pre-registers the row.** `cli-independent-rig.mjs:139-142` registers `https://host.independent.test` with the operator key and proofKey 0, and `r.runner = keccak256(endpoint)`.
- **The supervisor adopts it** (`supervisor.js:806-830`). For an existing, active row held by this operator, where every field matches except the per-boot proof key, it sends ONLY `setProofKey`. It adopts only after the receipt and a fresh re-read confirm the row, and otherwise does a full `register()`. That is the correct, reviewed path.
- **Same product in baseline and final:**
  - the test blob `d26d75e9` and `supervisor.js` blob `8eeaaaa9` are identical in the ownercli and final trees;
  - ownercli fails identically;
  - only the rig helper differs (`c28a1a75` in final).
- **Scope:** the current final tree, case 1. No product change is needed.

## The patch (test-only; it replaces ONLY line 48, and every other line is byte-identical)
- **What it waits for:** either reviewed boot line, `registered https://host.independent.test repo=… id=<id>` or `adopted the existing registration of https://host.independent.test id=<id>`.
- **Assertions added before any write is measured:**
  - `id === r.runner`, the rig's own row;
  - the chain row is bound explicitly: `endpoint` is `https://host.independent.test`, `operator` is the operator key, and `active` is true.
- **Unchanged:** the 10 s settle; `b0` taken after it, so the adoption's own `ProofKeySet` is not counted; the three 60 s periods with zero registry writes; zero Heartbeat events; exactly one corrective `PricesSet` on drift; the deregistration standing with no write; CORS `*` without credentials; the signed capacity verified against the row; and 503 after deregistration.
- **Patched blob:** `4260cd8e`. `node --check` passes, and the patch reproduces the reviewed file.

## Root runner (cap **768**: rig r2's full-rig peak was 416 MiB)
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/offchain-registration-fixture-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log $ST/logs/root-offchain-registration-fixture.guard -- unshare -rn bash $ST/jobs/root-offchain-registration-fixture.sh > $ST/logs/root-offchain-registration-fixture.out 2>&1; echo $? > $ST/logs/root-offchain-registration-fixture.rc
```
1. **Checks the inputs:** the rig r2 stage `SHA256SUMS` (`aaea7dfa…`) and run `RECEIPTS.sha256` (`e33f07bb…`), plus the reused unpatched receipt's bytes and its adoption-path failure. That receipt is reused, not rerun.
2. **Checks the tools:** the pinned forge and anvil on PATH, as rig r2 used them.
3. **Makes a fresh `cp -a` of the COMPLETED final tree** and checks the copy against `SOURCE-PINS.txt`:
   - HEAD `debbfb37`;
   - the blobs of the test, `supervisor.js`, the rig helper and the base supervisor `3ad76690`;
   - the exact porcelain, including untracked and ignored files (`80b324eb…`);
   - the MockFeed sha256 `ae2e63e0…`.
4. **Patches the copy** and checks the patched blob.
5. **Runs the FULL file, all 3 cases,** with `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR` set.
   - The test timeout is `--test-timeout=900000` and the outer timeout is `timeout -k 10 1500`. Both are above case 1's declared 900 s (rig r2's outer 600 s was too tight); the expected run is about 6 min.
   - The periods are not shortened.
6. **PASS** means rc 0, `ok 1`, `ok 2` and `ok 3`, and exactly tests 3 = pass 3, with fail, skipped, todo and cancelled all 0. It prints `## offchain-registration rc=0`.

## Not claimed
- **Not run:** 3/3 is the expectation, not a result.
- **Scope of a pass:** it qualifies this row only. It is not a whole-104 rerun or a production qualification.
- **Cutover:** the authorized source cutover remains UNQUALIFIED. It is not blocked by permission.
