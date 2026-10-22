# Native production next: shortest concrete activation path for dfe020abf + image 493 (read-only, 2026-10-22)

**Scope.** This report uses local source and evidence only. I did not use SSH or RPC, made no production change, and
wrote no code or tests. Secrets and private configs are not reproduced: only hashes, public endpoints and paths appear.

The governance basis is `work/effective-goal-requirements.txt`:
- Admin governance stays.
- The four DigitalOcean machines are WireGuard transport only, and count as **one** failure domain.
- Provider independence means no required central server. It does **not** mean surviving an admin refusal.
- Replicas under one provider or at one site are never reported as independence.
- No cloud purchasing or new accounts are authorized.

## 0. Verdict

1. **The software is ready. Production activation of the distributed API/MCP/CA path is blocked by hardware.**
   - The Platform API group needs **≥3 distinct physical SEV-SNP chips**. The gate is `pa-preflight.mjs`, which reads the
     CHIP_ID of each member's report.
   - Current evidence shows **one**: warden-host / metal0.
     - `outputs/platform-api-activation-review/platform-api-activation-review.json`: `"activation": "BLOCKED: needs >=3
       distinct physical SEV-SNP hosts; 1 exists (warden metal0)"` and `"notCounted": "multiple CVMs on metal0 (one
       physical failure)"`.
     - `outputs/decentralization-audit/closeout-state.json`: "Only one confirmed SNP physical machine available in
       current evidence"; Platform API = SOURCE TESTED NOT ACTIVATED.
2. **Three CVMs on warden would pass `pa-config-check` but are refused at preflight**, because the chip IDs are equal.
   Even if they were not refused, they would be one failure domain. I do not propose that path.
3. **The canary proves one bare guest on one host. It is not distributed proof.**
   - File: `outputs/decentralization-audit/native-control-hardware-canary-20261022.json`, run `20261022T225651Z`, PASS.
   - Its own limits say: "One bare guest on one physical host"; "No API/MCP/native certificate issuance, group failover
     or registration proof"; "No provider-loss or full feature-parity claim".
   - `productionActivated: false`, `registry: pending`.
4. **What root can do now without new hardware** is listed in §6-A. None of it activates the distributed path.
5. **The unblocking input is a decision, not code:** two or more further SEV-SNP machines with distinct operators,
   preferably off the 4.15.13.178 site. Under the current authorization nobody can buy them; they need a human or root
   decision.

## 1. Ready artifacts (exact identities)

| Artifact | Identity | Evidence |
|---|---|---|
| Source | `native-front-abort/repo`, branch `work/native-front-abort`, HEAD **`dfe020abf1794bedc42943e43fe85eb02593dd8d`**, tree `d50df24970539a086a97c7a0291343bd5705de19` | `git rev-parse` (local only; working tree clean except untracked `node_modules`, `relay/node_modules`) |
| Image source commit | `493ee9ee07497c94159ec4f6916e9ea920d31959`; `493..dfe` touches only `scripts/platform-api-admin.mjs`, `docs/network/hosted-platform-api.md` and 2 tests, so no image input | native-final-image/RESULT.md; ACTIVATION-REQUIREMENTS.json |
| Image | `native-final-image/image/dist-direct-493ee9ee0`: initramfs `a8a2a40c…` (282205620 B), vmlinuz `1a3a02d5…`, manifest `d34294b2…`, cmdline `fd236eb2…`, MEASUREMENT file `15a1f962…` | native-final-image/RESULT.md (rebuild2 byte-identical) |
| Launch measurement | **`fe897820f632bae497511a229f0c74465dade8841d5807f8287a3a2caa928d22c8d79c24ffa9b1f9554434b483fae38f`**, valid only for **cpus 4**, family 26 model 2 stepping 1, OVMF `142589cc` | ACTIVATION-REQUIREMENTS.json scope (`sha256 8585fa72…`) |
| platform-api bundle | `metal/guest/platform-api.bundle.mjs` **`0a1d88de230842442c41cc9f399d3a7dda5394fb523812b2503bc2358b09b4ef`** (the same in dfe as in 493) | sha256sum in repo |
| mcp-server bundle | `metal/guest/mcp-server.bundle.mjs` `eccb333401b43f97dc6bdbe4e7ff34da79bbc7c9fabe578809463ea58d63c81f` (unchanged since 6f2c7da4) | sha256sum; native-final-image/RESULT.md:36 |
| Admin CLI | `scripts/platform-api-admin.mjs` at dfe **`3b41b2668afeb0daf3da7bab04ef23ea899e4823904e55e9bda396a89027833e`**. It contains 0eac0d60b (collateral + pinned submit) and dfe020abf (status GET). The 0eac0d60b-only copy was `204a3bf3…`. | sha256sum |
| Hardware canary evidence | result.json `ba119531…`, verify-result.json `c4853a67…`, owner-config.json `8386ac96…`, qemu-argv.json `49e5dc5d…` | canary JSON |
| Cutover kit (never executed) | `work/platform-api-activation-closeout/`: cutover.sh `63f9af53…`, rollback.sh `870a3ca6…`, helpers pa-preflight `579801d8…`, pa-config-check `f0439511…`, pa-credentials-assemble `ba39d6b2…`, pa-export-check `9723ed80…`, pa-group-id `a589ebc5…`, pa-archive-open `da06bfe4…`, common `7540dbb0…` | INVENTORY.sha256 |
| Rollback images | KEPT `ed918e4b`, production `b8376e15`; 6f2c7da4 image measurement `bdadc7bb` stays built | native-final-image/RESULT.md |

