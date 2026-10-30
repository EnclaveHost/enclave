# Production cutover: current plan and missing steps (prepared only; all activation flags false; no wallet request)

Stage: `production-cutover-current-plan-stage/` (SHA256SUMS `a6e7f645c406749d…`). Read-only canaries plus one private scratch composition. Nothing was run, queued, deployed or committed upstream.

## Exact source refs now
| part | ref | state |
|---|---|---|
| consumers | `fix/rpc-relay-consumers-20261025` **12b41d459** (credit page read authority) on **b6ac5d657** (owner CLI) on e4f507d6b | root PASS: 0228 (12/12), 0230 (both credit bundle modes), 0232 applied; b6ac 43 PASS; e4f 85 PASS |
| verifier | **2b8894a37** (Helios 8250f08a, portable recipe) | source; no new image or measurement |
| lease relay | **433f04fa1** | source; live release 94f4ebdf… not matched to it |
| route | **b3fde1812** | source |
| composition | private **82ec7d45** (r9) | root job r9-0237 RUNNING, failures below |
| composition + credit | scratch **bd9dc740** = 82ec + 12b41d459 | **clean merge** (3 of the 4 files untouched in 82ec, plus its new test); untested |
| launcher | `fix/rpc-production-bootstrap-20261025` 28ce278d5 (ops/rpc-launcher-handshake-validated-20261026) | r3 tests 34+27 PASS (0202), guest canary ok (0204); `LAUNCH_PRODUCER_REVIEWED`/`FINALITY_PROOF_REVIEWED` **False** |

## r9 (root-composition-r9-0237, still running): real failures only
1. **`build-custody-vendor --check` stale:** `site/vendor/custody.js` (check-only) no longer matches the composed custody sources. **This is a real gap.** It must be regenerated, or its sources pinned, by a root decision.
2. **A new generated path, `network/host-services/packages/public-rpc.mjs`:** route's new host-service role. My exact allowlist (GENERATED.txt) omitted it. Fix: add it (and its package manifest) to the allowlist. The output itself is expected.
3. **"manifest still stale" for mcp-server and platform-api: a false positive in my static tool**, not stale output.
   - **Symlinks:** `relay/net-guard.mjs`, `vbs-runtime.mjs` and `shield-derive.mjs` are committed **symlinks**, and the tool hashed the link text.
   - **Image paths:** `opt/…` and `fixtures/…` are runtimeFiles **image paths**, not tree paths.
   - **Fix:** follow symlinks in-tree and map runtimeFiles through their `source`.
4. **Baselines not clean (identical at the component heads; INCOMPLETE, not regressions):**
   - dns-relay smoke (component trees do not get the generated network-runtime bundle);
   - native-relay-chain-authority (1 fail at both);
   - storage-front-binding-release (5 fails at both);
   - lease-relay-host-policy (3 skips at both).

No REGRESSION has been seen so far. The remaining phases (stack, native, regressions) have not printed yet.

## Roles: kept separate (one host may run several; none substitutes for another)
| role | what it is | must NOT be |
|---|---|---|
| **own chain backend** | the Base node (`enclave-base-holder`, launched ONLY through the guarded wrapper `chain_service.py` 07276ec8 + `60-base-launch-handshake.conf`); proof source and `ENCLAVE_CHAIN_TX_BACKEND` (loopback / private IPv4) | a direct `ExecStart` drop-in (rejected v1); a trust root by itself |
| **local verifier** | Helios rpc-runtime per host (pinned 8250f08a, unsafe tier), proofs from the own backend | a sender; a finality source |
| **measured proof-serving role** | the attested verifier guest (SNP) for remote consumers | qualified before a fresh image measurement + hardware canary |
| **browser trusted transport** | the site's `own-rpc` read-authority file (≥2 own origins, `trust: self-hosted-transport`) | a proof; a public pool fallback |
| **lease sender** | lease relay / configured lease sender; submits to the own backend after `actionGate` binding | "ready" because a pool accepted a transaction |

**Not counted as ready:** a tx-pool acceptance, an unsafe gossip head, an `eth_blockNumber` answer, or a manifest boolean. **Ready** = the readiness sampler (readiness-stage) passing against the own backend with proof-backed reads at a fresh verified block, plus each consumer's egress canary passing.

## Circular bootstrap dependencies and the offline path
- **Verifier ↔ host admission.** Host-service admission reads the chain through the verifier, so **the verifier is never an admitted host-service role**. It starts from the own backend and gossip only (as rpc-runtime documents).
- **Lease renewal → sender → verifier/backend.** If the verifier or backend is down, renewals refuse (they never fall back to public RPCs), and apps run until lease expiry.
  - **Recovery:** the retained legacy config (`chainAuthority` unset), applied as an **explicit operator config change**. The previous release and config stay on each host until the canary passes.
