# Composition r9: ONE Windows chain authority (consumer e4f507d6b + owner CLI b6ac5d657 + route's verified reads), prepared

Stage: `rpc-runtime-composition-stage/r9/` (SHA256SUMS `4b6948c89c4aa88f…`). Runner `jobs/r9-build-validate.sh` `6a44865f…`; R9-RESOLUTIONS.json `78940c67…`.
- **What ran here:** git reads, sha256, `node --check`, the static link and graph checks, and a dry evaluation of the new precheck lines. No tests, builds, queue, network, SSH, live work or upstream commits.
- **Preserved:** r8 and all earlier stages are frozen; the runner verifies r6, r7 and r8 are unchanged.

## Candidate: `refs/r9/candidate` **82ec7d455cc6e9957c1500f6e58ffde557093392** (tree 062c96ba)
- **Parents:** r8 partial 8fdf00d0 + **b6ac5d657** (which contains e4f507d6b). Both consumer commits are now fully composed, so recording the merge is correct.
- **Receipts:** checked and pinned in the message: e4f 70d39eaa… (85 PASS); owner CLI 3e4502a0… (43 PASS: chain.mjs stderr diagnostic, host-onchain.mjs, test).
- **Rebuild:** `tools/build-r9.py` reproduces it deterministically.

## The decision implemented
- **ONE selection:** `windows/node/chain-selection.mjs` (NEW, side-effect free). \`selectChainAuthority(env)\` = consumer \`chainAuthorityFromEnv\`/\`refusingChainAuthority\`, plus an **explicit refusal of the obsolete ENCLAVE_CHAIN_TX_RPCS in verifier mode** ("ENCLAVE_CHAIN_TX_RPCS is obsolete: … only to the bound own backend …"). It never throws. Legacy mode (no authority) is unchanged, and a stray TX_RPCS is not judged there.
- **ONE authority:** chain.mjs builds `CHAIN_AUTHORITY` once from that selection.
  - **Reads:** `publicClient()` and the operator wallet use its routed transport, so reads are proven by the verifier.
  - **Transactions:** the pending nonce, fee hints and sends go **only to ENCLAVE_CHAIN_TX_BACKEND**, bound by `actionGate`.
  - **send():** route's per-send permission re-check, **then** e4f's `actionGate`.
  - **Route's functions:** `transactionTransport()`/`transactionClient()` are now the same authority. The TX_RPCS transport is removed, and no second transport exists.
- **Route's coherent per-block reads, on the SAME validated endpoint:**
  - `stateSnapshot()` and the paged `allDeployments()` use `verifiedStateReader` on `selectedVerifier(process.env, CHAIN_AUTHORITY)`. That is the URL this selection validated, not a second parse.
  - **Under an INVALID selection,** `stateSnapshot()` is a snapshot that **refuses**, never `null` (which a caller would read as legacy).
- **API:**
  - `chainAuthority()` = **the live authority or null** (e4f/b6ac callers; there is no truthy legacy stand-in).
  - NEW `chainAuthorityStatus()` = a plain descriptor (`provider-fallback` | `local-verifier` {verifier, tier, transactions} | `refusing` {why}) for route's status callers.
  - `chainAuthoritySelection()`, `ownTxBackend()`, `connectivityProbeUrls()` and `rpcUrls()` as in e4f.
- **chain-reader.mjs:** route's API and its per-block LeaseReader behaviour are kept. Its selection is `selectedVerifier(env)` from chain-selection.mjs (validation only; it opens no authority client). There is no circular import: chain-selection imports only the lease-gas bundle and viem.

## Per-file rationale (every call site reconciled; R9-RESOLUTIONS.json has the blobs)
| file | result |
|---|---|
| windows/node/chain-selection.mjs | NEW: the single rule above |
| windows/node/chain.mjs | hunk 1 = the union block; publicClient/wallet = the authority transport (e4f); send = route re-check + e4f actionGate; route's tx functions are the same authority; stateSnapshot/allDeployments = route reads on the same endpoint; b6ac stderr diagnostic |
| windows/node/chain-reader.mjs | route API kept; selection = chain-selection.mjs |
| windows/node/host.mjs | e4f startup policy: verifierReader over the authority client; ENCLAVE_STARTUP_RPCS beside the verifier is refused |
| windows/node/network-enroll.mjs | e4f `agentChain` (selection shape, mixed config refused, invalid → no RPC) and its migration; route's `agentChainAuthority`/descriptor migration removed (one path) |
| windows/node/agent.mjs | enrollment gets `chainAuthoritySelection()` (e4f); status line from `chainAuthorityStatus()`; **an invalid selection stops the agent** (route's guarantee); e4f's egress-probe/paid code keeps its null-legacy semantics |
| windows/node/host-onchain.mjs | **b6ac exactly** (route's changes there were only its descriptor/TX_RPCS wiring) |
| windows/node/node-config.example.cmd | operator docs describe the bound backend; TX_RPCS documented as obsolete and refused |
| network/paid-network.mjs, network/enclave-network-host.mjs, network/privacy-agent.mjs, windows/node/host-identity.mjs | as reconciled in r8 (paid settlement under the verifier, contract-wallet `ownerSignatureReader`, verifierReader) |
| test/windows-chain-authority-runtime.test.mjs (e4f 12), test/windows-owner-cli.test.mjs (b6ac 8) | exactly as root-qualified |
| test/helpers/windows-chain-driver.mjs | `authority` op prints `chainAuthorityStatus()`; new `txPending` and `gate` ops |
| test/windows-chain-authority.test.mjs | route coverage kept and adapted (below) |
| windows/node/host-admission.bundle.mjs, metal/guest/host-policy.bundle.mjs | REGENERATE in the job |

**Static checks on r9:**
- every changed JS file parses;
- bundle-entry links: 21 imports, 0 broken;
- link-check: nothing beyond the head baseline (the stale committed bundle bytes are re-checked after regeneration);
- the consumer tests' stderr/exit expectations match: `[chain] authority: local verifier … (unsafe tier, no L1 finality)` on stderr, the legacy line absent, the owner CLI's INVALID → exit 2.

## Route test adaptation (INTENTIONAL API CHANGE markers in the file; no substantive coverage deleted)
- **The TX_RPCS case becomes two cases:**
  - **(a) Verifier + own backend:** pool work goes to the backend; plain nonce and history go to the verifier; **no eth_sendRawTransaction reaches the unbound backend or the verifier** (the gate refuses); BASE_RPCS gets 0 requests.
  - **(b) Obsolete ENCLAVE_CHAIN_TX_RPCS:** the status is `refusing` with "ENCLAVE_CHAIN_TX_RPCS is obsolete"; reads, pool and gate all refuse; **0 requests to the TX list, BASE_RPCS or the verifier**.
- **"No explicit transport" case:** stateTx, txNonce and txLogs refuse (the verifier stand-in). txPending refuses with "pending pool is only known to an own transaction backend (ENCLAVE_CHAIN_TX_BACKEND unset)"; the gate refuses; nothing is submitted.
- **Invalid selections:** a refusing authority with the exact why (no longer a load-time throw), every read refuses, and **the agent still exits** with `INVALID … local endpoint|loopback`.
- **chain-reader:** all assertions kept, plus the TX_RPCS refusal for `chainAuthorityOf` and `chainReader`.
- **Enrollment:** selection shape; remote and **mixed** configs are refused.
- **Packaging:** chain-selection.mjs ships in the closure.

## Root job (shared queue 2560, offline)
    ./jobs/q-exit-status.sh rpc-runtime-composition-r9-1 2560 unshare -rn bash rpc-runtime-composition-stage/r9/jobs/r9-build-validate.sh [--precheck-only]
- **Base:** r7's runner (every gate: deps identity, exact paths, manifests, vendors, guest-verify exports, link gates, native inputs with no skip, closure identity, tri-state).
- **New in r9:**
  - the candidate's identity and both parents; the R9 pin; both receipts;
  - the **owner-CLI component** (aebf..b6ac: test/windows-chain-authority-runtime.test.mjs, test/windows-owner-cli.test.mjs), each against the consumer tree;
  - **E2 regressions:** REGRESSIONS.txt, 104 tests touching chain/paid/network-enroll/privacy-agent/owner-signature/session/egress/verified-read/chain-authority. Each runs against its baseline head (owner-CLI, else route, else none); a regression is FAIL, and a baseline that is not clean is INCOMPLETE;
  - INTENTIONAL-CHANGES.txt marks route's adapted test as ADAPTED. **Both the route-head version and the candidate version must pass**; this is never a silent waiver;
  - the recomputed DEPGRAPH.json: new edges windows-lease-runtime → network-runtime and → mcp (through chain-selection's lease-gas import). The executed order already satisfies them, and the guard enforces it.

## Remaining limits (named precisely)
- **Untested here:** none of the new code (chain-selection.mjs, the chain.mjs union, the adapted test and driver ops) has been executed. The root job is its first run.
- **Message-text matches:** the "remote verifier" message is matched as `local endpoint|loopback`, because its exact text comes from verified-chain.mjs. The no-backend `gate` assertion checks refusal plus no send, not the exact wording.
- **Stale comments:** `network/verified-read-client.mjs` keeps its `transactionRpcsFromEnv` export and comments (a shared module; unused by the Windows node now). Remove it in a follow-up if no other consumer exists.
- **Not done:** image, SNP measurement, live work and push.