**Ready entry points.** All are in the dfe tree. Run them with `ENCLAVE_TREE`/`TREE` = that tree.

**Build checks:**
- `node scripts/build-platform-api-guest-bundle.mjs --check` (expect `0a1d88de…`).
- `node scripts/build-mcp-guest-bundle.mjs --check` (expect `eccb3334…`).

**Launch and verify:**
- Launch: `node metal/enclave-metal.mjs --config <host-config.json>`.
  - Host config: `control:"direct"`, `mode:"snp"`, `direct:<canonical owner config>`, `dist:` the 493 dist, pinned
    OVMF, **`cpus: 4`** (see M7), backend `snp-guest-per-app` with release tickets off.
  - Forward only the control port. Set `registryKeyFile` 0600/0400 only when selling.
- Verify: `metal/measured-control-verify.mjs`, using `verifyMeasuredControl` with `expect.measurements=[fe897820…]`,
  current AMD collateral and the config digest.

**Admin CLI** (`scripts/platform-api-admin.mjs`). Every subcommand accepts `--collateral-dir D` (default
`~/.cache/enclave/amd-collateral`):
- `genesis --target <controlUrl> --target-config <member.json> [--import-dir <old relay data dir>] [--credentials creds.json] --envelope-out F --print-message --package-out P`
  - Then send: `genesis … --package P --signature 0x…`.
  - Exit 0 only on a pinned 200 with `ok`.
- `credentials --target <primary controlUrl> --target-config … --credentials creds.json` (signed the same way).
- `recover --target … --target-config … --recovery-key FILE --envelope F|URL --archive F|URL`.
- `status --target <controlUrl>`: an unauthenticated GET that verifies nothing.

**Other entry points:**
- Offline native leaf fallback: `scripts/native-control-certificate.mjs request|issue|install`.
- Native discovery service: `relay/native-discovery.mjs` with `network/native-control-routes.mjs` (env in §3).
- Cutover kit: `work/platform-api-activation-closeout/cutover.sh` (prints the plan; `run <0..7>`; production steps need
  `CUTOVER_ACK=<groupId>`) and `rollback.sh before-switch|after-switch`.

## 2. Physical placement evidence (no capacity or independence invented)

| Host | What it is | Counts as a Platform API member? | Evidence |
|---|---|---|---|
| warden-host / metal0 | the only confirmed SEV-SNP physical machine; ran the 493 bare canary (one guest, cpus 4) | yes, **one** chip | canary JSON; activation review `today.snpHosts: 1` |
| minipc (nucbox-k11-4, Windows) | Hyper-V/Shield host; runs today's control VM (api.enclave.host, native discovery :8187, native CA key) | **no**: Windows Hyper-V/Shield is not a supported member type | activation review (unsupported list); front/DNS layout memory |
| pixel10-pvm-cpu | Android pVM | **no** (unsupported member type) | activation review |
| 4× DigitalOcean | WireGuard transport, dnsdist, native-recovery provider `464cad3` | **never**: one provider failure domain, and transport only | effective-goal-requirements.txt:12,15 |
| Site | metal0, minipc and Pixel share one uplink, 4.15.13.178, with no IPv6 | one site = one network failure domain | activation review `sameSite` |

**Per-member resources.** The review's defaults are 8 vCPU / 8 GiB (the `enclave-metal.mjs` defaults). The 493
measurement, however, is for **4 vCPU** (M7). I have no evidence of spare capacity on warden beyond the canary's single
guest.

**Not available:** a second or third SNP chip, a non-DO off-site archive sink (`confirmedSink: null`), and a non-DO
public ingress (S4 undecided).

## 3. Inputs: existing vs missing

