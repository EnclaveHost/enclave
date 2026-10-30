# base-finality-proof-stage: preparation result (PREPARED; nothing run; not production)

**Status:** source, tests and a root test job are prepared. **Claude ran nothing:**
- no tests, builds, queue jobs, network or SSH access, live actions or commits;
- the only checks were static syntax: `bash -n`, Python `ast.parse` and `node --check`, plus sha256.

**The tests were never executed and are unproven.** Root's first run is the first evidence. A first-run failure is possible and must be reported as such, not waived.

**Scope boundaries:**
- Launcher r3, composition r4 and Windows r3 were not touched.
- `base-launch-producer-stage/r2` was only read; its `MANIFEST.sha256` still verifies.
- **The HOLD flags are unchanged and False:**
  - launcher r2 `FINALITY_PROOF_REVIEWED = False` (`producer/base_launch.py:39`);
  - launcher r2 `LAUNCH_PRODUCER_REVIEWED = False` (`wrapper/chain_service.py:467`);
  - this prototype's `FINALITY_PROTOTYPE_REVIEWED = False` (`src/finality_state.py:29`).

## Manifest

The stage is `base-finality-proof-stage/`. `SHA256SUMS` sha256 is `e21761c287564d972b13bcfc08ec0a4d48ca2da89b29d3847e7e5c3109736560`.

| File | sha256 | Origin |
|---|---|---|
| `src/finality-core.mjs` | `686cbc22…6eab` | new: the decision |
| `src/finality_state.py` | `cc337417…dcf7` | new: root tool (provenance, `/proc` binding, lock, finality journal) |
| `vendor/anchor-bootstrap.mjs` | `90a8afba…e8f8` | **reused, byte-identical** (reviewed `authenticateAnchor`/`authenticateAncestors`) |
| `a1gate/a1-gate.mjs` | `06cc2961…414c` | reused, byte-identical (harness `A1_GATE_PINS`) |
| `a1gate/a1-recheck.mjs` | `f591f324…d9d8` | reused, byte-identical |
| `a1gate/a1-anchor.mjs` | `ec92b70f…528d` | reused, byte-identical |
| `tests/finality-core.test.mjs` | `7013894a…b0d2` | new: 20 tests |
| `tests/test_finality_state.py` | `78f0cae9…9ece` | new: 27 tests |
| `tests/helpers/chain.mjs` | `a7d28c91…341a` | new: synthetic chain hashed with the vendor functions |
| `jobs/root-finality-tests.sh` | `fc4fd2e4…5d52` | new: root's offline test job |
| `integration/base_launch-r2-record-bootstrapped.patch` | `ec880b0f…123d` | new: **optional**, NOT applied |
| `README.md` | `ff9f2127…bd89` | design, provenance table, limitations |

## What the prototype decides

**The core (`finality-core.mjs`):** our launched chain is finalized beyond N only through a **fresh** A1 anchor N' > N.
1. Our node's header N' reproduces the fresh output root (`authenticateAnchor`).
2. The headers are walked **down** from N' to N (`authenticateAncestors` in chunks; each chunk ends at the authenticated parent hash).
3. Header N hashes to the launch record's anchor hash and reproduces the **original** output root.
4. Every earlier qualified point lies on the path.

**What it never does:**
- infer anything above N from N;
- request `latest`, `safe` or `finalized` (only explicit numbers are read);
- accept a header's claimed `hash`.

**Results are classified:**
- **refusal:** no evidence; nothing is recorded;
- **contradiction:** authenticated values disagree with the bound node; terminal.

**Inputs and their provenance (`finality_state.py`):**

| Input | Source |
|---|---|
| Launch values | `launch.json` |
| Proof that the node was started | the wrapper's own verified journal |
| Fresh anchor | the **reviewed** A1 producer's output |
| Our chain | the node process |

- **`launch.json`:** its sha must equal root's `chain.json` `baseBootstrap.anchorLaunch` pin. It binds N, hash, root, game, L1 block, release sha, datadir and mdbx dev/ino.
- **The started launch:** read through the wrapper's own `W.journal_entries`, under `W.launch_lock`; the last event must be `consumed`.
- **The fresh anchor:** ONE root-owned output directory of the reviewed producer `live-1958/run.py` (`b3044bbf…`). The tool **does not produce receipts and accepts no proof file from any other source.** It checks:
  - the run record: `inputPins`, Helios `cc962e2b…` and `fresh-finalized`, exit 0, Helios stopped, no error, and the receipt time inside the run window;
  - the config: mainnet portal, ASR and chain 1;
  - the **pinned A1 gate**;
  - the harness's `gate_a1` rules (age ≤ 900 s, ASR, game type, code hashes, L1 age);
  - post-anchor rules: N' > N, another game, a newer L1 block, no replay, and newer than every earlier qualification.
- **Our chain:** the process bound through `/proc`. It must be the sole listener on the loopback RPC port, run the release binary (sha), and hold the launch's mdbx dev/ino open. The binding is identical before and after the proof.

**State:**
- **Format:** a separate hash-chained, append-only finality journal, with durable appends under the **launch lock**.
- **Transitions:**
  - none or `qualified` → `qualified`, `contradicted` or `revoked`;
  - `contradicted` and `revoked` are terminal.
