# L1 proof window patch: FINAL (2026-10-25, tests passed 19:46:48 UTC)

**Status:**
- **Source:** patched and tested, ready for root review. **Not applied live.**
- **Not done:** no SSH, restart, install, commit or native build.
- **No A1 claim.** In the 19:39 portal probe, the getter failed at reth's proof-window refusal, before any EVM read. Nothing
  about the anchor or game has been verified.

## Defect (live, `outputs/.../l1-authority-live-1941/portal-result.json`)

- **What worked:** pinned Helios `cc962e2b…` reached `fresh-finalized` against our loopback L1. Finalized block 26271752
  had an age of 1066 s.
- **What failed:** the verified `eth_call` at finalized was refused with `-32602 distance to target block exceeds maximum
  proof window`.
- **Cause:** the L1 `reth node` argv in `chain_service.py` did not pass `--rpc.eth-proof-window`. The pinned default is 0.
- **Source confirmation** (reth `7134be3` source, a v2.5.2 checkout in the local cargo cache):
  - `DEFAULT_ETH_PROOF_WINDOW = 0` and `DEFAULT_PROOF_PERMITS = 25` (`crates/rpc/rpc-server-types/src/constants.rs:47,62`);
  - the flag accepts values up to `MAX_ETH_PROOF_WINDOW = 1,209,600`, so 256 is valid;
  - `--rpc.proof-permits` exists (`crates/node/core/src/args/rpc_server.rs:629-637`).
- **The deployed L1 binary** is reth v2.8.0. Root confirmed that the pinned guest `reth node --help` lists the flags; I did
  not run the binary.

## Patch: `l1-proof-window-stage/l1-proof-window.patch` (sha256 `d6b7fdd8bbacbcfb6ec9c68cb3d9e4f372ce92e61dd70b5d176318e31c903ad0`)

| File | Before | After |
| --- | --- | --- |
| `chain_service.py` | `713b0ddf4c99d12ca38e32e0e7b83a6ccb312230c70033ece976b8f7f11a4f57` | `75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92` |
| `test_chain_service.py` | `5c3907b8ba491c537a935223b90baddb4d0967ab82834d54f202a2ea24f1eb20` | `541342a40999cbfb4f186487540b716357423398e45e976e81a336e6c3a63330` |
| `test_coverage_activation.py` | `24c37c51…` | unchanged |

**Code change: the L1 `side == 'el'` branch only.**
- It adds `'--rpc.eth-proof-window', '256', '--rpc.proof-permits', '2'` after `--rpc.max-connections 64`, plus a two-line
  comment.
- 256 blocks × 12 s is about 51 min, which is more than the 1800 s maximum finalized age. Two permits bound the cost of
  concurrent `eth_getProof` calls.
- **Unchanged:**
  - prune args and the caps (`--rpc.max-connections 64`);
  - `--http.api eth,net,web3` on 127.0.0.1;
  - authrpc, JWT and P2P;
  - CL and Base, including Base's `--rpc.eth-proof-window 1800`.
- **Danger check:** no `--full`, `--minimal`, `--ws` or `--archive`, and no admin or debug API. There are no other `-`/`+`
  lines in the code diff.

**New tests** (`PruneProfileTests`):
- **`test_l1_serves_proofs_at_finalized`:**
  - the emitted EL argv has exactly one `--rpc.eth-proof-window 256` and one `--rpc.proof-permits 2`;
  - 256 × 12 > 1800;
  - the prune part still equals `EXPECTED_PRUNE`;
  - http.api, http.addr and max-connections are unchanged;
  - there is no full, minimal, ws, archive, admin or debug.
- **`test_base_proof_window_unchanged`:** Base still emits exactly `--rpc.eth-proof-window 1800`, has no
  `--rpc.proof-permits`, and its prune part equals `EXPECTED_BASE_PRUNE`.

## Tests: shared queue, `--mib 256`, `unshare -rn` (offline), `REAL_SNAPSHOT_MANIFEST` set

**Final run: `l1-proof-window-stage/logs/test-20261025T194648Z.{out,rc,guard}`.** It exited rc 0 with a peak of 58 MiB, and
host available memory stayed at least 19,660 MiB.

| Suite | Result |
| --- | --- |
| `test_chain_service.py` (32 existing + 2 new) | **34/34 OK** |
| `test_coverage_activation.py` (on patched `chain_service`) | **36/36 OK, 0 skips** |
| mutant: pre-patch `713b0ddf` + new tests | **KILLED**: `test_l1_serves_proofs_at_finalized` FAIL (`0 != 1 : --rpc.eth-proof-window`), base test ok |

**Hashes:**

| File | sha256 |
| --- | --- |
| `test-20261025T194648Z.out` | `495dc383…` |
| `test-20261025T194648Z.guard` | `f8e01fb0…` |
| `jobs.sh` | `7c4861a4…` |
| `run-queued.sh` | `ed65dee8…` (retries only on exit 98, at most 20 attempts) |

**Earlier attempts, each kept under its own name:**
- **`test-20261025T194507Z`:** rc 98, the queue did not start it.
- **`test-20261025T194628Z`:** rc 1, from two defects in the recipe, not the code:
  - `REAL_SNAPSHOT_MANIFEST` was unset, so the coverage suite ran 33 tests with 1 skip;
  - the mutant-verdict grep expected `FAIL` on the test-name line, but verbose unittest prints the startup JSON there.
  - In that run the code tests passed and the mutant actually failed. I fixed only `jobs.sh`; source was unchanged
    between the two runs.

## For root's install

- Compare against source `75c879ec…`.
- Apply after the readiness window, which has ended. **Preserve `/etc/enclave-rpc/chain.json` at mode 0644 and owner
  root:root**: this patch does not touch the config, and the installer must not re-mode it.
- The L1 EL needs a restart to take the flags, which is root's decision on timing.
- Then repeat the Helios portal probe. Only that probe can show whether the `anchorStateRegistry()` getter and the A1 read
  work.

## Separate issue, documented and NOT fixed here

The readiness window finished: the L1 health, paired finality, advancement and custody gates (6 gates) passed over 720 s.
- **L1 identity is INCOMPLETE.** `eth_getBlockByNumber(0)` returns error 4444 (pruned history; earliest 26,100,000).
- This conflicts with the bounded 140k L1 retention. The readiness identity check needs a different genesis-identity
  basis, for example chain id plus a checkpoint or retained-block hash, or a policy decision.
- It was not changed in this task.