| Input | Status |
|---|---|
| Image 493 + measurement fe897820 | **exists** (local build, reproducible, bare hardware PASS) |
| Admin CLI dfe (collateral, pinned submit, status GET) | **exists** (local commit; not published or merged; see M1) |
| Cutover/rollback kit + helpers | **exists**; needs the bundle pin updated (M2) |
| ≥3 distinct SNP chips, 3–7 members, distinct operators | **missing** (1 chip) |
| Member direct configs `m*.json` (identical `platformApi`: members[], measurements [fe897820…], admins 1–5, recovery 1–5 X25519, archives, hostname) + `hostAdmissionSha256` | **missing** (root authors; public) |
| Operator wallets for EnclaveRegistry `register` + `setProofKey`, one per member boot | **missing** (operator wallet action; gas) |
| Admin hardware wallet(s) in `admins[]` | exists as admin authority; not yet named in any member config |
| Recovery X25519 keys (offline) | **missing** from evidence (root/admin) |
| Archive sinks: non-DO, off-site, write-restricted | **missing** (`confirmedSink: null`) |
| Admin-signed platform host policy on non-DO carriers, then AddressBook anchor | **missing**: live gate `anchor` with 0 mirrors/carriers |
| Old API `AUTH_DATA_DIR`, EnvironmentFile and stop command on the minipc control VM | exist live; root supplies `OLD_DATA_DIR`, `OLD_ENV_FILE`, `OLD_STOP_CMD`, `OLD_START_CMD` |
| WebPKI cert for api.enclave.host inside the guest (via credentials) + DNS to members + S4 ingress | **missing** (other owners; not scripted) |
| Native CA (sha256 `86bf2c48…`, P-256, name-constrained `enclavehost.eth`) | **exists**, key on the minipc control VM (encrypted backup on DO providers). Moving it into an admin-signed credentials package (`NATIVE_CA_KEY` + `NATIVE_CA_CERT`) is root's credential action. |
| Native discovery env (`NATIVE_CONTROL_SERVICE_INDEX=<index>@<codehash>`, `NATIVE_CONTROL_RPCS` 2–8 distinct providers, `NATIVE_CONTROL_QUORUM`, `NATIVE_CONTROL_REGISTRY`, `NATIVE_CONTROL_MEASUREMENTS=fe897820…`, `NATIVE_CONTROL_EXCLUDE=<the 4 DO IPv4>`, optional `NATIVE_CONTROL_OPERATORS`) | values are public, but **not configured** anywhere; the 493 discovery code is **not deployed** |
| kind-9 `native-control` ads in the pinned service index, one per serving operator | **missing** (operator signing/gas) |
| Hosted MCP `mcp` member (`port`, `managementDirectories` (must be non-DO), …) + published connector config | **missing**; the ownerRead custody gap is unchanged (hosted-mcp.md) |
| `get`: signed release channel owner key | **missing** (hard prerequisite) |
| `ipfs`: one native-client reader of the ENS-site-release profile for deployment `0x7ae476a3…ce33` | **missing** (new code, needs review) |

## 4. Source-versus-deployed mismatches

- **M1. Publication.** `dfe020abf` and `493ee9ee0` are local commits on `work/native-front-abort`. Nothing shows them
  published or merged to main or to the candidate. Root must publish 493 (or a successor that changes no image input).
  The admin CLI must come from dfe, **not** from 493's copy, which has no collateral (`platform-api-admin.mjs:100` at
  493).
- **M2. Stale bundle pin in the cutover kit.** `cutover.sh` lines 8 and 28 expect bundle `2dbdde0e…`; the current bundle
  is `0a1d88de…`. The step 0 `--check` itself still works, but the human comparison must use `0a1d88de`. Update the
  plan text (a doc edit) or compare manually. `TREE` must be the dfe tree, because `admin()` runs the tree's CLI.
- **M3. Deployed API.** api.enclave.host is served by the ordinary minipc control VM; no measured member is deployed.
- **M4. Native names.** api/mcp.enclavehost.eth route to minipc control TLS via reverse SSH tunnels through the DO
  fronts.
  - Native discovery (`:8187`) and the native CA key live on the minipc control VM.
  - The 493 native-discovery/route code is not deployed.
  - The DO fronts run provider `464cad3` via drop-ins.
- **M5. Windows host-admission.** `6bef372d` is live; the reviewed bundle is `40e8ba71` (not swapped; Root is handling
  Windows concurrently).
- **M6. Policy carriers.** The live gate is `anchor` with 0 mirrors, so there is no non-DO carrier for the admin
  policy. Every direct guest runs `ENCLAVE_PLATFORM_HOST_POLICY=production`, so members need fresh policy from real
  carriers.
