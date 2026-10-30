# Composition baseline diagnosis: result (PREPARED; nothing run)

**What Claude did:** reads (`git show`/`rev-parse`/`archive`-free inspection of r9's private `src.git`), sha256, a `git apply` check of the patch in a temp copy, and `bash -n`.
- **Not done:** no tests, builds, queue jobs, network or SSH access, live actions or branch commits.
- **Untouched:** r9 (deliberately interrupted by root with exit 130 during E2: **INCOMPLETE, never PASS**, `logs/r9-root-interruption.txt`), r10 (da0), and every source tree and old snapshot.
- **Out of scope:** da0's `attested-route-composition` validation-order regression.

## Stage `composition-baseline-fixes-stage/` (`SHA256SUMS` sha256 `c5979b92072da9eef5c456f3b53e912a50d5004f2328ac70d57954d4a63629c2`)

| File | sha256 |
|---|---|
| `README.md` (coordination: the exact files owned) | `f8287525a20f166485ed8ccef10d125c5e3f1c73f4dfad09cc13b7a43bfa8f5c` |
| `jobs/root-baseline-fixes.sh` (self-contained root runner, exact counts) | `3139c23f7d1cccf8f9e1d5ba75dfc5de6d3de27539b050cf4f5465e5684c8861` |
| `patches/native-relay-remote-verifier-refusal.patch` (test-only) | `654b3f1788f4fccb3b1852968f9eb9987e68ea2d2804edbf7c2b9a2da47230e7` |

## Pins

**Commits:**

| Role | Commit |
|---|---|
| candidate | `82ec7d455cc6e9957c1500f6e58ffde557093392` (`refs/r9/candidate`) |
| component baseline | `81ba668531d17151db810e14562c77a672d742e4` (`refs/src/consumers`) |

**Source blobs:** identical at both commits unless noted.

| File | Blob |
|---|---|
| `test/native-relay-chain-authority.test.mjs` | `74585289…`; patched `ff0c676e…` |
| `relay/dns-relay.js` | `a57bf132…` |
| `relay/relay-chain-authority.mjs` | `28f76083…` |
| `network/chain-authority.mjs` | `61673aba…` |
| `test/storage-front-binding-release.test.mjs` | `904dc5e8…` |
| `test/helpers/lease16d-rig.mjs` | `71c93a11…` |
| `test/dns-relay-chain-authority.smoke.test.mjs` | `faf36299…` |
| `foundry.toml` | `fe724656…` |
| `relay/build-network.mjs` | `b942e41d…` |
| `test/lease-relay-host-policy.test.mjs` | candidate `552189f7…` (consumers `d981adf1…`) |
| `test/helpers/cli-independent-rig.mjs` | candidate `c28a1a75…` (consumers `e9cb03d7…`) |

**Toolchain (operator-observed hashes, checked by the runner):**

| Tool | sha256 |
|---|---|
| forge (1.7.1) | `4f77da08…` |
| anvil | `10c1c727…` |
| svm solc 0.8.35 | `fa8ac9a3…` |

**Original r9 failure outputs, preserved** (r9 run `r4-20261026T023428Z/logs`):

| Output | sha256 |
|---|---|
| native-relay, component | `be04d435…` |
| native-relay, final | `8becb7ba…` |
| storage-front, final | `2018fb20…` |
| lease-relay host-policy, final | `1d6ee5d8…` |
| DNS smoke, component | `24633b59…` |
| DNS smoke, final | `78c5aec8…` |

## Diagnosis (from the real errors)

1. **`native-relay-chain-authority`: 7/1 in both the component and the final tree. A stale fixture message; the product is correct.**
   - **The real error:** `The input did not match /fatal: APP_CHALLENGE_AUTH: .*local endpoint/. Input: 'fatal: chain authority: the verifier must be a local endpoint (loopback); a remote server is not a verifier'` (test line 211).
   - **The cause:** `bf77da364` ("Route DNS fleet reads through the selected relay chain authority") added the fleet's `relayChainAuthority(process.env)` at `relay/dns-relay.js:88-89`. It runs the same `chainAuthorityFromEnv` validation **before** the `APP_CHALLENGE_AUTH` block (`:139`), so a remote verifier now stops the process earlier, with the shared message.
   - **The patch:** it keeps exit 1, asserts that **exact** earlier message, and adds that the app-zone reader was never built and that no verifier was asked.
   - **Not weakened:** no other assertion changes. The other refusals (mixed, unknown or invalid selection) are untouched; they still pass through the same gate and are covered by the other subtests.
2. **`storage-front-binding-release`: 0/5.**
   - **The real error:** `ENOENT …/contracts/foundry/out/SessionMocks.sol/MockUSDC3009.json`. The rig (`lease16d-rig.mjs:65`) reads forge output, which is gitignored and was never built in the r9 trees.
   - **The fix:** setup only.
3. **`lease-relay-host-policy`: 6 pass + 3 SKIPPED** ("needs the Foundry build (forge build)").
   - **The cause:** the same missing forge output; `haveTools()` checks `EnclaveDeployments.sol/EnclaveDeployments.json`.
   - **The fix:** setup only. A skip is a failure here.
4. **`dns-relay-chain-authority.smoke`: component 4 FAIL, final 4 PASS.**
   - **The real errors:** `build it first: (cd relay && node build-network.mjs)` and `ERR_MODULE_NOT_FOUND …/trees/consumers/relay/network-runtime.bundle.mjs`.
   - **The cause:** the untracked generated bundle was built only in the regenerated final tree, not in the component baseline export.
   - **The fix:** setup only.

**Product changes:** none. No read, proof, admin or host-policy gate was weakened, and no assertion was made tautological.

## Artifact closure (shared approach; no duplicated code)

The forge step uses **the same convention as root's existing `jobs/forge-subset.sh`**: the repo's `foundry.toml`, forge 1.7.1, svm solc 0.8.35, `--offline`, `-j 1`. Here it is a full build, because the rigs read both `contracts/` and test-directory artifacts. The network runtime uses the tree's own `relay/build-network.mjs`, as r9's phase D does.

When da0's MCP r3 offline-artifact step exists, it can replace this runner's one forge line 1:1 under these conditions:
- the same solc, forge and `foundry.toml`;
- output in the test tree's `contracts/foundry/out`;
- the runner's existence checks for `SessionMocks.sol/MockUSDC3009.json` and `EnclaveDeployments.sol/EnclaveDeployments.json` stay.

## Root runner (self-contained)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composition-baseline-fixes-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 6144 --log $ST/logs/root-baseline-fixes.guard -- unshare -rn bash $ST/jobs/root-baseline-fixes.sh > $ST/logs/root-baseline-fixes.out 2>&1; echo $? > $ST/logs/root-baseline-fixes.rc
```

**What it does:**
- **Checks first:** the stage `SHA256SUMS`, the two r9 refs, and the solc/forge/anvil hashes. It requires that no network route exists.
- **Builds private trees:** `git archive` exports under `$ST/runs/<id>/trees`, with the dependency closures from `work/enclave` (root, `network/`, `relay/`) **copied inside**, as r9 does. In each tree it builds `relay/build-network.mjs`; in the candidate it also runs the offline forge build.
- **Patches:** `git apply` of the patch to the candidate export only.

**Exact expectations.** Each row must match exactly, including skipped = todo = cancelled = 0:

| Tag | Tree / file | rc | tests | pass | fail |
|---|---|---|---|---|---|
| `cand-native-ORIGINAL` | candidate, native-relay **unpatched** (the original failure, preserved: exactly test 6 failing) | 1 | 8 | 7 | 1 |
| `cand-native-PATCHED` | candidate, native-relay patched | 0 | 8 | 8 | 0 |
| `cand-storage-front` | candidate + forge out | 0 | 5 | 5 | 0 |
| `cand-lease-host-policy` | candidate + forge out (the 3 REAL-gate tests run) | 0 | 9 | 9 | 0 |
| `cand-dns-smoke` | candidate + network runtime | 0 | 4 | 4 | 0 |
| `cons-dns-smoke` | consumers baseline + network runtime | 0 | 4 | 4 | 0 |

PASS = `## baseline-fixes rc=0`. Anything else, including a timeout, fails; queue exit 98 means the job did not start.

## Limits

- **Memory and time** for the full via-IR forge build (`-j 1`) are unmeasured. 6144 MiB is an estimate.
- **The forge output is not pinned:** it is generated in the run and only its two required artifacts are checked for presence. Its bytes are whatever the pinned toolchain produces.
- **Anvil, openssl and node** must run inside `unshare -rn` (loopback only). Their versions are recorded in `tools.txt`.
- **The expected counts** come from the r9 outputs (8 subtests counted in the native-relay TAP) and from the test sources. They have never been executed with these fixes.
