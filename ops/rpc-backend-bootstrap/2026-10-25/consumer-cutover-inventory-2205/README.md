# Consumer cutover refresh: FINAL (2026-10-25, live reads 22:05–22:20 UTC)

**Scope:** preparation only.
- **Gates:** the Base snapshot is at about 23%, and the own L1 proof passed. Base, A2–A4, SNP and readiness gates are
  **not** passed.
- **Not done:** no service, config, app or contract change, no signing, deploy, test, queue use or commit.
- **Live reads:** read-only, through the existing SSH aliases with strict host keys. They extracted public fields only:
  secret-named keys are redacted, and URLs are reduced to hosts.
- **Artifacts:** `consumer-cutover-plan-2205/`, with the observed state in `observed/` and the deltas in `candidates/`.

## 1. Evidence: what is actually running now (live, not source examples)

| Consumer | Where / release (observed) | Chain RPC now (observed) | Cutover-capable release running? |
|---|---|---|---|
| Privacy agent | Metal0, `relay-free-0b326889/privacy-agent.mjs`, config `metal0/config.json` (unchanged since 2026-10-24) | `chain.rpc` publicnode, drpc, mainnet.base.org; addressBook `0xab21…0907`; four authority pins | **No.** 0 `chainAuthority` occurrences in the running bundle |
| Metal0 control | `metal-deabf8f90`, config `metal/config.json` (unchanged since 2026-10-23) | `leaseGas.rpcs` publicnode, mainnet.base.org, blastapi, quorum 2; no `chainVerifier` | **No.** 0 `chainVerifier` occurrences |
| Lease relay | eu-central `enclave-lease-relay` active, release `94f4ebdf…` | `LEASE_RELAY_RPCS` same three hosts, quorum 2; no verifier | unknown: release not matched to `lease-relay-source` `433f04fa1` |
| Regional provider ×4 | eu-central/us-west/ap-southeast `native-recovery-464cad3`; **ca-east `hs-transport-39d1513b` + `.hs-a1` config (drift)** | `rpc` mainnet.base.org, publicnode, drpc; same address book and pins | **No** attested authority in either release |
| Public directory ×4 | `runtime-37366ab`, `config-f6959cb.json` | same three hosts | verifier seam not audited |
| Legacy v1 custodian ×4 | `custodian.mjs` | `CUSTODY_RPCS` mainnet.base.org, publicnode, drpc, 1rpc.io; MIN_AGREE 2 | no seam (needs SRC, K3) |
| Custodian v2 (Metal0) | `custodian-v2-9d43e63e8` | `rpc` mainnet.base.org, plus the measured RPC list | no (needs SRC, a new measurement and admission: K1/K2) |
| Network checker (Metal0) | `nan-retirement-2d848c8/wg-qualify.mjs` | a single `--rpc base-rpc.publicnode.com` | no seam (needs SRC) |
| Route DNS ×4 | `caa-e8fe12132621/dns.mjs` | **none:** `DNS_READ_ONLY=1`, route map from loopback provider `:8188` | not a direct RPC consumer; it follows the provider |
| Bootstrap gateway ×4 | `enclave-retained/cc96aad` | no RPC fields in config (code defaults not audited) | unknown |
| API relay (`api.enclave.host`) | **not located.** The reviewed units `enclave-api-relay`/`enclave-dns` are installed on `nan` but **inactive**, and absent on the four regional hosts | unknown | `relay-consumer-source` `ab371cbc2` has R1–R8 on the verifier (partial: writer fencing not provided) |
| Windows (`minipc`) | `EnclaveDNS` running; scheduled task `enclave-host-services-hs2` Ready; node processes not enumerated (query error) | unknown | unknown |
| Site, mobile, dashboard | not inventoried live; source constants only (audit S1) | public pool in the site bundle | needs SRC and a release |

**Drift against the 12:08 inventory:**
- The running agent is `relay-free-0b326889`, not the `release-808f691d0` label.
- `enclave-wg` runs from `release-2e8e7e3d7`.
- ca-east runs a different provider release from the other three regions.
- Lease relay, Metal0 control and agent configs are byte-unchanged.

**Public RPC hosts in actual use:** `base-rpc.publicnode.com`, `base.drpc.org`, `mainnet.base.org`,
`base-mainnet.public.blastapi.io` and `1rpc.io`.

## 2. Blockers root can act on while the download runs

