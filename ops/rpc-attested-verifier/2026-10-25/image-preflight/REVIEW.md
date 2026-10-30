# Verifier-only direct-control image from e0dfe98aa: STOPPED at packaging closure (BLOCKER + minimal patch for root)

Status: **NO IMAGE BUILT, on purpose.**
- `e0dfe98aa` carries committed generated bundles that do NOT match its own reviewed sources. Two of them load on every
  boot, including the verifier-only one.
- An image from this commit would run pre-change bundled code under the new measurement. Per the brief this is a stop,
  not a build.
- **No:** SSH, live access, services, keys, measured-allowlist or contract change, VM start, commit, push, BASE edit, or
  write outside the owned stage and these logs/jobs.

## Inputs (pinned, all verified)

- **Source:** `e0dfe98aa4536976394bf6f2f16c670f0b95ea7c`, tree `f569dfee3e350f2e06b4454736bf8395d57cb3b5`, two independent
  clean clones (`logs/attimg-c0.*`, queue 1024, peak 883 MiB):
  - A (`attested-image-stage/src-a`): `git clone --local --no-hardlinks` of the shared repository.
  - B (`attested-image-stage/src-b`): a full `--no-local` clone of A. No alternates; same commit and tree; both clean.
- **Planned recipe** (`attested-verifier-stage/IMAGE-RECIPE.md`):
  `python3 metal/overlay-control-image.py --control direct --chain-verifier-dir "$V" "$BASE" "$OUT" "$COMMIT"`. Only
  `--control direct` differs from the reviewed relay-mode ec56 b1.
- **Overlay tool at e0dfe98aa:** blob `a7c41de8`, sha256 `10db3d3d…`. Identical to the reviewed ec56 build.
- **Native verifier pins:** `metal/chain-verifier-image.json` blob `ba48eac7`, identical to ec56. The
  `chain-verifier-inputs/PINS.sha256` verify.
- **Base:** `/home/steven/enclave-prod/dist-sdshield-2857356cd` (manifest `cc2571bb…`, initramfs `516d766d…`, vmlinuz
  `1a3a02d5…`). Read only; nothing built.
- **OVMF:** `142589cc…` (not used yet).
- **Stage:** `attested-image-stage/` (own ssh/scp/sftp-denying stubs; 0 invocations).
- **Every job:** `work/claude-test-queue.py` at 1024 inside `unshare -r -n`, with the namespace proved to be loopback-only
  with no route.

## Packaging closure of the verifier-only direct image (observed source at e0dfe98aa)

**What the role executes:**
- **Installed from commit bytes (fresh by construction):** `gsup.mjs`; `measured-control.mjs` (plan, and the front:
  `node /opt/metal/measured-control.mjs serve`, which serves the new `/chain-verifier` route,
  `CHAIN_VERIFIER_ROUTE`/`checkVerifierRequest`); `chain-verifier.mjs`; the `network/rpc-runtime-main.mjs` closure; the
  supervisor closure.
- **Committed generated bundles the image also installs:**

| bundle | how loaded | role in a verifier-only boot |
|---|---|---|
| `metal/guest/host-policy.bundle.mjs` | static import, `gsup.mjs:19` | **executed on every boot** |
| `metal/guest/lease-gas-conduit.bundle.mjs` | static import, `gsup.mjs:20` | **executed on every boot** (leaseGas refused, but the module loads) |
| `windows/node/host-admission.bundle.mjs` | APP_FILES (supervisor) | **loaded by the supervisor** |
| `metal/guest/platform-api.bundle.mjs` (+ sidecars) | started only with a bound platformApi (`gsup.mjs:465-468`) | **dormant** (refused by the verifier-only rules) |
| `metal/guest/mcp-server.bundle.mjs` (+ runtime files) | started only with a bound mcp | **dormant** (refused) |

## Source parity of those bundles: the BLOCKER

**Method** (`tools/p1-parity.py`, `tools/p2-rebuild.sh`, `tools/p2-nm-match.py`; logs `logs/attimg-p2.*`, queue 1024,
peak 436 MiB):
1. Every hashed input in each committed manifest is compared with the blob at the commit, following git symlinks as a
   bundler reads them.
2. Every recorded `node_modules` input is matched against the linked installs.
3. Each builder is run on a `git archive` export with those exact dependency bytes, and the rebuilt bytes are compared
   with the committed ones.

**Method calibration (parent `9fa02e1bc`):** host-policy, host-admission, lease-gas-conduit and mcp-server rebuild
**byte-identical** to the committed files, and their manifests are identical. Platform-api differs only in its untracked
generated input `relay/network-runtime.bundle.mjs`. That is a pre-existing provenance gap (rebuilt `92ab4c76` vs recorded
`b4c402fe`), present at the parent too.

**Dependency parity:**

| install | recorded inputs matched |
|---|---|
| `control-source/node_modules` | 411/411, 418/418, 1233/1233 |
| `app-lease-gas/control-cv-main/relay/node_modules` | 1687/1687, 1211/1211 |

0 differ, 0 missing, for every manifest.

**At `e0dfe98aa`, every installed bundle is STALE in its real bytes:**

