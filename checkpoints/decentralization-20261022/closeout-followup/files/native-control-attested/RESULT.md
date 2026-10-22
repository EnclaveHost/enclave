# Native control names bound to attested control guests: RESULT (2026-10-22)

**Status: source committed locally and tested offline. NOT deployed, NOT imaged, NOT measured, NOT pushed.**
- No production access, SSH, live RPC, signing or funding happened.
- The synthetic-AMD tests prove protocol wiring only, not hardware.
- The old 6f image (`bdadc7bb…`) and its completed hardware canary do NOT contain this code.

## Source

| item | value |
|---|---|
| isolated checkout | `work/resume-after-checkpoint-20261022/native-control-attested/repo` (clone of `source-checkpoint-20261022/main-repo`, origin removed, branch `work/native-control-attested`) |
| base | `eaea7e4630ee1d82b3599b872a24075691510211` (published candidate; tree `f00790fc…`) |
| commit | `8e77ff1eca24be3c02e281dc9f431af597165adf`, tree `69e8338002adca1f9273a48de769a5c5d2efdb1e`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `native-control-attested.patch` = `git diff eaea7e46 8e77ff1e`, sha256 `2e176040b7d6d1faf73000cfad18b9cfffdf38f961fa0d1bf7f88f893fdd9648` (13 files, +1565/−61) |
| base worktree | `base-eaea7e46/`: unmodified eaea7e46, real node_modules copies, used only for build controls |

### Inventory: committed blob sha256, each equal to the file the tests ran

| file | sha256 | role |
|---|---|---|
| `metal/guest/measured-control.mjs` | `318a84ceefecbcf3bc434cfcc2705193cbb8721cbff13cedc7fe6c197011c105` | **image input**: nativeControl member, statement field, certificate check, front |
| `metal/guest/gsup.mjs` | `07e0583974818a5b4be5fe3051844db99794594fb4d8d2dce9217c1706c09ae0` | **image input**: passes the native launch to the front |
| `metal/measured-control-verify.mjs` | `2137d39e9dfb17d79ae8540c54ff28531bdd1b503ce8af4189f170a8a8f6b341` | inlined in the platform-api bundle: `identity.chipId` |
| `metal/guest/platform-api.bundle.mjs` | `3078345b9e27594d9964998a3f638ff4a9727abef0bcd8cf02abacd993162e4c` | **image input**, regenerated |
| `metal/guest/platform-api.bundle.mjs.manifest.json` | `6476d54ea706d52f4d3a1227bc91c63d9691476435bd92666e757073f6a3611a` | its manifest |
| `network/native-control-routes.mjs` | `37c75086467ee7a41cf5f2335e99ee97f2ff14a325b68e828fff43ed480317fc` | NEW, not an image input: discovery |
| `scripts/native-control-certificate.mjs` | `ac7f5f80235e0dcf6182558d85f19f0328475586d8f626a3c7c4c924c9d038ea` | NEW: request, issue and install tool |
| `relay/native-discovery.mjs` | `cccd30291605db1357b7dc91fb493446a3fe22624653c6636d311a17273fe01b` | not an image input; separately deployed |
| `test/native-control-attested.test.mjs` | `f8d9d1ef383e19feee7bc93f091275862f6ac5f37ed224db72c7a048c7f201c7` | NEW |
| `test/native-discovery.test.mjs` | `6bfbdf2b2c034720817fe9efab8ecf9594e0efd3942c21d99f4317d820cf2c09` | updated |
| `docs/network/measured-control-guest.md`, `docs/network/platform-host-policy.md`, `docs/design/nan-retirement.md` | (docs) | |

`network/service-index.mjs`, `host-policy-runtime.mjs`, `host-policy-adapters.mjs` and `platform-host-policy.mjs` are
**unchanged**. So no Windows bundle, MCP bundle, host-admission bundle, policy-mirror package or network-runtime bundle drifts.

## What the source does

