# Native-control measured image: local build from 493ee9ee (2026-10-22)

**Status: built and verified locally, reproduced byte-for-byte, re-measured.** It is not deployed or activated, no hardware
has verified it, and no host has booted it. Root still owns the hardware canary.

## Source
- Commit `493ee9ee07497c94159ec4f6916e9ea920d31959`, tree `b21163723ea789db13ff84d148e309e2709a89f4`, parent `95defc2cd`.
  - Author and committer: SteveDeFacto, 2026-10-22T15:20:18-07:00.
  - Subject: "Rebuild the combined native platform API guest bundle".
- **Where it came from.** The local checkpoint repo `native-front-abort/repo`, branch `work/native-front-abort`.
  - The repo was only read: `git clone --local --no-hardlinks` copied its object files.
  - The clone is `src/`: origin removed, branch ref deleted, detached at 493ee9ee, clean before and after every job.
  - I do not claim the candidate branch points at this commit.
- **Commits since the previous image (6f2c7da4).** There are 8, from eaea7e46 to 493ee9ee
  (`public/commits-since-6f2c7da4.txt`), touching 25 paths (`public/source-delta-vs-6f2c7da4.txt`).
- **The source repo moved on during the build**, to `0eac0d60b` (admin CLI AMD collateral) and `dfe020abf` (admin
  status GET).
  - Those commits touch only `docs/network/hosted-platform-api.md`, `scripts/platform-api-admin.mjs` and
    `test/platform-api-admin-cli.test.mjs`. None of them is an image input (post-check), so the image is unaffected.
  - I did not review or test them.
- No source commit was needed or made, and nothing was pushed.

## Inputs (current, not the 6f inputs): `public/INPUT-MANIFEST.json`
- **59 inputs.** The commit's own overlay tool selected them (`metal/overlay-control-image.py` 1067a535, unchanged since
  6f2c7da4). Every sha256 equals the bytes committed at 493ee9ee.
- **Changes against the 6f2c7da4 image:** exactly 3 changed inputs, none added and none removed.
  - `opt/metal/gsup.mjs`: 10127e11 → 07e05839
  - `opt/metal/measured-control.mjs`: f2648d65 → 26a8982c
  - `opt/metal/platform-api.bundle.mjs`: ede48c36 → **0a1d88de230842442c41cc9f399d3a7dda5394fb523812b2503bc2358b09b4ef**
    (8705824 bytes, 2219 inputs, sidecar tpm-roots f72ea29a)
- **Every change is explained by the commit range.** Each changed input's source is in `git diff 6f2c7da4 493ee9ee`, and
  no unchanged input's source is in that diff.
- **Bundle currency** (`public/bundle-currency.json`): every installed bundle is current for 493ee9ee.
  - **platform-api:** all 113 committed inputs match the commit, including the 7 changed native files. The gitignored
    network runtime is the reviewed 8399d143, and its module list names no changed path.
  - **mcp-server eccb3334:** unchanged since 6f2c7da4, and all its repository inputs are current.
  - **lease-gas-conduit 421d6584:** all its repository inputs are current.
  - **host-admission 40e8ba71 and host-policy acfa1b00:** unchanged, and equal to the reviewed pins.
  - **node_modules inputs** are not committed. They are counted, not checked here. The bundle's `--check` was root's
    native-final-build job, and I did not repeat it.
- Supervisor-closure packages come from the base: cors 2.8.6, express 4.22.2, jose 5.10.0, viem 2.53.1, ws 8.21.1.
- `relay/native-discovery.mjs` and `network/native-control-routes.mjs` (discovery side) are not image inputs.

## Pins (the same as the 6f2c7da4 image; all verified before the build)
- **Base `dist-sdshield-2857356cd`:**
  - manifest cc2571bb
  - initramfs 516d766d
  - vmlinuz 1a3a02d5 (7.2.3-arch1-2)
  - measurement b8376e15
- **OVMF:** 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
- **Tool:** sev-snp-measure 0.0.13
- **Calibration:** the same recipe reproduced production b8376e15 and KEPT ed918e4b.