1. **Releases first, config second.** Neither the running agent nor the running control can accept the verifier fields.
   - Pick and stage the reviewed releases: an agent from the route lineage, and the relay-mode control
     `dist-rpc-ec56a70f1`.
   - Applying C1 or C2 to the current binaries is **not** a cutover, and the field could be silently ignored.
2. **Lease relay placement.** eu-central has neither a local verifier nor a private path to the own Base node, which is
   loopback-only on the RPC host.
   - **Decide:** relocate the relay next to the RPC host (this also changes Metal0 `leaseGas.relays`), or add a reviewed
     private transport.
   - **Also confirm:** the root-review 10-second socket-timeout finding is fixed in `433f04fa1`.
3. **No proof source route for the in-guest control verifier.** C2's `proofSources` names the `rpc-<b32>` role, which
   is not live. It needs a reviewed URL; never a third-party one.
4. **Host-local verifier runtime** (`route-stage/examples/host-rpc-runtime.metal0.json`, port 28590, own node on
   loopback). Prepare its unit now; it can only start serving after Base sync.
   - It is an **unmeasured local helper**.
   - The regional providers' `attested-verifier` mode needs a **deployed SNP-measured replica**, which does not exist;
     only the hardware canary passed. Never label the helper as attested.
5. **Locate the live API relay.** The documented units are inactive on `nan`. R1–R8 cannot be planned against an unknown
   deployment.
6. **SRC-only consumers stay on public RPC after any config cutover:** legacy custodian ×4, custodian v2, the network
   checker, the site/mobile pool, and possibly the public directory. Plan them separately; do not call the cutover
   complete without them.

## 3. Candidates (`consumer-cutover-plan-2205/candidates/`, non-secret, each with preconditions)

| File | Target (observed file) | Basis |
|---|---|---|
| `C1-metal0-privacy-agent.chain.merge-patch.json` | `metal0/config.json` | **observed** config. Removes `chain.rpc`; adds `chainAuthority: verifier` and `chainVerifier: 127.0.0.1:28590`; everything else unchanged |
| `C2-metal0-control.chainVerifier.merge-patch.json` | `metal/config.json` | **source-only** staged example. Proof source left as `<MERGE>`; `leaseGas` untouched |
| `C3-lease-relay.env.delta` | eu-central `relay.env` | **observed** env and the `433f04fa1` field names. Removes the provider quorum, adds the verifier and own backend; placement-blocked |
| `C4-regional-provider.attested-verifier.TEMPLATE.json` | four provider configs | **template**, not derived from any deployment (no attested replica exists) |

Secret or local values are named as `<MERGE: …>` and must be merged locally. No original secret was read into these
files.

## 4. Order, rollback and proof of no silent public fallback (plan; NOT executed)

**Cutover order** (each step only after Base sync, A2–A4 release, readiness READY, and its release staged):
1. host-local verifier;
2. **C1** (agent, read-only lease reads: lowest risk);
3. **C2** (control, guest relaunch);
4. **C3** (lease relay, after the placement decision);
5. **C4** (providers, after a deployed attested replica).

Administrator controls, the 10 app deployments, pins, the address book and payout are untouched by every candidate.

**Rollback (reverse order, one consumer at a time):**
1. Before each step, save the exact live file (sha256 recorded) and the release symlink.
2. To roll back, restore that file and the previous release, then restart only that unit or guest.
3. Verify against the saved sha that the consumer is back on its observed provider set.

Never roll back by adding public hosts beside a verifier: mixed configs are refused by design.

**No silent fallback, per path:**
- **Existing tests (re-run before release; not re-run by me):**
  - `lease-reader` `chainAuthorityOptions` refusals;
  - lease relay E2E (`REQUIRE_VERIFIER_E2E=1`, mixed-selection refusal);
  - `attested-route-composition` ("outage never falls back", 37/37 at 21:38);
  - the host-services runner's refusal of `platformHostPolicyRpcs` with a verifier.
- **Live canary test (exact plan):**
  1. After each step, deny egress from that unit's cgroup/host to the five public RPC hosts above (nftables by resolved
     IP).
  2. Confirm the consumer still serves and logs its verifier authority.
  3. Confirm `ss`/conntrack shows zero connections to those hosts for the window.
  4. Then stop the verifier and confirm the consumer **fails closed**, not falls back.

## 5. Unknowns

- the live API relay host and config;
- Windows node processes and config on `minipc`;
- the site/mobile/dashboard live releases;
- bootstrap-gateway code defaults;
- public-directory verifier support;
- whether the deployed lease relay `94f4ebdf…` matches any reviewed source.