- **M7. vCPU count.** fe897820 is valid only at `cpus: 4` and family 26 / model 2 / stepping 1. The `enclave-metal`
  default and the review's per-member figure is 8 vCPU.
  - Each member must launch with `cpus: 4` on the same CPU signature.
  - Otherwise root recomputes a measurement and adds it. `platformApi.measurements` takes 1–8 digests and must be
    identical in all members, so every list must change together.
- **M8. Storage names.** get/ipfs/sia.enclavehost.eth exist only as SANs on the minipc `services.key` leaf
  (`renew-native-cert.py:10`). Nothing serves them (native discovery 404).
- **M9. Registry.** The canary guest's proof key is `pending`, so no member is registered.

## 5. Registration and admin signatures required (none manufactured here)

1. **Per member and per boot (operator wallet).** Call EnclaveRegistry `register` (once per operator/host), then
   `setProofKey` with the proof key minted by **that** boot. Every relaunch, including any config or HOST_DATA change,
   mints a new key and needs a fresh `setProofKey`. `pa-preflight` requires each member to be registry ACTIVE with this
   boot's key.
2. **Admin policy (admin wallet).** Sign the platform host policy document, put it on non-DO carriers, then anchor it in
   the AddressBook (M6). It needs chipId entries (sha256 of each member's CHIP_ID) for chip-gated native routes
   (`native-control-routes.mjs:185`).
3. **Genesis (one `admins[]` hardware wallet).** EIP-191 `personal_sign` over `genesis-message.txt`, produced by
   `--print-message`. The package is bound to the boot just verified.
4. **Credentials (admin).** A signed `credentials` package to the verified primary. It holds the full credential set
   assembled by `pa-credentials-assemble` (the relayer, provisioner and Stripe keys, the WebPKI key and cert for
   api.enclave.host), plus `NATIVE_CA_KEY`/`NATIVE_CA_CERT` if the group issues native leaves. Otherwise the offline
   admin issues every 7-day leaf with `native-control-certificate.mjs issue`.
5. **kind-9 native-control ads (each serving operator).** Signed publication into the pinned service index (gas).
6. **Recovery keys (admin, offline).** 1–5 X25519 keys named in `platformApi.recovery`; they are used only by
   `recover`/`pa-archive-open`.
7. **For `get`:** the release-channel owner signature over the path→CID manifest.

## 6. Ordered activation, cutover and rollback

### A. Now, with one SNP host (no distributed claim; nothing here activates production)

These steps are optional and reversible:

1. **Publish/merge** `dfe020abf` (root; M1).
2. **Run the build checks:** `node scripts/build-platform-api-guest-bundle.mjs --check` (expect `0a1d88de`) and
   `node scripts/build-mcp-guest-bundle.mjs --check` (expect `eccb3334…`).
3. **Drop the unserved SANs.** Remove get/ipfs/sia.enclavehost.eth from `services.key` at its next renewal
   (`renew-native-cert.py:10`). This changes no behaviour (nothing routes them) and removes the unattested minipc key's
   power over them.
   - Check before: `/native/resolve?name=<n>` returns 404 `no_current_route` on providers.
   - Rollback: renew again with five SANs.
4. **Optional single-host staging on warden.**
   - Launch one 493 member with its final config and `cpus: 4`, register, `setProofKey`, then run
     `metal/measured-control-verify.mjs`.
   - Then run cutover steps 0–1 and step 2 (preflight). Step 2 **will refuse** at the chip gate until three chips
     exist. That refusal is the expected result.
   - It proves registration and verification on real hardware, and nothing about group failover.
   - Rollback: stop the guest. Production is untouched.

### B. After ≥3 distinct SNP chips with distinct operators exist (the actual activation)

**Order:**

1. **Policy first.** The admin signs the policy, including chipIds for all members. Publish it to non-DO carriers, then
   anchor (§5.2).
   - Rollback: the previous anchored document stays valid; re-anchor it.
2. **Member configs.** Write `CFG/m*.json`: identical `platformApi` with `measurements:[fe897820…]`, admins, recovery,
   off-site non-DO archives and `hostname: api.enclave.host`. Add `hostAdmissionSha256`, and optionally `mcp` and
   `nativeControl:{names:["api.enclavehost.eth","mcp.enclavehost.eth"], caSha256:"86bf2c48…"}`. Each name may be
   served only where `platformApi` is present.
   - `cutover.sh run 0`, then `run 1`.
3. **Launch** every member: `node metal/enclave-metal.mjs --config <host-config>` with `cpus: 4`. Then run registry
   `register` + `setProofKey` per member (§5.1), and `verifyMeasuredControl` per member.
4. **Preflight:** `cutover.sh run 2` (`EXPECT_MEASUREMENT=fe897820…`). It must show every member verified,
   registry ACTIVE, and ≥3 distinct chips.
5. **Fence:** `CUTOVER_ACK=<groupId> cutover.sh run 3`, which runs `OLD_STOP_CMD`. The API is down from here until
   step 10.
6. **Export:** `run 4`, then re-run `run 1` (it picks up `$WORK/relay-env.json`).
7. **Genesis:** `run 5` (unsigned, `--print-message`). The admin `personal_sign`s, then
   `SIGNATURE=0x… run 6`, then `run 7` (`--after-genesis`: a majority holds K, there is one leader, and `latest` +
   `recovery.json` are at every sink).
8. **Native CA.** Send the admin `credentials` package with `NATIVE_CA_KEY`/`NATIVE_CA_CERT` to the primary (§5.4), or
   use the offline leaf flow.
   - Verify that each `nativeControl` member serves a leaf over its own attested key: a TLS handshake under CA
     `86bf2c48`.
9. **Native discovery.** Deploy `relay/native-discovery.mjs` + `network/native-control-routes.mjs` from dfe on
   **non-DO** placement, with the `NATIVE_CONTROL_*` env from §3 and `EXCLUDE` set to the 4 DO IPv4s. Each operator
   publishes its kind-9 ad.
   - Until this is done the names answer 503 (fail-closed).
   - Discovery's only placement today is the minipc control VM. Moving it into members is not in this image. Placing it
     on a member host or another non-DO host is root's decision; I do not claim independence for it.
10. **Acceptance A1–A9** (activation review) against the members. Only then switch: DNS + WebPKI + S4 ingress for
    api.enclave.host (other owners).
11. **MCP.** Publish the hosted-MCP connector config (`url`, `expect` with fe897820 + the member config,
    `mcpSha256 eccb3334…`, collateral). Remove the old adapter only after the replacement verifies (hosted-mcp.md
    step 4). mcp.enclavehost.eth follows step 9.
12. **Cleanup:** `cutover.sh` step 9, after the rollback window.

**Rollback:**
- **Steps 1–4:** stop the members. Nothing old changed.
- **Steps 5–9, before the DNS switch:** run `rollback.sh before-switch`.
  - R2 verifies the frozen copy with `pa-export-check --verify` and expects EQUAL.
  - R3 stops every member. Members must never run with credentials while the old API also runs.
  - R4 runs `$OLD_START_CMD`.
  - Native names: withdraw the kind-9 ads or the discovery env, so they fail closed. The minipc tunnel path is restored
    by the old control VM start.
- **After the switch:** run `rollback.sh after-switch`.
  - Repoint DNS away from the members and wait TTL + 2×archiveMs.
  - Stop all members.
  - Fetch `latest` from every sink, then open it offline with `pa-archive-open` and a recovery key.
  - Restore into the old data directory per the script, then start the old API.
- **Image rollback:** boot KEPT `ed918e4b` / production `b8376e15`. Configs without the new members keep byte-compatible
  digests.

### C. get / ipfs / sia / name routing

| Name | Path | Gate |
|---|---|---|
| api/mcp.enclavehost.eth | B.8–B.9 (native leaf over attested key + native discovery + kind-9 ads) | ≥3 chips; CA custody action; non-DO discovery placement |
| ipfs.enclavehost.eth | native client profile for adapter deployment `0x7ae476a3…ce33`, bound through an admin ENS site release | **new reader code** (review first). Activate only when ≥2 non-DO admitted hosts resolve it, route records match the deployment, and an admin ban refuses. Serving browsers through the native CA is deferred. |
| get.enclavehost.eth | CID fetch from admitted `bootstrap-replica` (HS2 on nucbox serves its manifest) + signed path→CID manifest | release-owner key **absent** (hard prerequisite); stays unserved until then |
| sia.enclavehost.eth | none (indexers are per-deployment config) | keep unserved; drop the SAN (A.3) |

Moving the minipc proxy, or anything onto DO, does not count as completion for any name.

## 7. Limits

- The live state comes from the latest local snapshots and inventories (memory and 2026-10-19/22 outputs), not
  re-probed. Run the read-only confirmations in native-storage-names/RESULT.md §5 before acting.
- I did not re-review the code or run tests for this report. Earlier review results stand as reported in their own
  RESULT files.
- No claim is made about warden's spare capacity, other operators' hardware, or the off-site status of any sink.
- Image 493 does not by itself remove DO or minipc dependencies. That depends on where members, discovery, sinks and
  ingress are placed.
