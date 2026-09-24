# Site refresh 2026-09-23: claim-to-evidence record

Branch `site/architecture-positioning`. This is the review record for the public copy and for the
admission code that the copy depends on. It is an engineering document: the public site itself
carries no readiness taxonomy (no available / experimental / planned labels, no status board), by
the owner's direction; present and future are told apart by tense, and the dated note at
Develop > Architecture > "Engineering progress and evidence" is the one public place that records
what has been demonstrated.

## How current-vs-future truth is communicated after the rewrite

- **Tense.** "Is" and "runs" describe what a deployment gets today (confidential hosts, the
  bundle on the catalog, client-side verification). "We are building", "the architecture is",
  "hosts must prove", "is being brought under" describe the target. The hero, the four cards and
  the contract section are written this way and never say a future capability is live.
- **One contract, two ways to meet it.** Protection levels are OS-neutral sets of guarantees:
  the isolation contract (per-app hardware isolation, ordinary host OS excluded by a smaller
  measured trusted layer, measured identity, attestation, key and traffic binding, fail-closed
  verification, lifecycle cleanup, portable operation) and confidential hardware, which is the
  same contract plus memory encryption and protection from the machine's operator. The copy
  says plainly that every host listed today is confidential hardware and that no host is listed
  at the base level until a backend passes the common acceptance tests.
- **Operating systems appear only as implementation detail.** "Equivalent VBS-style
  implementations on supported Windows and Linux hosts" is the only place the names appear in
  market copy; no level, badge or card is named after an OS.
- **Partial evidence is not a level.** A machine that meets part of the contract (test-signed
  trusted layer, key or traffic on the host side, launcher-signed report, host-readable memory)
  is described as implementation evidence, is not presented as available, and is refused tenant
  work by the relay and by its own claim gate.
- **The evidence note.** Develop > Architecture > `#progress` lists, dated, what is in
  production, what runs in the lab, and what is design, including the per-app isolation
  milestones, the consumer machine's gaps, shielded inference, and the pVM CPU tier. Milestone
  names (M1 to M4b) appear only there and in repository docs.
- **The live panel is the authority on "now".** The fleet panel (Develop > Architecture
  `#fleet`, Host page) shows what is attached, with evidence badges, and the copy points to it
  wherever availability could be misread.

## Claims and their evidence