| bundle | committed → rebuilt (sha256) | stale inputs (introduced by e0dfe98aa; none stale at the parent) |
|---|---|---|
| host-policy (**executed**) | `9a6aa25a…` → `ef2c2772…` (35337 → 35471 B) | (no manifest; builder `--check` refuses) |
| lease-gas-conduit (**executed**) | `48bd059a…` → `f88f2dc9…` | `network/rpc-identity.mjs` |
| host-admission (**supervisor**) | `efaf6fdb…` → `91d7b852…` (402503 → 402984 B) | (no manifest; builder `--check` refuses) |
| platform-api (dormant) | `ae9d88db…` → `238a45db…` | `chain-verifier.mjs`, `measured-control.mjs`, `rpc-identity.mjs`, `verified-chain.mjs`, + new `attested-verifier-brand.mjs`, + regenerated network-runtime bundle |
| mcp-server (dormant) | `94e10fe5…` → `36bce583…` | `lease-reader.mjs`, `rpc-identity.mjs`, `verified-chain.mjs`, + new `attested-verifier-brand.mjs` |

Every builder's own `--check` refuses at `e0dfe98aa` (`logs/attimg-p2.out`).

## Minimal patch for root review (NOT applied to any tree, NOT committed)

- **Patch:** `attested-image-stage/receipts/e0dfe98aa-bundles-regenerated.patch`, sha256
  `a2c522ee18add6227b683d40e8018cb4ef72a15ff3cd47a73ac3d46b65f68d21`, 1 645 347 B, binary git diff.
- **Scope:** exactly 8 files, with no source change: the 5 bundles above plus the 3 manifests. Per-file sha256 is in
  `receipts/e0dfe98aa-bundles-regenerated.sha256` (rebuilt files in `receipts/p2-rebuilt-e0/`).
- **Applies cleanly** on `e0dfe98aa` (`git apply --check` on clone B, which stayed clean).
- **Reproducible:** two independent exports (from clone A and from clone B) gave byte-identical results for all 8 files
  and for the generated `relay/network-runtime.bundle.mjs` (`cba503db…`) (`logs/attimg-p3.*`, peak 437 MiB).
- **Regeneration commands** (at the commit, with the dependency roots above):
  1. `node relay/build-network.mjs relay/network-runtime.bundle.mjs`
  2. `node scripts/build-metal-lease-gas.mjs`
  3. `node scripts/build-platform-api-guest-bundle.mjs`
  4. `node scripts/build-mcp-guest-bundle.mjs`
  5. `node scripts/build-host-admission.mjs`
- **For root:**
  - Review the bundle behaviour change: the executed host-policy and host-admission bundles now carry the G4 label/brand
    code, and the conduit the G2 `witnessSourceEndpoint`.
  - Commit it as a bundle-only commit on `e0dfe98aa`.
  - The image must then be built from THAT commit. A new commit means a new measurement.

**Dormant platform-API/MCP baseline (explicit inventory, not a pass):** whatever lands, a `--control direct` image always
carries these two bundles. The image measurement does not make a guest verifier-only:
- A launch with a non-verifier-only HOST_DATA config (platformApi/mcp bound) would run them under the same measurement.
- After the patch they embed the reviewed e0dfe98aa modules.
- The platform-API bundle's generated relay-runtime input is not committed. Its provenance is reproducible from the
  commit (A == B) but is not a committed blob.

## Not done (because of the stop)

- No overlay run, no artifact, no measurement, no cpio inspection, no overlay unittest.
- For the post-patch build, set `CHAIN_VERIFIER_INPUTS` so the 2 native-input overlay tests do not skip (the ec56 b1 had
  2 informational skips).

## Next steps after root commits the bundle patch (prepared plan, not run)

1. **c0:** re-clone A and B at the new commit.
2. **p1/p2 must report 0 stale** for all 5 bundles, with builder `--check` passing on both clones.
3. **b1-direct** (queue 1024):
   - pins and calibration (base `b8376e15`, KEPT `ed918e4b`), as in the ec56 b1;
   - overlay unittest with `CHAIN_VERIFIER_INPUTS` set: 0 skips required;
   - `overlay-control-image.py --control direct --chain-verifier-dir "$V" BASE OUT COMMIT` from A, then again from B
     into a second OUT;
   - byte-compare `initramfs.cpio.gz`, `manifest.json` and `cmdline`.
   - The output cmdline must be the base cmdline plus ` metal.control=direct`.
4. **Measurement:** `sev-snp-measure 0.0.13 --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1
   --vmm-type QEMU --ovmf <142589cc…>`, with `--append` = the OUTPUT cmdline (which includes `metal.control=direct`). It
   must differ from `c2442941` and `fe897820`.
5. **v1-direct:** the independent verifier adapted from `image/tools/verify-image-cv.py`. Its expectations change from
   relay mode:
   - `control: direct`;
   - the cmdline token;
   - `platformApiBundle` and `mcpBundle` records equal to the PATCHED bundles' sha256 and sidecars;
   - the measured-control, gsup and chain-verifier bytes equal git at the new commit;
   - natives per the pin table;
   - the dedup/symlink rules from the ec56 verifier.
6. **Activation gates (root):**
   - the trust list must bind the measurement AND the exact verifier-only HOST_DATA config digest (reviewed
     `canonicalDirectConfig`);
   - the real-hardware SNP canary (direct-hardware-canary pattern);
   - **none of the steps above is a hardware attestation.**
