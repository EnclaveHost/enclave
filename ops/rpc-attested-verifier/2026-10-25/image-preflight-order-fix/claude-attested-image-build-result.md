# Verifier-only direct-control image at b42d6b3e7: STOPPED before the overlay build (concrete defect in MY earlier patch)

Status: **NO IMAGE BUILT.**
- The executed bundles at `b42d6b3e7` are verified current.
- The two dormant bundles that every direct image carries (platform-api, mcp-server) are still stale. Cause: **my preflight
  patch regenerated them in the wrong order** (`attested-image-stage/tools/p2-rebuild.sh` and `p3-patch.sh` ran the
  host-admission builder LAST, but both of those bundles embed its output).
- An image now would carry dormant code that is not the reviewed source, under a measurement that the needed corrective
  commit would immediately supersede. So this is a stop, with a corrected, verified 4-file patch for root.

**History:** the preflight report `logs/claude-attested-image-result.md` is unchanged.

**Not done:** no SSH, live access, keys, VMs, measured-allowlist change, other-worktree writes, commit or push.
- Every job ran through `work/claude-test-queue.py` at 1024 inside `unshare -r -n`, with loopback only and no route
  proved each time.
- Stub ssh/scp/sftp: 0 invocations. Peaks ≤ 900 MiB. No native rebuild, and no new NVMe cache.

## 1. b42d6b3e7 is exactly the reviewed patch (verified from objects, not the label)

- **Commit:** `b42d6b3e79bfe3cc3bcc391bf6193a3032f59a6f`, tree `2c11463597fee55b61434d2aecf747a5117b456f`, parent
  `e0dfe98aa4536976394bf6f2f16c670f0b95ea7c`.
- **`git diff e0dfe98aa b42d6b3e7`:** exactly the 8 bundle and manifest files plus 5 files under
  `ops/.../image-preflight/`. **No source module changed.**
- **All 8 committed files equal the reviewed patch's sha256 byte for byte** (`receipts/e0dfe98aa-bundles-regenerated.sha256`).

## 2. Fresh independent clones (`logs/attimg2-c0.*`, peak 900 MiB)

- A (`src2-a`): `--local --no-hardlinks` from the shared repository.
- B (`src2-b`): a full `--no-local` clone of A, with no alternates.
- Both are at `b42d6b3e7`, same tree, clean.

## 3. Bundle source parity at b42d6b3e7 (`logs/attimg2-p2.*`, `logs/attimg2-p4.*`)

**Dependency parity:** every recorded `node_modules` input matches the linked installs. `control-source/node_modules`:
411, 418 and 1233 of 1233; `app-lease-gas/control-cv-main/relay/node_modules`: 1687 and 1211. 0 differ, 0 missing.

| bundle | executed in a verifier-only boot? | rebuilt at b42 == committed | builder `--check` |
|---|---|---|---|
| `metal/guest/host-policy.bundle.mjs` `ef2c2772…` | **yes** (gsup static import) | **yes** | pass |
| `metal/guest/lease-gas-conduit.bundle.mjs` `f88f2dc9…` (+ manifest) | **yes** (gsup static import) | **yes** (manifest identical) | pass |
| `windows/node/host-admission.bundle.mjs` `91d7b852…` | **yes** (supervisor app file) | **yes** | pass |
| `metal/guest/platform-api.bundle.mjs` `238a45db…` | no, dormant | **NO**: embeds the generated relay runtime bundle (recorded `cba503db…`, current `b69c4765…`, which pulls in the new host-admission bundle) | **refuses** |
| `metal/guest/mcp-server.bundle.mjs` `36bce583…` | no, dormant | **NO**: embeds `windows/node/host-admission.bundle.mjs` at its OLD `efaf6fdb…` (current `91d7b852…`) | **refuses** |

**Zero stale *required* bundles: met.** The dormant pair is the defect.

## 4. Corrected follow-up patch (for root review; NOT applied, NOT committed)

- **Patch:** `attested-image-stage/receipts/b42d6b3e7-dormant-bundles-reordered.patch`, sha256
  `396b2eb75129a15cfa89866dcf339de0a05a486343f7242534fb561013e1d7de`.
- **Scope:** exactly 4 files: `platform-api.bundle.mjs` + manifest, `mcp-server.bundle.mjs` + manifest.
- **Produced by `tools/p4-fixpoint.sh`:**
  - **dependency-ordered regeneration:** host-admission (+ host-policy) → lease-gas-conduit →
    `relay/build-network.mjs` → platform-api → mcp;
  - **fixed point:** a second full pass changes nothing;
  - **every builder `--check` passes** after it;
  - **clone A export == clone B export** for all 8 files and the generated relay runtime bundle.
- **It leaves the executed bundles unchanged** (proved per file), and applies cleanly on `b42d6b3e7` (checked on clone B,
  which stayed clean).