| claim on the site | where | evidence | limits stated beside it |
|---|---|---|---|
| Compute that cannot see your data | hero, README | SNP confidential VMs on the hosted fleet: TLS in enclave, launch measurement in the signed report (`site/js/core/verify.js`, `supervisor.js`); self-launched servers: `metal/README.md`, `metal/PROTOCOL.md` | the lede says what it means today (host OS excluded, identity measured, keys and traffic bound, verified before a byte) and adds the operator only "on confidential hardware"; physical memory-bus attacks out of scope (`docs/physical-tee-attacks.md`) |
| One app bundle runs on the confidential fleet today | Portable card, architecture #package | `wasm/wasm_manager.py` (components only), the on-chain catalog, CID hash-check in the enclave (`wasm/ipfs_fetch.py:189-207`) | "the shared domain contract is being brought under every backend" (future tense) |
| One versioned domain contract, `enclave-domain-abi/1` | architecture #package, #contract | `isolation/contract/` (Go, `vectors.json`), `windows/vbslike/host/src/contract.rs` (Rust mirror), both on main | "today the fleet's runtime still starts apps directly" |
| The isolation contract, eight properties, OS-independent | index #protection, architecture #contract | owner's controlling requirement (2026-09-23); `isolation/DESIGN.md` (the T2 VBS row and the T0+ proposal row are the two backends' shapes); `isolation/contract/README.md` (bundle, report binding, lifecycle) | "we are building equivalent VBS-style implementations on supported Windows and Linux hosts ... a machine is listed only when it passes" |
| Confidential hardware = the contract plus memory encryption and operator exclusion; every host listed today | index #protection, architecture #levels | SEV-SNP CVMs; Tinfoil-measured images + Sigstore provenance; NVIDIA CC on GPU hosts | "between apps on one such host, separation is a sandbox and a process while per-app hardware domains are brought to this backend"; no GPU host or self-hosted server attached at the time of writing (`/enclaves` 2026-09-23) |
| No host is listed at the base level; partial evidence is not a level for sale | index callout, architecture #levels, host page | owner's requirement; the attached consumer node: verified VBS enclave report (`windows/vbs/REPORT.md`, `relay/vbs-verify.mjs`) but test-signed (`tier: vbs-dev` on the live row), app-zone TLS key and traffic on the host side (`windows/PARITY.md:45-70`), no RAM encryption (`isolation/DESIGN.md:39`) | enforced in code: `relay/api-relay.js computeEligible` (tunnel mode "vbs" not eligible), `windows/node/host.mjs meetsIsolationContract` (false by construction today) |
| There is no lower level; ordinary virtualization with the host OS in charge is a lab control | index callout, architecture #levels, host page, PRODUCT.md, README | owner's requirement; `isolation/DESIGN.md` tier T0 is the research's own baseline run; enforced by `metal/guest/gsup.mjs SELLING` (MODE=dev never sells) and `supervisor.js teeOk` (no confidential CPU in the RAD, no claim) | |
| Per-app hardware isolation research: what is demonstrated | architecture #progress | M1/M2 (`isolation/DESIGN.md` sections 8, 11), M3a/M3b (`isolation/m3/PLAN.md`; correction 00f8c2b4: IGVM digest covers SVSM + firmware, not the monitor), M4a (8651212b, 773a7450: adversary's fully signed, correctly bound report rejected on measurement; independent recheck 14 PASS / 0 FAIL), M4b in progress (`isolation/m4/PLAN.md` section 2: 2 to 3 apps per guest) | "nothing in the product starts a domain this way yet"; "the run of the same image on ordinary virtualization is a control, not a level" |
| The consumer machine and the partition lab build | architecture #progress | `windows/vbs/REPORT.md`, `windows/PARITY.md`, `windows/vbslike/README.md` (30 lab checks; `hostExcluded:false`; launcher-signed) | "does not meet the contract and takes no tenant work"; "lab evidence only" |
| Linux VBS-equivalent is a design | architecture #contract, #progress | `isolation/DESIGN.md` T0+ row ("proposal only"; nothing upstream on x86) | |
| Shielded inference | architecture #shielded, #progress, README table | `shielded/worker-cuda/worker.cu`, `wasm/ggml-shielded/*`, `docs/shielded-inference.md:3` ("nothing on the fleet"); the live consumer row's `shielded` block | no numbers published; only chat decode measured |
| The pVM CPU tier (amber "pvm cpu") | architecture #pvm-cpu, #progress, fleet badge | owner's direction 2026-09-23; pVM session (enclave-53): TPU closed at 3d7b64de (2.4 to 2.6 tok/s measured against a 15 tok/s floor); `relay/avf-verify.mjs` verifies the protected-VM chain at attach; `relay/pvm-cpu-tier.mjs` (785ef92a) judges the signed capability report; hub wiring on this branch (`relay/tunnel.js` caps frame, `relay/api-relay.js inferenceLaneOf`) | future tense; no Pixel 11 runtime validation or availability claimed; "there is no accelerator tier"; a phone row is never sellable app capacity (`computeEligibleOf`); the badge is amber only when the HUB tiered the row, a verified-but-unreported phone reads plain "pvm" |
| Verification chain | index #attest, architecture #verify | `site/js/core/verify.js` (same-origin verifier, Sigstore), `supervisor.js` attestation endpoints, `metal/` reproducible image | the API self-check is a labeled diagnostic |
| Independent infrastructure: what is on public contracts vs on company servers | architecture #independent | contracts, `wasm/ipfs_fetch.py`, `relay/api-relay.js`, `relay/relay.js`, `relay/tunnel.js`, `relay/certs.js`, `relay/billing.js`, `docs/autoscale.md`, `METAL_ALLOWED_MEASUREMENTS` (api-relay.js:121-127) | the decentralization direction is "proposals under discussion"; existing payments and contracts are not replaced |
| Live wasmtime and WASIp3 pin advice | develop guide | `wasm/Dockerfile.wasm:18` pins the toolchain build of wasmtime commit `ac077297` (repinned 2026-09-14), workspace `Cargo.toml` 49.0.0, WASIp3 WIT `wasi:http@0.3.0` final; crates.io: wasip3 0.7.0+ target `+wasi-0.3.0`, 0.6.0 targets the March rc | residual: the chapter's Rust sample was not recompiled against 0.7 |
| Two independent pricing dials; list rates vs per-host asks | index pricing | README "Resources" (ledger schema 13), `live-prices.js`, `cli/enclave.mjs --price-cpu/--price-gpu` | "a GPU share can only be bought while a GPU host is attached" |

## Admission, fleet display and routing: the audit and the fixes

Rule: tenant compute is offered to, routed to, or claimed by a machine only on hardware evidence
for the contract it would be sold under, derived from what the relay verified, never from OS
identity, a self-reported tier string, or the machine's own `claimEnabled`. Today only a
confidential CPU proves that contract. Verified evidence for a different contract (a phone's
protected-VM chain, a VBS enclave report) is real evidence and still not eligibility.