- **Directory → providers → route DNS.** The providers bootstrap from the directory, and the directory reads leases through its own host-local verifier. Directory hosts must therefore cut over only after their local verifier is serving. Route DNS follows the provider and reads no RPC.
- **Custodian v1 → app boot.** Apps get secrets from custodians at boot, so a custodian cut over before its verifier serves blocks app boot. Do custodian1 first, alone, with the legacy config retained.
- **Browser own-rpc origins** are served by admitted hosts, whose admission uses the local verifier, never the site transport. There is no cycle, provided admission never reads through the browser origins.
- **Offline/recovery:** the guarded launcher, the producer and the coverage gate are offline, root-only and pinned. A Base restart never needs the verifier or any consumer.

## Deployment order (each step only after the previous step's gate; activation flags flipped by root only)
| # | step | reuse (exact) | gate / canary |
|---|---|---|---|
| 0 | Base sync complete, then readiness | readiness-stage sampler (root probe `readiness-root-probe.py`); coverage gate `coverage-activation-stage/coverage-activation.patch` 4a1e6e80 (r3) | sampler PASS on the own backend (not the unsafe head); coverage verdict COVERED |
| 1 | own chain backend via the guarded launcher | base-launch-producer-stage/r3 (MANIFEST a41d2182; wrapper 07276ec8; producer 7e8d295d; drop-in 60-…) | root flips the REVIEWED flags only after `produce` validates A1–A4 + bytecode; the guest canary (0204 pattern) |
| 2 | local verifier per host | rpc-runtime (canonical-integration-actual: Helios 8250f08a) **after** the host-verifier package rebuild (MISSING) | a verifier probe on loopback; `public-rpc-egress-observe.sh` on the runtime unit = 0 |
| 3 | lease relay (sender) | lease-consumer-cutover-prepared (74c34bb9) C3; lease-relay-source 433f04fa1 release (MISSING: a matched release) | egress canary 0; a renewal **receipt** verified (not pool acceptance) |
| 4 | directory ×4 | consumer-cutover-remaining-20261026 (187417ea) §3 directory config | egress canary 0 per region |
| 5 | providers ×4 (fix the ca-east drift first) | consumer-cutover-plan-2205 (659beebd) candidates | egress canary 0; route DNS unchanged |
| 6 | **custodian1**, then the others | remaining §3 `CUSTODY_CHAIN_SOURCE=verifier` | egress canary 0; a v1 release succeeds; **v2 stays REFUSED** |
| 7 | Metal0 control + privacy agent | 2205 candidates (releases with the verifier fields: MISSING) | egress canary 0; admin controls unchanged (measured-control members) |
| 8 | Windows node (minipc) | env `ENCLAVE_CHAIN_AUTHORITY=verifier`, `ENCLAVE_CHAIN_VERIFIER`, `ENCLAVE_CHAIN_TX_BACKEND` (node-config.local.cmd); owner CLI from b6ac | `windows-public-rpc-egress-observe.ps1` = 0; owner-CLI `status` JSON |
| 9 | site / credit / dashboard | own-rpc read-authority file (remaining §3) + credit 12b41d459 | `static-public-rpc-scan.sh` on the build = clean |
| 10 | measured proof-serving role, then remote consumers | the attested image stage, with a NEW image | fresh measurement + hardware canary + live backend gates |
| — | standalone/guest MCP | **HOLD** (no viable cutover: needs a proof-source route + a new measurement) | — |

## Missing steps (actual)
1. **Base sync.** The last live observation is about 23% (2205, 22:05Z); no newer progress was found. It blocks steps 1–10.
2. **r9 fixes:** the custody vendor decision, adding public-rpc.mjs to the allowlist, and the staleness tool's symlink/runtimeFiles handling. Then compose credit (scratch bd9dc740) and rerun once.
3. **Host-verifier package rebuild** from the accepted composition (Helios 8250f08a pin) and a **new attested image + measurement**. Not done.
4. **Releases** that accept the verifier fields for: the privacy agent (live relay-free-0b326889), Metal0 control (metal-deabf8f90), lease relay (live 94f4ebdf, unmatched), providers (464cad3 / ca-east drift), directory (37366ab), custodians, the checker. **API relay: not located live.** **Windows node processes: not enumerated.**
5. **Own RPC origins** (≥2) for the browser read-authority file: none named yet.
6. **Activation flags:** `LAUNCH_PRODUCER_REVIEWED`, `FINALITY_PROOF_REVIEWED`, `coverageVerified`, `productionActivated` and the host-verifier `activated` all stay **false**.
7. **Wallets:** no wallet or transaction request until a concrete transaction exists (step 3's renewal is the first).