| file | new sha256 |
|---|---|
| platform-api | `6dd3f79be4e48f24467fce5bbd6e6ed8281f427aca006f339cad3a5ad7ccdfa7` |
| platform-api manifest | `c4556aaa…` |
| mcp-server | `6b5c52b2c74b328de66698a05beb5d5632f9bc9e570d64f4122c72773d57db6f` |
| mcp-server manifest | `ac37f270…` |

**Regeneration order for any future commit:** `node scripts/build-host-admission.mjs && node scripts/build-metal-lease-gas.mjs
&& node relay/build-network.mjs relay/network-runtime.bundle.mjs && node scripts/build-platform-api-guest-bundle.mjs && node
scripts/build-mcp-guest-bundle.mjs`, then repeat it once to confirm the fixed point.

## 5. The route client bundle remains a matching verifier (`logs/attimg2-e1c.*`; earlier e1/e1b runs explained below)

- **Which bundle:** the route lineage (`attested-route-source` HEAD `d69bc38a6ef9…`, no local edits to the bundle) pins
  image-lineage verification in `network/attested-guest-verify.bundle.mjs` `86a3e099…`, built from image `e0dfe98aa`.
  - Exports: `verifyMeasuredControl`, `canonicalDirectConfig`, `configDigest`, `hostDataHex` and the `/chain-verifier`
    constants.
- **Inputs:** 10 image-tree inputs. 9 are byte-identical at `e0dfe98aa` and `b42d6b3e7`. The 10th, the conduit bundle,
  changed (`48bd059a` → `f88f2dc9`).
  - Its only source cause is `network/rpc-identity.mjs` in `e0dfe98aa`, which **only adds** `witnessSourceEndpoint`.
    `rpcEndpoint`, `rpcLabel` and every existing function are untouched (`git diff 9fa02e1bc e0dfe98aa`).
- **Calibration:** a rebuild from a pristine `e0dfe98aa` export reproduces the COMMITTED route bundle byte for byte. Route
  dependencies: 411/411 recorded inputs match.
- **Rebuild from `b42d6b3e7`:** `8f8eae8e…`, 6 changed code lines besides the banner, all inside the embedded conduit.
- **Behavioural equivalence** (committed `86a3e099` vs `b42` rebuild), using the reviewed fixtures with a fixed operator:
  - **10/10 identical, non-vacuous:** the reviewed verifier-only config is ACCEPTED with the same hostData (`11afca86…`).
    So are the plain-verifier and no-verifier configs.
  - Each refusal refuses for its own reason, and identically: expose public; txBackend; verifier-only plus
    platformApi/mcp/leaseGas; a malformed leaseGas through the conduit's `checkTransit`; a public http proof source.
  - Identical: `CHAIN_VERIFIER_ROUTE`, `MAX_VERIFIER_ANSWER_BYTES`, the 14 read methods, and the `verifyMeasuredControl`
    source text.
- **Earlier runs, not counted as passes:**
  - e1: VACUOUS. Wrong config format string in my fixture, so every case refused at the format check.
  - e1b: a false-positive vacuity flag from my own regex.
- **Conclusion:** the committed route bundle is behaviourally a matching verifier for the new image. Its manifest still
  names `imageCommit e0dfe98aa` and the old conduit hash, so the route builder's `--check` against the final image would
  refuse. Refreshing it to the final image commit is root's choice (`receipts/rebuilt-b42.bundle.mjs` `8f8eae8e`,
  manifest `5adaffe0`, for reference). The dormant fix (§4) touches none of its inputs.

## 6. Unchanged pins (re-checked)

- **Natives:** `metal/chain-verifier-image.json` blob `ba48eac7`, and `chain-verifier-inputs/PINS.sha256` verify. This is
  their pinned bytes only; **their provenance from source is separately gated**, and nothing here establishes a
  reproducible native build.
- **Overlay tool:** `metal/overlay-control-image.py` blob `a7c41de8` (sha256 `10db3d3d…`), identical to the reviewed ec56
  build.
- **Base and OVMF:** base `dist-sdshield-2857356cd` (`cc2571bb` / `516d766d` / `1a3a02d5`); OVMF `142589cc…`.

## 7. Next (unchanged plan, ready once root commits the 4-file patch)

1. Re-clone A and B at the new commit.
2. Gates: `p2` all 5 rebuilt == committed, `p4` fixed point and every `--check` passing.
3. Build:
   - overlay unittest with `CHAIN_VERIFIER_INPUTS` set (0 skips required);
   - `overlay-control-image.py --control direct --chain-verifier-dir $V $BASE $OUT $COMMIT` from A and from B;
   - byte-compare the outputs; the cmdline must be the base cmdline plus ` metal.control=direct`.
4. Measure: `sev-snp-measure 0.0.13`, 4 vCPU, family 26 / model 2 / stepping 1, OVMF `142589cc`, with the OUTPUT cmdline.
5. Independent direct-mode verification of the cpio and inputs.
6. **Activation gates:**
   - the trust list binds the measurement AND the verifier-only config digest;
   - the dormant platform-API/MCP bundles stay off only because the reviewed verifier-only config refuses those members;
   - real-hardware SNP canary. **No step here is a hardware attestation.**
