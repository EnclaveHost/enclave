# Linux runtime release: D f1d0666b + ROOT 1086cf23, packaged as a measured relay-mode control image (2026-10-23)

**Status:** built and verified locally from exact immutable inputs, then re-measured in a separate job.
- Nothing is deployed or activated, and no hardware has booted it.
- No SSH, allowlist change, config/service change, wallet action or download.
- The D candidate and root's review tree were only read: `git format-patch` from root's repo and a `--local` clone of
  the image commit's repo.
- **This is not the completed architecture.** See "Outside this image".

**Measurement: `3043f6ff8d8bbfbe995d3dde5e93e790a9b3bb5db432375b8e8b3c72b1cc26a2aaee5cab174a7a4134b92923c81ea77d`**
- SNP, 4 vCPUs, family 26 / model 2 / stepping 1, QEMU, OVMF `142589cc…`.
- cmdline: the production template `… metal.mode=snp metal.isolation=snp-guest-per-app`. That is relay mode, the mode of
  the running ed918e4b.
- A (build job) and B (separate verify job, cmdline read from the artifact) are identical.

## 1. Production lineage this replaces (recorded locally; not queried live)

- **Running Linux runtime:** KEPT **ed918e4b** (`work/linux-post-adoption-release/activation/result.json`, state KEPT,
  2026-10-21: the operational gate passed and both app-paid renewals were audited).
  - Overlay commit deabf8f90 (old pre-rewrite history; the source is the non-git `enclave-prod/metal-deabf8f90`).
  - Production base dist-sdshield-2857356cd (b8376e15).
  - Supervisor 01ac9cb1, host-admission bundle **e83515fc**.
  - The host launcher runs from that release directory (drop-in `WorkingDirectory=…/metal-deabf8f90`), with
    config.json `dist` + `leaseGas`.
- **D's base is a different lineage.** 2bbea898 (the checkpoint normal tree) forks from main at adf9c5bb; the reviewed
  image lineage is main 7752a423 → 6f2c7da4 → 493ee9ee (native image fe897820).
  - D's tree had two image defects:
    - **`RAD_PATH = "/.well-known/Cloud Provider-attestation"`**, a bulk-rename wire break (the C2 item root accepted and
      fixed in 6f2c7da4 with `relay/attestation-paths.mjs`);
    - host-admission **3438cdf2** with the 4 DigitalOcean `/platform-policy` mirrors as the production default (metal
      host-policy a19af83c likewise).
  - Every other image input in 2bbea898 is byte-identical to 493ee9ee (`public/lineage-compare.json`).
- **Composition:** D's 3 commits plus root's 1 (2bbea898..1086cf23) re-applied as exact patches onto **493ee9ee**. Every
  file they touch is identical at 2bbea898 and 493ee9ee except `supervisor.js`, which differs only by the 18 lines of the
  C2 change plus a comment.

## 2. Source (`RECIPE.md`; `public/source-commits.txt`)

**Composed commit: `fec43a6a08da2ac287fb3a5c42de89f096f4f678`**, tree **`13e18b0895e37a7baa5bc9e11ad1fdcf337daac0`**:
- `493ee9ee` + fbeab506 (09ff3ed5) + e4591e22 (b744ba19) + ee7a059f (f1d0666b) + fec43a6a (1086cf23).
- Authors, messages and author dates are preserved. The committer is SteveDeFacto with committer date = author date, so
  the ids are reproducible from the 4 patches (`patches/`, `public/patches.sha256`).

Proved in s1:
- the composed paths equal root's range paths;
- the 10 non-supervisor files are byte-identical to 1086cf23;
- **supervisor.js `4939dc68…` is the exact line union in both directions:**
  - (composed − 493ee9ee) == (1086cf23 − 2bbea898): 330 lines;
  - (composed − 1086cf23) == (493ee9ee − 2bbea898): 18 lines.

So it carries root's adopt guard 7389d613, D's decision-window/confirmed-stop work and the C2 legacy-compatible
attestation paths.