## Image (`image/dist-direct-493ee9ee0`, outside Git; distribute by hash)
| file | bytes | sha256 |
| --- | --- | --- |
| initramfs.cpio.gz | 282205620 | a8a2a40cdcf3d43e1a6dca13a1ab34675fad43cfa27c0daaf05995235c464c53 |
| vmlinuz | 17232384 | 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7 (= base) |
| manifest.json | 31031 | d34294b2b5899025bd0de2f09ed2757e7436ff24255d04bdbe690629f838f894 |
| cmdline | 126 | fd236eb2762c457bbe20376216e078f3aab3f2f40a3646f9509137b8f67fabb6 |
| MEASUREMENT | 97 | 15a1f962b8cbb3eebd4eb2a6b6aeb82f5ec60a918417bddf0fbec2080391a274 |

**Measurement: `fe897820f632bae497511a229f0c74465dade8841d5807f8287a3a2caa928d22c8d79c24ffa9b1f9554434b483fae38f`**
- **Parameters:** SNP, 4 vCPUs, vCPU family 26 / model 2 / stepping 1, QEMU, the pinned OVMF.
- **cmdline:** `console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct`
- **How it was obtained:** A came from the build job. B came from a separate verify job, which re-hashed the artifacts
  and read the cmdline from the artifact itself. The rebuild2 value was measured on its own. All three are identical.
- **This replaces bdadc7bb** (the 6f2c7da4 image) in any trust list meant to admit the native-control image.

## Verification evidence (all through work/claude-test-queue.py)
Each job ran under the 16 GiB floor, inside `unshare -r -n`; `tools/env.sh` proved the namespace has only loopback and no
route. The ssh/scp/sftp-denying stubs were first in PATH, proved for both the shell and a node child, and recorded 0
invocations.

| job | cap | result |
| --- | --- | --- |
| s1-source (r1) | 512 | **exit 99, NOT a pass.** The file:// full-history clone (git pack-objects) reached 543 MiB and the guard stopped it before anything was checked. |
| s1-source-r2 | 512 | exit 0, peak 66 MiB. Clone and identity confirmed, precheck ok, bundle currency ok. |
| build | 1536 | exit 0, peak 304 MiB. Pins and calibration passed; the in-job input recomputation equals the precheck; overlay done; measurement A taken. |
| verify | 1536 | exit 0, peak 205 MiB. Measurement B = A; 26/26 image checks; import check ok. |
| rebuild2 | 1536 | exit 0, peak 303 MiB. A new output dir, **byte-identical in all 5 files**; output A unchanged before and after. |
| post-check | 256 | exit 0, peak 14 MiB. The old 6f2c7da4 image and receipts match their PINS.sha256; the 9 old tools match their receipt hashes; both artifact sets match their receipts; later source commits touch no input. |

**Image checks** (`public/image-verify.json`), all read from the image's own bytes:
- **Kernel and modules.** The kernel, modules list and manifest kernel record are unchanged.
- **Direct mode.** The cmdline and manifest select direct control over snp-guest-per-app. controlOverlay names commit
  493ee9ee and tool 1067a535.
- **Installed inputs.** All 59 installed files are regular files with the expected sha256. The installed platform-api
  bundle is exactly 0a1d88de.
- **Base entries.** None of the 29012 other entries changed from the base (bytes and metadata, all 33 module-tree entries
  included). Only the 43 newly installed inputs and 15 parent directories were added.
- **Supervisor closure.** The 46-file supervisor closure and its npm subpath exports are present in the image.
- **Guest helpers.** Every guest-helper import and every bundle's read of a file beside itself resolves.
- **Startup wiring.** gsup runs the direct branch, and both bundle paths named in measured-control.mjs are installed.

**Import check** (`public/import-check.json`), run with host node under a loopback-only fetch guard:
- All 48 modules imported from the extracted image.
- All 11 `opt/metal` modules passed a syntax check.
- The MCP and platform-api role bundles each reached their own main behind the argv guard (exit 1 on an absent config).

