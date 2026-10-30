# base-finality-proof-stage: post-anchor finality and restart proof (PREPARED; not run; not production)

**Goal:** qualify that our **launched** Base chain is L1-finalized **beyond** the launch anchor N. The proof comes only from a **fresh** A1-authenticated anchor N' > N, with header ancestry from N' back down to the original anchor.

- Blocks above N are **never** inferred from N; a hash commits to its parent, never to its children.
- Our node's `latest`, `safe` and `finalized` labels are **never** requested.

**Launcher status:** separate from the in-flight launcher (r3) and untouched by this stage. Both launcher HOLD flags stay `False`. This prototype adds its own `FINALITY_PROTOTYPE_REVIEWED = False`.

## Files

| File | Role |
|---|---|
| `src/finality-core.mjs` | The decision. It reuses the reviewed `authenticateAnchor` and `authenticateAncestors` **unchanged** (`vendor/anchor-bootstrap.mjs`, `90a8afba…`). |
| `src/finality_state.py` | The root tool: provenance, process binding, the lock and the finality journal. Commands: `check`, `record` (HOLD), `status`, `revoke`. |
| `a1gate/` | The pinned A1 gate (`a1-gate.mjs` `06cc2961…`, `a1-recheck.mjs` `f591f324…`, `a1-anchor.mjs` `ec92b70f…`), byte-identical to the harness pins. |
| `tests/finality-core.test.mjs` | 20 adversarial core tests. |
| `tests/test_finality_state.py` | 27 tool tests. |
| `tests/helpers/chain.mjs` | Synthetic chain helper. |
| `jobs/root-finality-tests.sh` | Root's offline job, with exact counts. |
| `integration/` | An **optional** patch against the frozen **r2** `base_launch.py`. Not applied; the launcher owner rebases it onto r3. |
| `SHA256SUMS` | Pins every file. |

## How the proof is decided (`finality-core.mjs`)

1. Read the chain id from the **bound** node; it must be `0x2105`.
2. Read header N' by explicit number. It must reproduce the **fresh** A1 output root (`authenticateAnchor`).
3. Walk **down** from N' to N in chunks (`authenticateAncestors`). Each chunk ends at the authenticated `parentHash` of the chunk above it.
4. Header N must hash to the **launch record's** anchor hash and reproduce the **original** A1 output root.
5. Every earlier qualified point (n, hash) must lie on the path.

**Outcomes:**

| Outcome | Meaning | Recorded? |
|---|---|---|
| **Verdict** | qualified | yes |
| **Refusal** | not synced, wrong chain, malformed input, too long, or an RPC failure | nothing recorded |
| **Contradiction** | a fork, a DB swap, broken ancestry, a lying hash claim, a wrong block for a number, or an earlier point off the path | recorded as **terminal**, but only when the same bound process answered before and after |

## Provenance of each input (`finality_state.py`)

| Input | Source | Check |
|---|---|---|
| Original N, hash, root, game, L1 block; release sha; datadir; mdbx dev/ino | `launch.json` | Its sha must equal root's `chain.json` `baseBootstrap.anchorLaunch` pin. |
| The launch was started | the wrapper's own `W.journal_entries`, under `W.launch_lock` | The last event must be `consumed`; `rolled-back` and pending states refuse. |
| Fresh N', root, game, L1 block | ONE output directory of the **reviewed producer** `live-1958/run.py` (`b3044bbf…`) | See the list below. |
| Our chain | the process found through `/proc` | See the list below. |

**Fresh-A1 checks:**
1. The directory and all of its files are root-owned. No symlinks; nothing is group- or other-writable.
2. The run record has the pinned `inputPins`, Helios binary `cc962e2b…` and `fresh-finalized`, plus exit 0, Helios stopped and no error.
3. The config names the mainnet portal, the ASR and chain 1.
4. The **pinned** A1 gate (fresh-initial) passes.
5. The harness's `gate_a1` rules pass: the receipt is at most 900 s old and lies inside the run window, and the ASR, respected game type, code hashes and L1 age hold.
6. Post-anchor rules: N' > N; another game; a newer L1 block; not a replay (receipt or run already used); strictly newer than every earlier qualification.

**Process-binding checks** (identical before and after the proof):
- the process is the **only** listener of the loopback RPC port;
- its `exe` sha is the launch release sha;
- it holds the launch record's `mdbx.dat` (dev/ino) open;
- its pid and starttime are unchanged.

## State

- **Format:** `<finality-dir>/NNNNNN.json`, hash-chained and append-only. A durable append (`partial` file, `link` with no clobber, `fsync`) happens under the **launch lock**. There is one finality directory per launch. Root creates it, root-owned, mode 0700.
- **Transitions:**
  - none or `qualified` → `qualified`, `contradicted` or `revoked`;
  - `contradicted` and `revoked` are terminal.
- **`status`:** a qualification is current only for the recorded launch-journal head **and** the recorded running process. A restart reports `stale-after-restart`; a rearm or new consumption reports `stale-launch-changed`. Either way, a new fresh proof must re-walk through every earlier qualified point.

## Root commands

| Command | What it does |
|---|---|
| `jobs/root-finality-tests.sh` | The tests: local, offline, queue. The exact command is in its header. |
| `check` | Live, **after** a fresh run of the reviewed A1 runner. Verifies and records nothing. Needs `FINALITY_NODE`, `FINALITY_DEPS_ROOT` and a root-owned 0700 `FINALITY_WORKDIR`. |
| `record` | Refuses (HOLD) until root sets `FINALITY_PROTOTYPE_REVIEWED` after review. |

## Not established / limitations (refusals, not assumptions)

- **The A1 receipt is a trusted root-produced record.** This tool cannot re-verify Helios, which is the same limit as the harness.
- **Gaps in `run.py`'s run record:**
  - it records neither its own sha nor `a1-config.json`'s sha; both are checked as files in the same root-owned directory;
  - it does not pin `ANCHOR_DEPS_ROOT` (`@noble/hashes` and `viem`) or `l1_authority.py`.
- **A fresh N' > N needs a newer finalized anchor game.** Its cadence is not known here.
- **The wrapper interface may change.** The `W.journal_entries` and `W.launch_lock` interface is r2's; if r3 changes it, the adapter must follow.
- **`/proc` binding** assumes the node's RPC listens on IPv4 loopback in the host network namespace, with no container indirection.
- **Not covered:** receipts and state of blocks N..N' beyond the header chain. State is covered **only** at N' via the output root.
