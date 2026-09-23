# Site refresh 2026-09-23: claim-to-evidence record

Branch `site/architecture-positioning`. Every public claim the refreshed site makes that is not
self-evident from the running product, with the evidence it rests on and the status word it carries.
Status words: **available** (a deployment can have it now), **experimental** (built and measured on a
lab machine or one box), **planned** (designed or intended, not run). "Lab" means warden-host (AMD
EPYC 9115, SEV-SNP, `vmpl_count=4`) unless another machine is named.

| claim on the site | where | evidence | status | limits stated beside it |
|---|---|---|---|---|
| Compute that cannot see your data (hero) | index hero, README | SNP CVM on the hosted fleet: TLS in enclave, launch measurement in the signed report (`site/js/core/verify.js`, `supervisor.js` attestation endpoints); metal: `metal/README.md`, `metal/PROTOCOL.md` | available | scoped in the lede to confidential hardware; every other host labeled; physical memory-bus attacks out of scope (`docs/physical-tee-attacks.md`) |
| One package runs on the confidential Linux fleet and on a Windows host | index Portable card, ticker, develop ch.01 | `wasm/wasm_manager.py` (components only); Windows node runs market apps inside VTL1 via wasmtime-pulley (`windows/node/host.mjs:1187-1193`, commit 319ce155); live `/enclaves` row `apps.isolation:"vbs-enclave", inTee:true` on 2026-09-23 | available | Windows is interpreted, dev tier, owner not excluded |
| A versioned execution contract shared by every backend is in development | index Portable card, architecture #package | `isolation/contract/` (Go, `enclave-domain-abi/1`, `vectors.json`), `windows/vbslike/host/src/contract.rs`; both on main since merge b3496a8b | experimental | "nothing a deployment does today starts a domain through it"; no vector count published (no captured vector output in evidence files) |
| Protection level stated on every host listing | index, architecture #protection | fleet badges from evidence only: `site/js/core/pricing.js` `teeCpuOf`/`enclaveClassOf`; relay tier verdict (`row.tier`) wins over the box's self-report | available | unknown reads plain "cpu", never green |
| Confidential Linux: host OS and operator excluded, attested to the vendor root | index, architecture table | Tinfoil-measured image + SNP report, Sigstore provenance (`verify.js`); metal self-launched CVM with kernel/initrd/cmdline measured (`metal/build-image.mjs`, `metal/PROTOCOL.md`) | available | host can stop or starve; physical access out of scope |
| Confidential GPU: card walled off from host, attests to vendor service | architecture table | prior site copy retained; `worker/`, `mps-daemon/`, NVIDIA CC mode; README "How it works" | available | shares are software caps; MIG disabled under CC |
| Windows enclave node: owner's software excluded, owner not; no RAM encryption; traffic and TLS key on host side; test-signed | index Partitioned card, architecture #windows, host page | `isolation/DESIGN.md:39` (tier T2), `windows/PARITY.md:45-47, 58-70`, `windows/vbs/REPORT.md:12-26, 438-475`, `pricing.js:347`; live row 2026-09-23: `mode:"vbs"`, `tier:"vbs-dev"`, `claimEnabled` gated on apps-in-TEE, `fullService:false` | available, labeled dev tier | deployments created before listing are refused unless the owner chooses it (`windows/node/chain.mjs:402-434`) |
| Hyper-V partition per app on Windows, same guest image as Linux, 30 checks | architecture #windows, #protection | `windows/vbslike/README.md` (evidence/lab-2026-09-23.json, 30/30; image sha256 `30d8e344…` byte-identical; `tier=T0-hv`, `hostExcluded:false`, verdict `monitor-signed`) | experimental | not deployed; host inside the trust boundary; excluding the host needs a paravisor-backed isolated partition (open) |
| Native CreateEnclave is not the Windows roadmap | architecture #windows | user direction; `windows/vbslike/README.md` states the direction; the live node still uses the enclave API and is not described as abandoned | n/a | the live node is described as what it is |
| M1/M2: one app per SNP guest, app in launch measurement, VCEK-chained attestation, TLS key bound | architecture #isolation | `isolation/DESIGN.md` sections 8 and 11 (M1 12 checks; M2 run 3, 21 checks + 23 negatives) | experimental | TCB floors were test values from the box; no host-memory confidentiality measurement |
| M3a: several apps under a monitor, guest-kernel separation, labeled weaker | architecture #isolation | `isolation/m3/PLAN.md` (31 checks), `isolation/DESIGN.md:433` ("weaker than VMPL isolation, never equivalent") | experimental | |
| M3b: SVSM at VMPL0, monitor at VMPL2, VMPL0 refused, derived digest equals live report; digest does NOT cover the monitor image | architecture #isolation | commits f838fff3, 00f8c2b4; `isolation/DESIGN.md:482-490, 525-529`; `isolation/m3/PLAN.md:702-710, 843-851` | experimental, with the stated limit | the monitor's naming of apps is not authenticated on this path; not app-vs-app hardware isolation |
| M4a: one SNP guest per app via the contract, 13 checks twice, adversary's minted report rejected on measurement | architecture #isolation, index status card | commit 8651212b; `isolation/m4/PLAN.md` section 6; `isolation/m4/test-m4.sh`, `judge-adv.mjs` | experimental, **provisional** | "under independent review of its proof chain before we call this established" (user direction: pending audit); cost one guest per app; N4 does not apply to M4a |
| M4b: one plane per app, capped at 2 or 3 apps per guest | architecture #isolation | `isolation/m4/PLAN.md` section 2 (vmpl_count=4) | planned | density above that means one guest per app |
| Ordinary Linux hosts, one VM per app, no confidentiality claim | index, architecture table | `isolation/DESIGN.md` tier T0 ("must not claim confidentiality from the operator"); no such host in `/enclaves` | planned | "no such host is listed" |
| Shielded inference: engine exists, runs on one self-hosted confidential server, not on the fleet, no public numbers | architecture #shielded, README table | `shielded/worker-cuda/worker.cu`, `wasm/ggml-shielded/*`, `docs/shielded-inference.md:3` ("nothing on the fleet"), `shielded/REPORT.md` (numbers exist but are model/hardware/mode specific) | experimental | numbers deliberately omitted per user direction; only chat decode measured; the Windows node's `shielded` block runs the protocol on its integrated card (live row 2026-09-23) |
| Phone-anchored hosts and phone accelerators: earlier-stage research | architecture #shielded | `shielded/anchor/`, `relay/avf-verify.mjs` (mode "avf"), memory of the Pixel work | experimental | no numbers, no parity claim |
| Already independent: contracts, content-addressed bundles hash-checked in enclave, public source and measurements, self-launched CVMs, free self-hosting, keyless CLI/MCP | architecture #independent, index Independent card | `contracts/*.sol`, `wasm/ipfs_fetch.py:189-207`, `verify.js`, `metal/`, `supervisor.js:5049` (`selfHostFree`) + `contracts/DEPLOYMENTS.md:337` (rev 12), `relay/mcp.js:1-4` | available | |
| Still runs on company servers: api.enclave.host, traffic relays, site + IPFS gateway, certificate service, checkout, Tinfoil control plane, measurement allowlist | architecture #independent | `relay/api-relay.js`, `relay/relay.js`, `relay/tunnel.js`, `relay/certs.js`, `relay/billing.js`, `docs/autoscale.md`, `relay/api-relay.js:121-127` (`METAL_ALLOWED_MEASUREMENTS`, empty = token-only) | today | relays hold no TLS keys; gateway is availability only |
| Decentralization direction (publisher signatures, local trust policy, mirrors, interchangeable coordinators, independent recovery) | architecture #independent | user direction; no code | proposal | "The contracts and payment paths in use today are not being replaced by this page" |
| Permissionless host attach: code exists, admission by allowlist | host page, architecture status | `metal/PROTOCOL.md`, `metal/HANDOFF.md:18-19` ("OFF until you curate a measurement allowlist"), `relay/api-relay.js:121-127` | experimental | host page no longer says "anyone… no application" without the qualifier |
| Two independent pricing dials | index pricing | README "Resources" (ledger schema 13) | available | replaces the stale "GPU share must be at least CPU share" card |
| List rates vs per-host asks | index pricing | `site/js/core/live-prices.js` reads `EnclaveDeployments`; `cli/enclave.mjs` `--price-cpu/--price-gpu`; fleet rows carry per-pool prices | available | |
| Agents are first-class | index Who-it-is-for, footer | `relay/mcp.js` (unsigned transactions back to the caller), README "Coding agents" | available | |