1. **Guest** (`nativeControl: { names, caSha256 }`, optional).
   - It needs `platformApi`, and HOST_DATA binds it.
   - The statement states `native`; statements without it keep their exact bytes.
   - For exactly the bound SNI names, the front serves a **native-CA leaf over this boot's attested control TLS key**.
   - The leaf is issued outside the guest and installed by `PUT /.well-known/enclave-native-certificate`. The front
     accepts it only if all of these hold:
     - the chain is the leaf plus the bound CA;
     - the leaf carries the guest's own key;
     - a real TLS handshake (duplexPair, Node/OpenSSL verifier) succeeds for every name;
     - it expires strictly later than the installed leaf.
   - The install path is bounded:
     - one install at a time, with no queue;
     - a declared Content-Length up to 16 KiB is required before any body byte is kept;
     - the body must arrive within 10 s;
     - the slot is released on abort, error or oversize.
   - A refused or interrupted install leaves the current leaf serving.
   - A native name without a current leaf fails the handshake.
   - SNI and Host must agree, otherwise the front answers 421.
   - `api.enclavehost.eth` reaches the platform API role exactly as its WebPKI host does.
   - `mcp.enclavehost.eth` reaches the relay's own MCP at `/mcp`, with the query kept. That handler (`relay/mcp.js
     handleMcp`) ignores the path, takes auth from `Authorization` or per-call tokens, answers POST JSON-RPC, GET info,
     SSE 405 and OPTIONS. This is the production `mcp.enclave.host` behaviour.
   - The hosted independent-MCP `POST /mcp` route is unchanged.
2. **Issuer tool** (`scripts/native-control-certificate.mjs`).
   - `request`: `verifyMeasuredControl` against the boot's **trusted config** (never an advertiser claim), then an
     evidence re-read pinned to the attested key.
   - `issue`: offline, run by the CA holder, `openssl x509 -new -force_pubkey` over the attested SPKI. The bound CA is
     checked by sha256, validity is at most 7 days, and the CA key is read only by openssl.
   - `install`: over `pinnedSocket`. The SPKI is checked on the secure socket before any HTTP byte is sent.
3. **Discovery** (`network/native-control-routes.mjs`, wired by `relay/native-discovery.mjs` only when configured).
   - Kind-9 ads are candidates only, read at one agreed block through the shared `agreedRead`.
   - For each address it checks:
     - the native TLS connection under the native CA, with SNI;
     - the leaf key equals the statement's attested key, and the statement binds the name and the CA;
     - the unchanged `verifyMeasuredControl` at the same address (AMD chain, measurement, nonce, role, HOST_DATA,
       supervisor keys, ORIGINAL registry row active with operator and proof key);
     - a fresh platform host policy decision for **that registry id**, never the advertiser's.
   - Failure-domain addresses are never probed, routes live at most 60 s (bounded by leaf and ad expiry), and there is
     no DO fallback.
   - Policy explicitly "off" is a startup refusal.

## Root findings: disposition

| # | finding | resolution and evidence |
|---|---|---|
| 1 | unbounded install queue and bodies | Exclusive install, length before body, 10 s body bound, release on abort. Test "install refusals…" (held body gives 429, abort releases, an in-flight install refuses the next). Mutants G4 and G5 killed. |
| 2 | expiry rollback | Replacement only if it expires strictly later. Equal or earlier is refused, and the current leaf keeps serving. Mutant G3 killed. |
| 3 | scope | Synthetic AMD proves wiring only (stated in the test header and here). |
| 4 | MCP path | The real `handleMcp` runs behind the native mcp name in the test. The role's forced `x-forwarded-host` means MCP is reached only at `/mcp` on the API host, so the rewrite to `/mcp` is required. |
| 5 | `rejectUnauthorized:false` + `checkServerIdentity` pin | Replaced by `pinnedSocket` (SPKI checked on the secure socket before any request). Test: a wrong-key self-signed peer receives 0 HTTP bytes. Mutant T1 killed. |
| 6 | chip bans | See the next section. The earlier blanket refusal is replaced. |
| 7 | real identity proof | The sole discovery proof uses real fronts, real TLS, the real `verifyMeasuredControl` and `verifySnp` (synthetic chain), the real `quorumRegistry` and service-index quorum over JSON-RPC, and the real platform gate over an **admin-signed anchored policy** (`platformPolicyWorld`). There is no injected verify or decision in that test. |

### Chip identity (native-chip-review/RESULT.md, verified independently)

The citations hold:
- `contracts/EnclaveSecretVaultV2.sol:66` (`sha256(SNP report CHIP_ID, 64 bytes)`);
- `custody/v2/daemon.mjs:105-106`;
- `custody/v2/member.mjs:66, :150`;
- `custody/v2/capacity.mjs:14`;
- gate `decide({extra})` at `platform-host-policy.mjs:281-285`.

**One correction to the review's step B.** `freshAdmissions` goes through the **policy runtime's** `decide`
(`host-policy-runtime.mjs:71`), which takes no `extra`. Changing it, or the adapters, would stale the MCP guest bundle,
the Windows lease bundle, the policy-mirror package and the network runtime. So B was not done in shared modules:
- **A.** `verifyMeasuredControl` sets `identity.chipId = policyChipIdOf(claims)` only after the report verified:
  `"0x"+sha256(64-byte CHIP_ID)`, or null when masked, zero or malformed.
- **C.** `nativeHostDecision(decision, acceptedPolicy, chipId)` re-judges a decision the accepted policy itself made (an
  admit, or a refusal with status current, stale-grace or stale). It uses the gate's own `judgeHost` over the runtime's
  chain facts plus `chipId` **only**; no chain fact is replaced. Other outcomes (not-activated, behind, authority,
  inactive, unreadable) stand.
  - With no proven chip, an admit under any `chipId` denial becomes `chip-unproven`.
  - Allowlist chip entries match only a proven chip.
- **D.** `docs/network/platform-host-policy.md` defines `chipId` and names the only enforcement points that supply a
  proven chip: custody v2 and native routes. Other points that judge registry facts only do not see chip entries.

**Tests** (two synthetic chips, each with its own VCEK, through the real verifier):
- derivation parity with the custody formula, and no chip on a rejected path;
- chip A banned with B served, the gate's own reason `(chipId)`;
- allowlist B, then allowlist A;
- an operator ban stands under a chip allowlist;
- a certificate SAN label and an unbanned advertiser change nothing;
- the unproven-chip unit cases.

Mutants C1-C7 were all killed.

## Tests (all via `work/claude-test-queue.py`)

Every run was offline: `unshare -r -n`, loopback only, DNS proved unreachable, ssh/scp/sftp denial stubs proved first in
PATH, TMPDIR on disk. Raw logs are in `logs/`.

| log | scope | result | peak |
|---|---|---|---|
| t1 | first run of the new suites | 12 pass, 4 fail. Failures: test regex; Host-derived SNI in a probe; the role stand-in on the wrong port (front correct). Retained. | 187 |
| t2, t3 | rig fix runs (a non-native guest built a native option) | t2 7/8 (retained), t3 8/8 | 190 |
| mut | 14 security mutants (N, G, T) | 13 killed; N6 survived (no policy-row disagreement case) | 206 |
| t4 + mut2 | N6 case added; N6 re-run | 8/8; N6 killed | 191 / 204 |
| reg1 | metal-measured-control + platform-api-config at 256 | **guard-stopped at 264 MiB (99)**: a non-result; the gsup test failed before the stop | 264 |
| gsup | gsup test on the unmodified base vs the work tree | **fails identically on base eaea7e46** (it assumes an older HEAD): pre-existing | 151 |
| reg2 | metal-measured-control (no supervisor or gsup) + platform-api-config | 12/12 | 239 |
| t5 | final `native-control-attested.test.mjs` | **9/9** | 193 |
| mutc | chip mutants C1-C7 | 7/7 killed, sources restored by sha | 209 |
| sup5 | the five real-supervisor tests (root-approved 512) | **5/5** | 273 |
| t6 | `native-discovery.test.mjs` on the commit | **8/8** | 152 |
| pab, pab3 | bundle build attempts | pab: missing generated prerequisite (retained); pab3: regenerated runtime differed through symlinked node_modules (retained) | n/a |
| pab4 | regenerate `relay/network-runtime.bundle.mjs` from source in base and work tree, base control, delta build | **both = pin `8399d143…`; base `--check` reproduces committed `ede48c36…`; delta `3078345b…`** | 441 |
| pac2 | installed delta bundle `--check` | verified | 334 |

**Not run:**
- `mcp-hosted-control.test.mjs`: heavy; its front route is unchanged, and the host-route front test in platform-api-config passed.
- Anvil and broad suites.
- Image build and measurement (root review first).

## Image and bundle inputs, and the NEW measurement (not produced)

**Changed image inputs:**
- `metal/guest/measured-control.mjs`;
- `metal/guest/gsup.mjs`;
- `metal/guest/platform-api.bundle.mjs` with its manifest. The only changed bundle inputs are measured-control.mjs and
  measured-control-verify.mjs; the sidecar and the other 2194 inputs are equal.

Every new control-image measurement therefore differs from `bdadc7bb…`. The bound configs, Platform API `measurements[]`,
client expectations and `NATIVE_CONTROL_MEASUREMENTS` must name the new one.

**Recipe for root** (the 6f build's commands with this commit):
1. Before the overlay, regenerate the gitignored prerequisite: `node relay/build-network.mjs` in the source clone with REAL
   node_modules copies. It must hash to `8399d143…`.
2. Run `scripts/build-platform-api-guest-bundle.mjs --check`, which must report `3078345b…`.
3. `python3 <src>/metal/overlay-control-image.py --control direct <prod-artifacts>/dist-sdshield-2857356cd <out> 8e77ff1eca24be3c02e281dc9f431af597165adf`
4. Measure with the same `sev-snp-measure` parameters as the 6f build:
   `--mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf <pinned OVMF> --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct"`
