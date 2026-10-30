# L1 reth proof window: patch, tests and root installation (2026-10-25)

**Current update, 19:56 UTC: the proof-window fix works in the live verification path.**
- Reth recovered from startup MerkleUnwind and is synced; consensus is non-optimistic. The actual running arguments show proof window 256 and proof permits 2. See recovery-1957.json.
- The first repeated portal probe timed out at the original 12-second bound (retest/); preserved as a failure.
- A subsequent bounded probe with a 30-second per-request limit succeeded in 11.3 seconds total (retest-30s/): Helios verified the portal getter and the ASR account proof at one finalized block.
- The authenticated portal getter returned ASR 0x909f6cf47ed12f010a796527f562bfc26c7f4e72. The conflicting 0xdb9091e4… fixture is not the live portal registry.
- A raw own-EL finalized account-proof diagnostic completed in 1.3 seconds (latency/); that direct response alone is not authentication.
- Full A1 game verification and production cutover remain separate, unfinished gates. No existing app was restarted.

**Historical status before recovery: PARTIAL operational validation.**
- **Done:** the config change is installed and reth was restarted.
- **NOT shown yet:** that reth recovered, or that the verified portal read now works. The repeat portal read is **pending**.
- **Not done:** no A1 game read, no production cutover, Base disabled.

## Why

Root's 19:39 Helios-verified portal-getter probe (`../evidence/l1-own-client-1941/portal-result.json`) failed with `distance to target block exceeds maximum proof window`. Our L1 reth ran without `--rpc.eth-proof-window`, whose pinned default is 0.

## Change (source)

**`chain_service.py`** `713b0ddf…` → **`75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92`**. This is the file in `../` (the ops parent). `test_chain_service.py` → `541342a4…`.
- **Added**, in the L1 EL argv only: `--rpc.eth-proof-window 256 --rpc.proof-permits 2`.
- **Unchanged:** CL, Base, prune args, RPC bind/API, authrpc and JWT.

**Exact patch:** `l1-proof-window.patch` (sha `d6b7fdd8…`). The author's report is `claude-l1-proof-window-result.md`, including source citations: reth `DEFAULT_ETH_PROOF_WINDOW = 0`, max 1,209,600.

## Tests (copied logs, `stage-logs/`; `jobs.sh`, `run-queued.sh`)

| Run | rc | Meaning |
|---|---|---|
| `test-20261025T194507Z` | **98** | **NOT STARTED** (small queue lane held). Not a result. |
| `test-20261025T194628Z` | 1 | The patched suites passed (34; coverage activation 33 with 1 skip), but the harness reported **MUTANT SURVIVED**. That was a **false negative of the harness's matcher**: verbose unittest prints startup JSON between the test name and the verdict. The mutant had in fact failed. Kept, not counted. |
| `test-20261025T194648Z` | **0** | Corrected matcher: patched `test_chain_service.py` **34 OK**, `test_coverage_activation.py` **36 OK**; pre-patch `713b0ddf` with the new tests → `test_l1_serves_proofs_at_finalized` FAILS, so **MUTANT KILLED**. Peak 58 MiB, queue 256 MiB. |

## Root installation (`install.py`, `install.out`, `restart.out`, `restart.rc` = 0)

- **19:47:45 UTC:** source `chain_service.py` `75c879ec` **INSTALLED**. The config is unchanged (mode 0644, readable by all users).
- **19:47:50–:56 UTC:** **EL-only** restart, PID 847 → **8111**, clean SIGINT stop.
- **Unchanged:** CL PID 898 and the Base snapshot downloader PID 4061.
- `install.out` also records `coverageVerified: false` and Base still inactive.

## After restart (root observation, 19:49 UTC; no file here)

- **Root observation:** after its consistency check, reth was running a startup **MerkleUnwind** of a partial state trie (26,271,862 → 26,271,832).
- **No claim** that reth has recovered, that proofs at finalized now work, or that the flags are effective in serving. The flags are applied in the argv only.
