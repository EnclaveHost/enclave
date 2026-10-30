# Production RPC control image from ec56a70f1: built and independently verified (NOT deployed)

Date: 2026-10-25.

- **Status:** BUILD-OK and VERIFY-OK.
- **What was not done:** nothing was deployed, started, SSHed or committed. There were no live-service reads or mutations
  and no private config or key reads.
- **Recipe:** `work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/RECIPE-IMAGE.md`, sha256 `1d05d1d5…`.
  - Relay mode: no `--control`.
  - `--chain-verifier-dir` points at the existing `chain-verifier-inputs`.
- **Queue:** every step ran through `work/claude-test-queue.py` inside `unshare -r -n`.
  - The job's namespace was proved to have loopback only and no route.
  - ssh/scp/sftp were denied by stubs: 0 invocations.
  - The 16 GiB floor was preserved and the guard was never bypassed.
  - s1 was deferred 5 times (`test allocation held` by the other Claude's 1408 job) and then waited normally.

## Artifacts (`work/rpc-production-final-20261025/image/`)

| artifact | sha256 | bytes |
|---|---|---|
| `dist-linux-ec56a70f1/initramfs.cpio.gz` | `7848676bf806ee03ca27634ac48481d6d48d6c6d002642c87278c4d5e3ada34c` | 319904918 |
| `dist-linux-ec56a70f1/vmlinuz` (== production base) | `1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7` | 17232384 |
| `dist-linux-ec56a70f1/manifest.json` | `2ba70ceab25ae5ebadc8c17013de5e0eacf86f777ef25ea2675220fd495fea80` | 34955 |
| `dist-linux-ec56a70f1/cmdline` (== base cmdline) | `d9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8` | 105 |
| `dist-linux-ec56a70f1/MEASUREMENT` | `335a78b00de1266830088db43046d1ef0323b5025e29eecae4d64366e9ae8a1f` | 97 |
| `release-ec56a70f1.tar` (host launcher release tree = `git archive ec56a70f1`, deterministic on a second pass) | `8af4ce97b7b1d867d5a3f2aed261dffd199229a68be9f413bfdc90f920341ca3` | 171878400 |

**SNP measurement:**

```
c24429415c85fca9d55cd9ba9b6f2337579d59c6ea2f2bd66656302ac0f96afd0193534f1ac38c3882b32acf9c0744f7
```

- **A (build job):** equals B.
- **B (separate verify job):** recomputed from the artifacts on disk, with the cmdline taken from the artifact's own
  `cmdline` file.
- **Tool:** `~/.local/bin/sev-snp-measure` 0.0.13 with `--mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU`.
- **OVMF:** `OVMF.amdsev.fd` = `142589cc…f4f8a9`, pinned.
- **Append:** `console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app`.

## Inputs

- **Source:** `ec56a70f143cf1bb6bbdd52228401bcf24eca05b`, tree `fd45bf5da82475033f2abcc586b7e21fc36ded04`.
  - It was built from a `--local --no-hardlinks` clone (`image/src`) of `linux-rpc-consumer-closure-20261023/repo`; the
    control-source worktree's git dir lives there.
  - The clone tree equals control-source's HEAD tree. The clone stayed clean through every step.
  - The control-source working tree and the other Claude's processes were not touched.
  - It descends from the recipe's 927e2acfb. `metal/overlay-control-image.py` (sha256 `10db3d3d…c31e`) and
    `metal/chain-verifier-image.json` (sha256 `23ac96ad…e964`) are unchanged since then.
- **Production base:** `/home/steven/enclave-prod/dist-sdshield-2857356cd`.
  - manifest `cc2571bb…`, initramfs `516d766d…`, vmlinuz `1a3a02d5…`: all pinned and OK.
- **Natives:** `chain-verifier-inputs/PINS.sha256` verifies (`b626c161…`). `tools/image-inputs.py` is `40371e0d…`.

## Steps and results

### s1 (512): precheck — PASS

- Log: `logs/image-s1.*`. Guard peak 270 MiB.
- `image-inputs.py` reports ok: 66 committed inputs + 8 native (7 binaries/libs + IMAGE.json).
- `nativeCollisions`, `nonRegularTargets` and `doMirrorLiterals` are all empty. Staging is `copy`.
- host-admission bundle `efaf6fdb…`, host-policy bundle `9a6aa25a…`.

### b1 (1024): build — PASS

- Log: `logs/image-b1.*`. Guard peak 430 MiB.
- **Calibration:** the same command reproduced production base `b8376e15f7f94f9b…c35d` and KEPT production `ed918e4b393699b3…2ac2`.
- **Install set:** recomputed, and equal to s1 (`inputs-build.json` is byte-identical to `inputs-precheck.json`,
  `344f7bfa…`).
- **Overlay unittest:** `test/metal-control-overlay.test.py` at the commit gave 19 tests, OK, 2 skipped. The 2 skips need
  `CHAIN_VERIFIER_INPUTS`, which was not set (informational only).

### v1 (1024): independent verify — PASS

- Log: `logs/image-v1.*`. Guard peak 334 MiB. Receipt `image-verify.json` = `5704b5d0…`.
- 39/39 checks pass. Earlier attempts are kept as `logs/attempt1-image-v1.*` and `logs/attempt2-image-v1.*`; see the
  next section.

**How the verifier is independent:**
- `tools/verify-image-cv.py` parses the newc cpio with its own reader, not the overlay's `entries()`.
- Every installed committed file is compared with `git cat-file` at ec56a70f1, read by the verifier itself.
- The natives are compared against the RECIPE table hardcoded in the verifier, AND `PINS.sha256`, AND the commit's
  `chain-verifier-image.json`.

**Kernel, manifest and base:**
- vmlinuz, the kernel/modules records and the cmdline equal the base. There is no control/platformApi/mcp record.
- `controlOverlay.commit` = ec56a70f1, `builderSha256` = the commit's overlay tool, and the base initramfs is `516d766d`.
- The base controlOverlay is the last history entry, and `expectedMeasurement` is removed.

**Installed files:**
- **Chain verifier record:** `controlOverlay.chainVerifier.installed == true`.
- **Committed inputs:** all 66 are present, regular, nlink 1 and not group/other-writable. Their bytes equal git at
  ec56a70f1. Modes/owners: 50 are 0644 root:root (new files) and 16 are 0644 1000:1000 (they replace base entries and
  keep the base metadata; 0 metadata changes).
- **Natives:** all 7 `/opt/rpc-runtime` files match the RECIPE table:

  | file | mode | owner |
  |---|---|---|
  | listener `9ca75047` | 0555 | root:root |
  | helios `cc962e2b` | 0555 | root:root |
  | witness-check `4fe0cd3b` | 0555 | root:root |
  | ld-linux `f5e11cc6` | 0555 | root:root |
  | libc `02c8c3d0` | 0444 | root:root |
  | libm `96510670` | 0444 | root:root |
  | libgcc_s `e618cb9c` | 0444 | root:root |

  The extracted bytes were re-hashed.
- **`/opt/rpc-runtime` contents:** exactly those 7 files, IMAGE.json and 2 directories.
  `/opt/rpc-runtime/IMAGE.json` equals the commit's `metal/chain-verifier-image.json`, and
  `/opt/metal/chain-verifier.mjs` equals the commit's.
- **New directories:** 14, all 0755 root:root.

**Every other entry:**
- No base entry is missing. The image has 29101 entries against the base's 29029; 72 were added (58 files + 14 dirs).
- All 29012 other entries are identical to the base in bytes, mode, uid, gid, nlink, mtime and rdev.
- The in-image `opt/metal/manifest.json` names the commit.

**Runtime closure:**
- The supervisor closure (48 files) and the chain-verifier runtime closure from `network/rpc-runtime-main.mjs` (9 files)
  are present, and equal to git.
- Their npm packages are in the image: cors 2.8.6, express 4.22.2, jose 5.10.0, viem 2.53.1, ws 8.21.1.
- The guest helpers' relative imports and the bundles' beside-itself reads resolve.
- gsup.mjs equals the commit's, references the chain verifier and starts `/app/supervisor.js` in the legacy branch.
- No platform-api/mcp bundle is installed, and no DigitalOcean mirror literal is in any input.

**Import and syntax checks (run under the loopback-only fetch guard):**
- D's import check: 47 closure files, 50 modules imported, 10 `opt/metal` syntax checks. The installed host-admission
  bundle has decision + carriers, and its production default has no mirrors (`import-check.json`).
- `node --check` passes on the 9 runtime closure files, `rpc-runtime-main.mjs` and `chain-verifier.mjs`.

## The two v1 failures before the pass, and why they were not suppressed

Both were defects in my new verifier, not in the image. Each now has a positive proof over the installed bytes.

1. **Symlink sha mismatch (attempt 1).**
   - `relay/net-guard.mjs` is a git symlink (mode 120000, target `../net-guard.mjs`).
   - The overlay installs the target's bytes, by design (`committed()` follows in-repo links). My first comparison hashed
     the link text instead.
   - The verifier now resolves links itself: relative, in-repo, at most 9 hops.
   - The installed `app/relay/net-guard.mjs` is a regular 0644 root:root file, `d61c6d64…`. That equals `net-guard.mjs`
     at ec56a70f1, so it is not the link text.
2. **Duplicate cpio entries (attempts 1 and 2).**
   - The production base archive itself repeats two paths:
     - `app/session-api-auth.mjs` appears 10 times, all with 1 distinct content;
     - `app/verification-checkpoints.mjs` appears 2 times, with 1 distinct content.
   - The image has each of them once, and it has no duplicate at all.
   - Extraction semantics: the kernel's initramfs unpacker (`init/initramfs.c` `do_name`) keeps the LAST occurrence. It
     does `clean_path`, opens with O_TRUNC and `vfs_truncate`, then applies fchown/fchmod/utime from the later header.
   - Proof: for each path, the single image entry equals the base's last occurrence in sha256, mode, uid, gid, nlink,
     mtime and size. The extracted bytes were re-hashed. Since every occurrence has identical content, the installed
     bytes are the same under any occurrence order.
   - Image hashes: session-api-auth `f7bfbc56…8d29`, verification-checkpoints `aa69b54d…ff29`.
   - The per-occurrence evidence is in `image-verify.json` → `duplicateProof`.

The `/opt/rpc-runtime` directory-set FAIL in attempt 2 was a filter bug in my verifier: it excluded the directory entry
itself. That directory is present, 0755 root:root.

## Limitations / not done

- **Deployment:** none. Root owns activation.
  - The measurement `c2442941…` is new: it is not on any allowlist or host.
  - Any other commit, including later test-only commits from the other Claude, gives a different measurement, because
    the commit id is in the initramfs manifest.
- **Recipe t1 (tests at the commit):** not run here. Foundry/E2E coverage belongs to the other Claude. The only test run
  here was the overlay unittest: 2 skips, chain-verifier-input cases.
- **Recipe s2 (gitleaks over receipts/logs):** not run, to keep scope to final verification.
- **Not measured on hardware:** no guest was booted, and the measurement was not compared against a real SNP report.
- **Rebuild reproducibility:** not shown for this commit (one build). Only A == B for the measurement, and the second
  `git archive` pass, were shown.
- **Native binaries:** Helios and witness-check are DEBUG builds, as the recipe documents.
- **Guest RAM:** about +234 MB of ramfs per guest, plus about +234 MB of tmpfs while an opted-in verifier runs (copy
  staging; the base `/`, `/opt` and `/app` are uid 1000).
- **No in-guest witness archive:** there is no curl in the guest.

## Receipts (`outputs/rpc-production-final-20261025/image/`)

- `artifacts-A.sha256`
- `measurement-B.txt`
- `release-tar.sha256`
- `inputs-precheck.json`
- `inputs-build.json`
- `image-verify.json`
- `import-check.json`
- `runtime-syntax.txt`
- `overlay-unittest.out`
- `tool-pins.sha256`
- `build-started.utc` / `build-finished.utc`

The tools are in `work/rpc-production-final-20261025/image/tools/`: `env.sh`, `q.sh`, `s1.sh`, `b1.sh`, `v1.sh`,
`verify-image-cv.py`, and D's `import-check-relay.mjs` and `bundle-api.mjs`.