5. Run an independent second build and compare.

## Activation prerequisites (root and admin; none done)

1. **Image.** Build, measure, review and hardware-canary the new image. The old 6f canary does not cover it.
2. **Guest config.** Add `nativeControl: { names: [...], caSha256: "86bf2c48…a62c" (existing native CA DER) }` beside
   `platformApi`. Forward public :443 to the guest's control port as TCP passthrough; it is never TLS-terminated by the
   host.
3. **Issuer (existing native CA, single custody today: the minipc control VM).**
   - Per boot, because the control key is minted per boot, run `request`, then `issue` (at most 7 days), then `install`.
   - Repeat before expiry and after every reboot. Issuance is the CA holder's admin decision for that boot.
   - **Issuer recovery dependency.** If the CA host is unavailable, native names stop when current leaves expire (at most
     7 days); there is no fallback.
   - Distributed issuance, custody or escrow of the CA key is NOT provided. A recovery or escrow plan is needed before
     the CA host can be retired.
4. **Ads.** Operators publish kind-9 ads (`prepareControlAd`, then `scripts/network/service-index.mjs sign/send`).
   Wallet actions are root's.
5. **Discovery deployment.** With `NATIVE_CONTROL_SERVICE_INDEX` set, `relay/native-discovery.mjs` loads the network
   module, so it needs this tree with real node_modules (or a reviewed bundle, not produced here). It also needs this
   environment:
   - `NATIVE_CONTROL_SERVICE_INDEX`, `NATIVE_CONTROL_RPCS` (2-8), `NATIVE_CONTROL_REGISTRY` (original EnclaveRegistry),
     `NATIVE_CONTROL_MEASUREMENTS` (new measurement), `NATIVE_CONTROL_EXCLUDE` (the 4 DO IPs);
   - reachability of the AMD KDS (`httpCollateral`).
   - The policy runtime has no production mirrors. After the admin anchors a policy, discovery needs non-DO
     `ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS` or carriers, or it refuses every route (fail-closed).
   - Unset: control names answer 503, as at 04ee.
