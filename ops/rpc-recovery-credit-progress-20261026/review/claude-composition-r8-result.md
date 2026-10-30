# Composition r8: the Windows consumer work is PARTIALLY composed; the Windows chain-authority core is an UNRESOLVED BLOCK

Stage: `rpc-runtime-composition-stage/r8/` (SHA256SUMS `b0bdb2239d5d0373…`). Private scratch repo only; r3–r7 are untouched.
- **What ran here:** git reads, sha256, `node --check` and the static link checker. No tests, builds, queue, network, SSH, live work or upstream commits.
- **Not consumed:** the owner-CLI stage (its root test is still running, with no PASS or apply receipt).

## Input (verified)
- **Commit:** consumer `fix/rpc-relay-consumers-20261025` = **e4f507d6b7259ae5ceae7c89033d80c9b9074908**. It is one commit on aebf4c932 (the seam in r3–r7) and changes 11 files.
- **Root receipt:** `logs/windows-authority-e4f507d6b-root-receipt.out`, sha256 **70d39eaa…** ("Runtime new12 + regressions73 = 85 PASS, zero skipped/cancelled/todo"; `## rc=0`).

## What r8 carries: `refs/r8/candidate-partial` 8fdf00d001c593602c3639dca79d3ec4bcf2e559 (ONE parent: r7 c154f05c)
| e4f file | r8 | provenance / reason |
|---|---|---|
| network/paid-network.mjs | **e4f** | r7 == aebf for this file, so only e4f changed it (paid settlement under the verifier: own backend, bound first) |
| windows/node/host-identity.mjs | **clean three-way** on aebf | adds e4f's `verifierReader` (single-authority agreed() reader); route's 3/1-line change kept |
| network/enclave-network-host.mjs | **e4f hunks** | `ownerSignatureReader` generalizes r7's identical inline rule (pinned → quorum reader; explicit verifier → the agent's verifier LeaseReader) and also requires `reader.agreed`: the contract-wallet owner path |
| network/privacy-agent.mjs | **union** | e4f's `createPaidNetwork` with `chainVerifier` + r7's startup-cancellation check and `wallet` |
| windows/node/host-admission.bundle.mjs, metal/guest/host-policy.bundle.mjs | **REGENERATE** | rebuilt by the job from the composed sources (interim r7 bytes) |
| windows/node/chain.mjs, host.mjs, network-enroll.mjs, agent.mjs, test/windows-chain-authority-runtime.test.mjs | **BLOCK: not composed** | below |

- **Kept from r7:** its 4 source fixes, all 162 route-only files, and all r7 guards and tests (unchanged files).
- **Static checks:** the edited JS parses, and the bundle-entry link check reports 20 imports with 0 broken.
- **Why e4f is not a parent:** recording it as merged would make a later merge silently skip its uncomposed core. The provenance is in the commit message ("Partially-Applied-From (NOT a merge)") and in R8-RESOLUTIONS.json.

## UNRESOLVED BLOCK: two different, separately tested Windows chain-authority designs
Both select the local verifier through `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER` (loopback, unsafe tier, no public RPC). They differ in substance:

| | route (in r7; route-lineage tests) | consumer e4f507d6b (root 85 PASS) |
|---|---|---|
| state reads | `network/verified-read-client.mjs` LeaseReader 'verifier'; `publicClient()` = verifiedStateClient; **coherent one-block snapshots** (`stateSnapshot()` for session-api-auth, paged `allDeployments`) | `network/chain-authority.mjs` `createChainAuthority` client (VERIFIER_CLIENT), the **same authority as supervisor.js, the relay, the lease-gas runtime and the measured guest** |
| transactions | **ENCLAVE_CHAIN_TX_RPCS**: an untrusted transport list, not bound to the verifier | **ENCLAVE_CHAIN_TX_BACKEND**: the operator's own backend, **bound to the verifier's chain by `actionGate` before every send** |
| invalid selection | throws when the module loads (the node stops) | a refusing authority (every read and send refuses; no provider) |
| API | `chainAuthority()` = descriptor `{authority:'local-verifier', verifier, tier, transactions}` (legacy `provider-fallback`), `transactionClient()`, `stateSnapshot()`, `chain-reader.mjs` | `chainAuthority()` = the authority object (`.client`; null in legacy), `chainAuthoritySelection()`, `ownTxBackend()`, `connectivityProbeUrls()` |
| callers | agent.mjs status/snapshot/transactionClient, host-onchain.mjs, host-identity check-endpoint, host.mjs startup, network-enroll `agentChainAuthority` | host.mjs startup (`authority.client` → verifierReader), network-enroll `agentChain` (selection shape + migration), agent `chainAuthoritySelection()` |
| tests asserting it | test/windows-chain-authority.test.mjs (incl. ENCLAVE_CHAIN_TX_RPCS cases), test/windows-verifier.e2e.test.mjs, test/helpers/windows-chain-driver.mjs | test/windows-chain-authority-runtime.test.mjs (the 12 new) |

**Exact conflicts on base aebf** (`r8/m3/*.diff3`): chain.mjs 4 hunks / 90 lines; host.mjs 2/19; network-enroll.mjs 2/26 (route's `verified` mapping and migration also sit outside the hunks); agent.mjs 1/7.

**Why it was not resolved here:**
- **Either side wholesale is an overwrite.**
  - e4f's files would drop route's snapshot reads, transactionClient and chain-reader API, which agent, host-onchain and host-identity call (they would break).
  - r7's files drop the root-qualified bound own backend, paid enrollment and selection shape.
- **Keeping both** is two transaction trust paths: an unbound TX_RPCS next to the bound TX_BACKEND.
- **A correct union is new code across 5 files**, and the two test suites assert contradictory shapes. Without running anything I cannot verify it, so I did not claim it.

**Proposed union, for review:**
- **One selection:** e4f's `chainAuthorityFromEnv` / `refusingChainAuthority`. **ENCLAVE_CHAIN_TX_RPCS is refused explicitly**, never silently ignored. **Transactions** go only through the bound own backend (actionGate).
- **Route's coherent snapshot reads** (`stateSnapshot`, verified `allDeployments`) are built on the SAME verifier URL. `transactionClient()` becomes the routed authority client, which refuses by name without a backend.
- **`chainAuthority()`:** one object with route's descriptor fields plus e4f's `.client/.transport/.actionGate`. The legacy value stays `provider-fallback` for route callers.
- **`chainAuthoritySelection()`** feeds e4f's `agentChain` (route's `agentChainAuthority` is retired). **`chain-reader.mjs`** is kept as an API, implemented with e4f's `verifierReader` over the authority client.
- **Tests:** route's TX_RPCS test cases must be rewritten to the TX_BACKEND rule (owner decision). Then run e4f's 12 tests + the 73 regressions + route's Windows tests + r7's stack/regression tests.

## Other open items
- **No runner was prepared for r8:** building it now would test a candidate without the qualified Windows authority, which is the staleness this step was meant to avoid. Once the core is composed, the r7 runner extends directly: the component inventory adds e4f's segment (aebf..e4f: test/windows-chain-authority-runtime.test.mjs) and the stack set adds e4f's 12 tests plus the paid/network regressions (test/relay-chain-consumers, relay-chain-authority, the paid-network tests).
- **The owner-CLI stage** is pending root's PASS/apply receipt and is not included.
- **Still not done:** image, SNP measurement, live work and push.