- **`status`:** current only for the recorded launch-journal head **and** the recorded process. Otherwise it reports `stale-after-restart` or `stale-launch-changed`.
- **`record`:** refuses before any write while the prototype is unreviewed. `check` verifies and writes nothing.

## Adversarial tests (prepared, NOT run)

**Core, 20 tests:**
- wrong chain id;
- wrong fresh root, and a fork above N;
- tampered middle header, a lying `hash` field, and the wrong block returned for a number;
- wrong original anchor, a DB of another chain at N, and an internally inconsistent launch record;
- an earlier qualified point off the path;
- a stale or replayed fresh anchor;
- no proof (N' ≤ N);
- node not synced, an RPC failure, a non-Isthmus header, span too long, malformed inputs;
- a descendant standing in for N';
- explicit-number-only reads, and the chunk-boundary equivalence.

**Tool, 27 tests, 3 of them end-to-end through the real core and a loopback stub:**
- **HOLD and missing input:** `record` held while unreviewed, and no-proof refusals;
- **Launch pin and journal:** launch pin absent or different; launch not started or rolled back;
- **Lock:** lock busy;
- **Fresh receipt:**
  - stale receipt, not post-anchor, same game, older L1, replay, not newer;
  - runner provenance (Helios sha, exit code, Helios stopped, input pins, error, `run.py` sha, config);
  - receipt outside its run window;
  - ASR, game-type and code-hash pins;
  - symlinked or writable files;
- **Process binding:** wrong binary, other DB, two listeners, non-loopback URL, no listener; a process change during the proof;
- **Contradictions:** recorded only for the same process, and terminal;
- **Core refusals:** never recorded;
- **Revoke and status:**
  - revoke is terminal;
  - status after a restart or a rearm;
  - a tampered or foreign journal;
  - an interrupted append;
- **Evidence:** it binds the launch head, process, receipt and code;
- **Pins:** the core pin is enforced;
- **End-to-end:**
  - qualification with nothing written;
  - record, then `status` current, then stale after a restart;
  - a DB of another chain, recorded as a contradiction and then terminal;
  - wrong chain id and node not synced also run through the real core and the stub.

## Root test instructions (local, offline)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-finality-tests.guard -- unshare -rn bash $ST/jobs/root-finality-tests.sh > $ST/logs/root-finality-tests.out 2>&1; echo $? > $ST/logs/root-finality-tests.rc
```

**PASS requires all of:**
- `SHA256SUMS` verifies before and after the run;
- no network route;
- `@noble/hashes` 1.8.0 at `source/node_modules`;
- `run.py` pin `b3044bbf…`;
- all three HOLD flags False;
- JS: exactly `# tests 20` / `# pass 20` / 0 fail, cancelled, skipped and todo, with rc 0;
- Python: exactly `Ran 27 tests` and `OK`, no skips, rc 0;
- `## finality rc=0`.

Anything else, including a timeout or an unknown exit, is a FAIL. Queue exit 98 means the job did not start. The 512 MiB memory figure is an estimate.

## Missing steps and limitations (exact; not claimed complete)

1. **Untested.** Root review plus the first run of `root-finality-tests.sh`. Spots most at risk on a first run:
   - the `unittest -v` line formats;
   - the loopback `http.server` under `unshare -rn`;
   - the fake `/proc` parsing;
   - the CommonJS import of `@noble/hashes/sha3.js` (the same pattern as the harness's `authenticate()`).
2. **No fresh N' > N exists yet.** It requires a newer finalized anchor game; its cadence is unknown. Root then has to run the reviewed `run.py` live, in a new root-owned directory. The tool refuses `same_game` until then.
3. **Producer provenance gaps** (accepted only as root-owned files in the same directory; root must decide):
   - `run-result.json` does not record `run.py`'s own sha or `a1-config.json`'s sha;
   - it pins neither `ANCHOR_DEPS_ROOT` (`@noble/hashes`, `viem`) nor `l1_authority.py`;
   - the Helios checkpoint provenance is only what `heliosStatus` reports.

   Like the harness, this tool **cannot re-verify Helios**: the A1 receipt is a trusted root-produced record. I did **not** extend the producer, which would be a new receipt producer.
4. **No live run is possible yet.** A live `check` needs a launched, running node; nothing has been launched. `record` stays HOLD.
5. **The wrapper interface may change.** The tool uses r2's `W.journal_entries` and `W.launch_lock`. If launcher r3 changes them, the adapter must follow.
6. **Integration:**
   - the optional patch targets the frozen **r2** `base_launch.py` (`7e8d295d…`); the launcher owner must rebase it onto r3;
   - installing `finality_state.py`, creating the root-owned 0700 finality directory, and any change to `FINALITY_PROOF_REVIEWED` are root decisions;
   - the patch keeps that flag False and adds no launch-journal event.
7. **Coverage limit.** Coverage is the header chain N..N' plus the output root (state, message-passer root, hash) at N' and at N. Receipts and per-block state between them are **not** independently authenticated.
8. **Contradictions in `check` mode.** `check` prints a contradiction but cannot record it while `record` is held.
9. **`/proc` binding assumptions:** the node RPC on IPv4 loopback in the host network namespace, with no proxy or container indirection.
10. **Performance:** not measured. There is one RPC per header, and `MAX_SPAN` is 4,000,000. A large N'..N span means many sequential loopback requests.
11. **Receipt freshness:** the receipt is accepted for at most 900 s, so `check` must run soon after the A1 run.