6. **Rollback.**
   - Guest: drop `nativeControl` (new HOST_DATA), or simply do not install a leaf; native names then fail the handshake.
   - Discovery: unset `NATIVE_CONTROL_SERVICE_INDEX`, which gives 503.
   - The previous discovery file restores the DO addresses only if deliberately reinstalled.

## Additional findings (not fixed here)

- **Pre-existing, security, `metal/guest/platform-api-role.mjs:296`.**
  - A standby forwards client API requests (including `Authorization`) to the primary with `rejectUnauthorized:false`
    plus a `checkServerIdentity`-only SPKI pin.
  - Node skips that check when chain validation already failed, so a self-signed MITM would receive those requests.
  - Fix: the same pattern as `pinnedSocket` (verify SPKI on `secureConnect`, then HTTP over that socket). The change
    touches the platform-api bundle and needs the role suites (larger lane).
  - `defaultPost` (the AEAD-sealed peer protocol) does not rely on TLS identity.
- **Pre-existing, test.** The `metal-measured-control` "gsup" test compares against `git show HEAD` and fails on
  unmodified eaea7e46.
- **Build hygiene.** Regenerating `relay/network-runtime.bundle.mjs` with symlinked node_modules embeds `../repo/…` path
  comments and changes the hash. Use real copies.

## Limitations

- No hardware, no real AMD chain, no real measurement.
- The native CA key custody and issuance are centralized (one host).
- `chipId` matching exists only where a verified chip is supplied (custody v2 and native routes).
- Native discovery itself is still reached through the DO fronts' `/native/*` proxy until it is redeployed elsewhere.