## Published (small, authored or sanitized; local paths become `<build>` / `<work>`)
- `tools/`:
  - Adapted from measured-image-build/tools: `env.sh`, `q.sh`, `s1-source.sh`, `verify-inputs.py`, `build.sh`,
    `verify.sh`, `verify-image.py`, `rebuild2.sh`, and `import-check.mjs` (unchanged copy).
  - New: `bundle-currency.py`, `post-check.sh`.
- `public/`:
  - `BUILD-RECEIPT.json` (hashes of every script, stub and artifact, plus the queue guard lines)
  - `INPUT-MANIFEST.json` and `ACTIVATION-REQUIREMENTS.json`
  - the inputs, bundle-currency, image-verify and import-check receipts
  - the source identity and delta files
  - the artifact sha256 lists
  - sanitized job logs (`log-*.txt`)
- `PINS.sha256` covers RESULT.md, the public files and the tools.
- Not for Git: `image/`, `rawlogs/`, `src/`, `tmp/`. The old measured-image-build image and tools were never written.

## Root activation prerequisites (details and source line refs: `public/ACTIVATION-REQUIREMENTS.json`)
1. **Publication.** Root decides whether to publish or merge 493ee9ee, or a successor that changes no image input, onto
   the candidate branch. A rebuild from any other commit changes the manifest and the measurement.
2. **Admin CLI.** Use the admin CLI from root's reviewed later commit (0eac0d60b+, which adds AMD collateral). Do not
   use 493ee9ee's `scripts/platform-api-admin.mjs`, which passes no collateral at :100.
3. **Owner config and launch.** Each member needs an owner direct config bound by HOST_DATA, including
   `hostAdmissionSha256` and platformApi, and optionally mcp, carriers, leaseGas, ownerNomination and `nativeControl`.
   - Launch with `metal/enclave-metal.mjs`: control "direct", mode snp, cpus 4, the pinned OVMF, snp-guest-per-app with
     release tickets off, and only the control port forwarded.
4. **Trust lists.** Put this measurement into:
   - owner and client expectations
   - `platformApi.measurements[]` in every member
   - hosted-MCP client expectations
   - `NATIVE_CONTROL_MEASUREMENTS`

   Do not add it to the relay allowlist.
5. **Registry.** The original registry registration and setProofKey are the operator's wallet actions, done by root.
6. **Admin policy.** The admin platform host policy stays enforced. Publish the admin-signed policy to real
   non-DigitalOcean carriers before any anchor.
7. **Hardware.** Launch on hardware, then `verifyMeasuredControl` must return "verified" with current AMD collateral, the
   CRL and the minimum TCB. Then accept a new owner deployment. This is root's canary.
8. **Native names (optional).**
   - CA custody: either NATIVE_CA_KEY and NATIVE_CA_CERT in an admin-signed credentials package (group issuer), or the
     offline `scripts/native-control-certificate.mjs` fallback.
   - Deploy the 493ee9ee native discovery with NATIVE_CONTROL_*, where EXCLUDE is the DO IPv4 set.
   - Operators publish kind-9 native-control service-index ads.
   - Until all of that is in place, the names fail closed with 503.
9. **Cutover.** Platform API cutover (genesis plus import, then DNS and WebPKI repointing), the Windows host-admission
   swap 6bef372d → 40e8ba71, and enclave.host DNS repointing.

**Rollback:** KEPT ed918e4b or production b8376e15. The 6f2c7da4 image (bdadc7bb) stays built and verified.

## Limits
- **Local build only.** There was no hardware launch, attestation report or deployment, so there is no claim of hardware
  verification.
- **One tool, one host.** One measurement tool on one host. Reproducibility means a second build on the same host, which
  does not cover toolchain variance across machines. The overlay copies committed bytes and writes gzip with mtime 0.
- **node_modules.** Prebuilt-bundle node_modules inputs are uncommitted. Their currency rests on root's
  native-final-build `--check`.
- **The host-admission and host-policy bundles have no manifest.** They are checked only by pin and by being unchanged
  since 6f2c7da4.
- **This image does not remove DigitalOcean or centralized dependencies.** It is not full decentralization. That depends
  on where the Platform API members, native discovery, DNS, carriers and storage are actually deployed, and none of that
  is done.
- **No source tests were re-run**, as the task required.
