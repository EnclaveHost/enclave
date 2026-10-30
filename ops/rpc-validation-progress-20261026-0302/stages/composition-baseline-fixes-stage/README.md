# composition-baseline-fixes-stage (PREPARED; nothing run; coordination file for da0)

**Scope:** the r9 BASELINE-NOT-CLEAN components only, at the r9 candidate `82ec7d455cc6e9957c1500f6e58ffde557093392` (`refs/r9/candidate`).
- r9 (still running, frozen), r10 (da0), every source tree and every old snapshot are **not edited**.
- da0's `attested-route-composition` validation-order regression is **not** touched here.

## Files owned by this stage (nothing else)

| File | Role |
|---|---|
| `patches/native-relay-remote-verifier-refusal.patch` | Test-only. One assertion block of `test/native-relay-chain-authority.test.mjs`, identical at 81ba and 82ec. |
| `jobs/root-baseline-fixes.sh` | Root's targeted runner, with exact expected counts. |
| `README.md`, `SHA256SUMS` | This file and the pins. |

**For da0's r10:**
- apply the patch to the composed tree;
- give every test tree (component baselines included) the **network runtime** (`node relay/build-network.mjs`) and the **forge build** (`forge build --offline`, using the cached solc 0.8.35), as the runner shows;
- no product file changes.

## Diagnosis (from r9 run `r4-20261026T023428Z`)

| Component | r9 result | Exact cause | Fix |
|---|---|---|---|
| `native-relay-chain-authority` | component **and** final 7 pass / 1 fail, in test 6 | Stale assertion. `bf77da364` added an earlier startup gate (`relay/dns-relay.js:88-89`, the fleet's `relayChainAuthority`). It refuses a remote `ENCLAVE_CHAIN_VERIFIER` with `fatal: chain authority: the verifier must be a local endpoint (loopback)…` before the `APP_CHALLENGE_AUTH` block, so the old regex `/fatal: APP_CHALLENGE_AUTH: .*local endpoint/` can never match. The product refuses correctly, and earlier. | Patch: assert exit 1 and the **exact** earlier message, **plus** that the app-zone reader was never built and that no verifier was asked. |
| `storage-front-binding-release` | 0 pass / 5 fail (`ENOENT …/contracts/foundry/out/SessionMocks.sol/MockUSDC3009.json`) | Missing generated context. The test's rig reads forge output, which is gitignored and was never built in the r9 trees. | Setup: offline `forge build`. |
| `lease-relay-host-policy` | 6 pass, **3 skipped** ("needs the Foundry build") | The same missing forge output (`haveTools()` checks `EnclaveDeployments.json`). | Setup: offline `forge build`. The 3 REAL-gate tests then run; no skip is allowed. |
| `dns-relay-chain-authority.smoke` | component 4 fail (`build it first … network-runtime.bundle.mjs`), final 4 pass | Missing generated context in the **component baseline** tree: the untracked `relay/network-runtime.bundle.mjs` was built only in the regenerated final tree. | Setup: build the network runtime in the baseline export. |

**Not weakened:** no read, proof, admin or host-policy gate, and no assertion is replaced by a tautology. The refusals are the same; the native-relay check is stricter.

**Toolchain:** forge `4f77da08…` (v1.7.1), anvil `10c1c727…` and solc 0.8.35 `fa8ac9a3…` at `~/.local/share/svm`. These are operator-observed hashes, checked by the runner.