## 3. Image (`image/`, outside Git; distribute by hash)

| file | bytes | sha256 |
|---|---|---|
| dist-linux-fec43a6a0/initramfs.cpio.gz | 279506431 | 5d5de3dde3ddfe3ea502e583e583cafa3444c49c83fffa4140a2f134af35a91c |
| dist-linux-fec43a6a0/vmlinuz | 17232384 | 1a3a02d5… (= base, 7.2.3-arch1-2) |
| dist-linux-fec43a6a0/manifest.json | 29208 | 8a0defe0d40e096fbd82f327caed2b123c9bfc4472ff88aec3abdef41f691d04 |
| dist-linux-fec43a6a0/cmdline | 105 | d9e04c2c… (= base) |
| dist-linux-fec43a6a0/MEASUREMENT | 97 | a33bee3c… |
| release-fec43a6a0.tar (host launcher release tree = `git archive` of fec43a6a, no node_modules, as metal-deabf8f90 was) | 170803200 | 1a4756353e39bd93e12aa2ed828702e0c659739a95e1d3bc46bde710437563d7 (2 passes byte-identical) |

**Inputs (`public/INPUT-MANIFEST.json` = `inputs-build.json`, equal to the s1 precheck).** 55 files, selected by the
commit's own overlay tool 1067a535.
- **Against the native 493ee9ee image:** identical except app/supervisor.js (2c87a36f → **4939dc68**) and app/egress.js
  (99a99f08 → **bd960a2b**, D's per-deployment `closeDeployment`). The 4 native-only inputs are its `--control direct`
  files (platform-api, mcp, tpm-roots, contract-pins).
- **Against the live ed918e4b:**
  - 29 unchanged;
  - 15 added (the lease-relay discovery/service-index/provider-policy closure, owner nomination, attestation-paths,
    relay/net-guard as real bytes);
  - 0 removed;
  - 11 changed: supervisor, egress, host-admission **e83515fc → 40e8ba71**, host-policy **8b2dfbc6 → acfa1b00**,
    lease-executor-client, lease-gas-owner/runtime, lease-gas-conduit bundle, snp-verify (comment text only), gsup
    (adds owner nomination; the legacy branch is otherwise unchanged) and measured-control.

**Image checks (v1, 28/28, `public/image-verify.json`), from the image's own bytes:**
- the kernel, modules and cmdline equal the base, with no control/platform-api/mcp record;
- controlOverlay is fec43a6a + tool 1067a535, and the base's 2857356cd overlay is kept in history;
- all 55 inputs are present with their precheck hashes;
- none of the 29012 other entries changed (33 module-tree entries included);
- the 46-file supervisor closure and npm exports are present;
- guest helper imports resolve;
- gsup starts /app/supervisor.js in the legacy branch;
- **no installed input, and no base app/opt file outside node_modules, contains a DigitalOcean mirror literal**.

The image's flavor-env (37 keys) has CHAIN_ID 8453, the production book, and **no platform-policy key**.

**Import check (`public/import-check.json`):**
- 48 modules imported from the extracted image and 9 opt/metal modules syntax-checked;
- the installed bundle exports every name the installed supervisor imports (createHostServiceGate,
  hostAdmissionConfigured, hostAdmissionFromEnv);
- `decision()` is present, carriers are supported, and the production default has `mirrors: []`.

## 4. Admission bundle: the paired API, proven on Linux (t1 G0/G1/G2/G6)

| bundle | decision() | carriers | production-default mirrors | ships here |
|---|---|---|---|---|
| **40e8ba71** (493ee9ee, = the reviewed platform-carrier bundle) | yes | yes | **none** | **yes** |
| e83515fc (live) | **no** (refusal only) | no | 4 DigitalOcean | refused |
| 3438cdf2 (checkpoint/D tree) | yes | no | 4 DigitalOcean | refused |
| 6bef372d (Windows installed) | yes | no | none | not needed |

- **G1:** `scripts/build-host-admission.mjs` rebuilds BOTH 40e8ba71 and acfa1b00 byte-identically from the composed
  source.
- **6bef372d was not used.** 40e8ba71 is the same API plus carriers, built from this commit's own sources. The Windows
  node's swap 6bef372d → 40e8ba71 is still pending, as root's native activation lists.
- **Real call path:** D's hold suite runs the REAL supervisor functions against the tree's shipped bundle, so G2 ran
  decision() through 40e8ba71.
- **G6 control:** the same suite with e83515fc swapped in fails 16 of 25. Shipping D's supervisor with the live bundle
  is therefore wrong, as stated.

## 5. Tests (all queued; jobs in `public/log-*.txt`)

| job (cap) | peak | result |
|---|---|---|
| s1 compose (512) | 106 MiB | exit 0 |
| t1 tests (768) | 688 MiB (solc in G5 fixtures) | exit 0. **Groups:** G0 0, G1 0, G2 0, G3 1 (see below), G4 0, G4-overlay 1 (harness error, see t2), G5 0, G6 1 (expected) |
| t2 overlay unittest (256) | 114 MiB | **16/16 OK** |
| b1 build (768) | 301 MiB | exit 0. Calibration reproduced **b8376e15 and ed918e4b**; inputs equal the precheck |
| v1 verify (768) | 219 MiB | exit 0. B = A; 28/28 image checks; import check ok |
| s2 publish scan (256) | 93 MiB | PINS verify; gitleaks (checkpoint config) over RESULT/RECIPE/PINS/public/tools/patches: **no leaks** (1.31 MB) |

- **G2 (D + root focused):** adopt-pending-stop, wallet-unknown-hold, wallet-policy, pool-reconcile, egress: **64 tests,
  53 pass, 0 fail, 11 skipped.** All 11 skips are egress.test.mjs phase-2 e2e cases gated on
  `$ENCLAVE_EGRESS_WASMTIME`, a patched wasmtime. They are not run and not counted as passes.
- **G3 (D's jobd6 regression set, 18 suites):** **135 tests, 132 pass, 1 fail, 2 skip.** This matches D's d6 on
  f1d0666b case for case.
  - The failure is the pre-existing `tenant-provision-race` "a delayed second claim cannot replace an adopted or running
    record".
  - Its vm harness for `adopt()` lacks module-scope names: `releaseHold` on 2bbea898 and f1d0666b. It now throws first at
    `walletVerdicts`, root's new snapshot line (adopt() is byte-identical to 1086cf23).
  - It never passed, and I do not claim it.
  - A harness fix is test-only, but **any new commit changes the measurement**, so fold it in before the final image if
    root wants it.
  - The 2 skips are that suite's dependent cases.
- **G4 (image-side):** attestation-route, host-admission-runtime/retry, metal-lease-gas-conduit, owner-nomination-config:
  **35/35**.
- **G5:** D's real lease client: createLeaseClient + the relay service on anvil: **4/4**.
  - An allowed claim is paid by the app's reserve with zero host ETH.
  - A refusal after the queue check stops the signed lease before the relay (0 POSTs).
  - A decision-window refusal never reaches the client.
- **Not run:** the full repository suite, physical guestd/hardware paths, and `offchain-heartbeat-writers` (its forge
  build exceeds 1536 MiB; recorded earlier). `network/registry-reconcile.mjs` (the heartbeat path) is byte-identical to
  live (ed593417).

## 6. Compatibility with the running host (from source; no live read)

- **Host launcher** (the release tree's `metal/enclave-metal.mjs` closure):
  - the only delta from deabf8f90 is an optional `ownerNomination` (absent: unchanged);
  - `network/metal-host-policy.mjs`, `host-admission-policy.mjs` and `contract-pins.mjs` are byte-identical;
  - the lease-gas conduit gains optional `pinnedRelays` (absent: the same six names and transit).

  So the KEPT config.json is accepted unchanged, provided it has no `ownerNomination` (a live pin below).
- **Features preserved:**
  - **App-funded leases:** lease-gas runtime superset; G5.
  - **Catalog delisting / owner deny:** decision() refusal still retires and releases (G2 "explicit refusal").
  - **Admin platform policy:** gate code unchanged; production default on.
  - **Attestation wire path:** the legacy path still served and advertised.
  - **Off-chain heartbeat:** registry-reconcile unchanged; held ids are not vouched (D).
  - **Egress privacy:** per-deployment close and stream cut on withdrawal (D).
- **Authority:** no verifier/RPC default changed. A's verifier-authority work (2efc4a83) is not in this image.

## 7. Outside this image (concrete; none was invented as a gate)

1. **Relay-mode platform-policy carrier (blocks any admin ANCHOR, not this cutover).**
   - What the code does today:
     - 40e8ba71 has no default mirror;
     - its carrier wrapper reads `ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS` from the supervisor's env;
     - gsup's legacy `supEnv` = baked flavor-env (no policy key) + the fw_cfg wallet-policy env;
     - the launcher forwards no carrier;
     - only the measured direct guest has `platformPolicyCarriers` (measured-control CARRIERS_ENV).
   - Consequence: after an anchor this image cannot load the policy and refuses itself after the grace. That fails
     closed, but it is a liveness break.
   - Today the production book is recorded unanchored, so both bundles admit as "not activated".
   - **Needed before any anchor:** a reviewed relay-mode pass-through (launcher fw_cfg `platformPolicyCarriers`, validated
     like `directPolicyCarriers` → gsup legacy supEnv), which means a new image and measurement. Or Linux moves to the
     direct image. Plus real non-DigitalOcean carrier peers.
2. **Lease relay:** the KEPT plan's only relay is the EU DigitalOcean relay (root's temporary topology). This image can
   use a host-local `pinnedRelays` / service-index discovery, once a local relay role exists. That is a config change,
   not a new measurement.
3. **Direct-mode successor:** native fe897820 still carries the pre-D supervisor. `--control direct` of fec43a6a is the
   same recipe, not built here.
4. **Verifier authority (A) and the local Helios binary:** a later composition.
5. **Windows:** the host-admission swap to 40e8ba71 is separate.

## 8. Activation / rollback (`public/ACTIVATION-REQUIREMENTS.json`; root executes)

1. Review and publish fec43a6a. Any other commit means a rebuild and a new measurement.
2. Stage the image and release under new enclave-prod names.
3. **Additively** admit 3043f6ff on the API relay's Linux allowlist (ed918e4b stays for rollback).
4. Run a fresh funding preflight.
5. Cutover through a new instance of the post-adoption activation harness:
   - PREV = deabf8f90/ed918e4b;
   - change only `dist` and the drop-in `WorkingDirectory`; keep `leaseGas` byte-identical;
   - baseline, adoption of the same guests, operational gate v4, both app-paid renewals.
6. Root audits both renewals on chain, then keeps.

Rollback: the CAS safe rollback to ed918e4b (stop first, wait past every logged sponsored deadline), then b8376e15.

**Live pins for root's read-only query** (listed in the JSON):
- the running measurement;
- the config.json hash 58aa9653 and its key names;
- the drop-in 21fadc72;
- the relay allowlist env hash;
- the policy anchor state;
- whether `hostAdmission.policyOrigins` names any DigitalOcean address;
- the guestd lineage 174edbb7d.

## Limits

- **Local build only.** One host and one tool. There was no second rebuild, per the task, though the overlay is
  deterministic (mtime 0) and earlier commits rebuilt byte-identically.
- **Scripted edges only.** Held-guest, guestd and provisioning edges in tests are scripted (root's and D's harnesses).
  There is no physical termination evidence. A broadcast transaction cannot be recalled: the gates bound only what is
  signed and sent next.
- **Not decentralized yet.** This image removes the DigitalOcean policy-mirror default from Linux. It does not remove
  DigitalOcean from Linux operation: the relay attach, the EU lease relay and the carriers above remain.