## Stale copy removed or corrected

- "flagship NVIDIA GPU" hero framing, "Fortune 500", "no sales calls, no gatekeepers" as the story: replaced by the four pillars.
- "Anyone with a machine that has a hardware TEE can run an enclave… There is no application": qualified with the allowlist admission and the two kinds of host.
- "A GPU app's GPU share must be at least its CPU share": replaced (shares independent since ledger schema 13).
- Hero panel chrome "sev-snp + nvidia-cc": now "confidential vm · hosted fleet" (hardware names stay in proof sections).
- develop.html lede linked to the retired `/apps/deploy` console: now the store's Deploy button.
- README: "no engine code yet" for shielded inference (false since the CUDA/Vulkan workers and the ggml backend landed); repository table gains `isolation/` and `windows/`.

## Left as is, on purpose

- The attestation chain and live-verify components name AMD SEV-SNP, Intel TDX, NVIDIA and Tinfoil: they are proof surfaces, where PRODUCT.md permits specifics.
- The pricing section's example table and live price marks: the contract list rates are still what `live-prices.js` reads; a sentence now says hosts may post their own ask.
- develop.html chapter text about "wasmtime 45" and the WASIp3 snapshot: an engine-version claim this refresh did not verify against the running fleet; flagged below.

## Open factual questions for review

1. develop.html says the fleet's wasmtime is 45 for the WASIp3 snapshot; `wasm/Dockerfile.wasmtime` pins a 49 dev commit. Which does the fleet serve today?
2. The Windows node's tier is `vbs-dev` on the live row; if it is production-signed before this ships, drop "test-signed" and "development tier" from index, host and architecture.
3. M4a is described as provisional pending the proof-chain audit. When the audit closes, the architecture page's M4a item and the PRODUCT.md "not to be claimed" list need one edit each.
4. The hosted GPU fleet: at the time of writing `/enclaves` listed only the relay and the Windows node as attached. If no confidential GPU box is serving when this deploys, the pricing section still quotes GPU rates; consider whether the "Confidential GPU: available" row should read "available when a GPU host is serving".
5. `metal0` (the self-hosted confidential server) was off at the time of writing; "Self-hosted confidential servers: available" rests on the code path and the earlier live listing, not on a box serving today.