| gap found | fix | test |
|---|---|---|
| `relay/tunnel.js` hello handler let a box set its own attach mode (`t.mode = f.mode || t.mode`): a token-attached box saying `mode:"snp"` read downstream as relay-verified | the hello's mode is recorded as `t.declaredMode` only; `t.mode` is set by `bind()` alone | `test/tunnel.test.mjs`: token attach stays `""` through hello `snp/avf/vbs/tdx`; a verified `avf` attach cannot relabel itself `snp`; `test/tenant-compute-eligibility.test.mjs` pins it in source |
| `relay/api-relay.js servingEnclaves()` keyed on the box's own `claimEnabled`; `/enclaves` totals, `pick()`, `sticky()` and `/v1/claim-hint` fan-out all inherited it | `computeEligible(e)`: tunnel rows only in hub-verified mode `snp`; dialed rows only with `teeCpu` in {amd-sev-snp, intel-tdx}; `servingEnclaves` ANDs it in; `/enclaves` rows carry `eligible` and an `ineligible` reason | `test/api-relay.test.mjs`: dev / old / VBS-evidence boxes listed, not serving, not counted, not hinted; `test/fleet-partial-capability.test.mjs`: partial capability is not weaker evidence; a VBS-evidence box is never the fleet's fallback |
| `supervisor.js` claimed with no TEE term (`CLAIM_READY` = config + registry + backend) | `teeOk()` from `vmTech()` (detected from the box's own RAD, never config) gates `claimEnabled`, the claim-hint endpoint, and `considerClaim` | pinned in source (`test/tenant-compute-eligibility.test.mjs`) |
| `metal/guest/gsup.mjs SELLING` ignored `MODE`: a plain-KVM dev launch with a registry key registered and claimed | `SELLING` requires `MODE !== 'dev'`, with a logged refusal | pinned in source |
| `site/js/core/pricing.js teeCpuOf` believed a tunnel row's own `teeCpu`; `rankEnclavesFor` / `pickEnclaveFor` / `moveBlockReason` had no evidence filter | tunnel rows are judged by `row.mode` only (a self-report reads `unverified`); `computeEligibleOf(row)` (relay `eligible` verdict first, else confidential evidence) filters all three | `test/tenant-compute-eligibility.test.mjs`; `test/pricing.test.mjs` fixtures carry evidence by default and the missing-evidence cases say `teeCpu: null` |
| `site/components/fleet-list/fleet-list.js` drew pools and a price for any row that said it claims | `sells` requires `computeEligibleOf`; an ineligible row renders as attached with the relay's reason and no capacity; an unverified self-report wears an amber "unverified cpu" badge; a phone row wears the amber "pvm cpu" badge | rendered in the browser pass |
| `windows/node/host.mjs` claimed on `appsInTee()` alone; `teeCpu` hardcoded; the relay's tier never consulted | `meetsIsolationContract()` = apps in the enclave AND app traffic inside the enclave (false by construction today) AND relay-verified tier `vbs`; gates `scope()` (market vs owner-only) and `claimEnabled`; `agent.mjs` hands `relayTier` to the host; `/availability` reports `isolationContract` and `contractGap` | pinned in source (`test/tenant-compute-eligibility.test.mjs`); `test/windows-node-claim-policy.test.mjs` unchanged and green |

Remaining gaps, stated rather than closed:

1. **Dialed (first-party) rows are still self-reported.** The relay trusts `availability.teeCpu`
   from a measured image run by an allowlisted operator and does not re-verify the quote; clients
   verify at connect. Re-verifying the Tinfoil RAD relay-side is the next step.
2. **On chain, any registered operator can claim** (`EnclaveRegistry.register` has no modifier,
   `EnclaveDeployments.claim` checks operator and price only; `claimBond6 = 0`). The runner-side
   and relay-side gates above are software; a modified runner bypasses them and is caught only by
   clients verifying attestation. An attestation-bound registration or a bond is a contract change.
3. **The live consumer node** runs code that predates `meetsIsolationContract`; until it is
   redeployed, the relay-side rule (mode `vbs` not eligible) is what keeps it out of the serving
   set. Its owner-only scope keeps working either way.
4. **The develop guide's WASIp3 Rust sample** was not recompiled against the wasip3 0.7 line.
5. **The pVM CPU tier's admission is wired but nothing is admitted yet.** The pVM session's verifier
   (`relay/pvm-cpu-tier.mjs`, 785ef92a) is called by the hub on one `{t:"caps", report, sig}` frame
   per AVF attach (`relay/tunnel.js`); an eligible verdict sets the hub-owned tier `pvm-cpu`, the
   relay exposes it as `lane: "pvm-cpu"` (an inference lane, never app-compute eligibility), and the
   fleet panel shows the amber `pvm cpu` badge only for hub-tiered rows. The VM does not emit the
   caps frame yet, and no relay carries a `PVM_CPU_*` policy yet, so every report is refused by the
   verifier's first rule. The pvm-cpu build attaches on the v2 (pad-binding) transcript because its
   VM mints a pad key, so the hub admits a v2 attach on a `PVM_CPU_CODE_HASHES` code hash for
   ROUTING ONLY: unless that hash is also an admitted pad build, the pad key is not retained, the
   pads ledger never lists the phone as a consumer and never issues it a seed, and a build in
   neither list is refused. Tested in `test/tunnel.test.mjs` (admit / bad signature / foreign nonce
   / no policy / token box; v2 routing-only vs a pad build vs a stranger, through the real pads
   ledger) and `test/tenant-compute-eligibility.test.mjs`. Two pre-existing failures in
   `test/pad-ack-receiver.test.mjs` and `test/pad-seed-open.test.mjs` (native C compile errors) fail
   identically on main and do not involve the hub.
