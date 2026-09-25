> **SUPERSEDED by 31d117a9 (d1a38994), 2026-09-25.** enclave-d1's sign-off of this image diff came with one
> should-fix (the app proxy logged request paths to the host-visible console), fixed in d1a38994. Do not install
> or pin bca562cc. See `../production-release-d1a38994/`.

# Production domain release bca562cc (image commit aff21c73), 2026-09-25

**Release id: `bca562ccf9039e155bebe5bc85579cca913367d53d4c549bd3ed92398db865da`** (= sha256 of `release.json`,
which is canonical; `release-manifest.py verify <dir> --expect <id>` checks it). Format enclave-m4a-domain-release/1,
cmdline `console=ttyS0 rdinit=/init loglevel=3`, measure snp / QEMU / family 26 model 2 stepping 1.

Built on warden-host at 19:05:55Z by `isolation/m4/domain-release.sh`, in a clean worktree detached at aff21c73 (no
local changes, GOFLAGS and ISOLATION_LAB_FRONT unset), go1.27.0-X:nodwarf5. The artifact is
`~/enclave-bench/prod-release-aff21c73/release-aff21c73` (read-only). It is NOT installed, pinned by any relay, or run
by any guest.

## Why this commit
Codex (2026-09-25): build from the final reviewed image-affecting commit, with the ONE production release key and no
standby key.
- The image-affecting tree was frozen at 5ce7ced6 for the release labs (phase 1 and 2 PASS, independently confirmed by
  enclave-d1).
- The only image-affecting change since then is aff21c73. It pins the relay release key generated on nan at 18:38:21Z
  (enclave-63, S3b): d6c8a959…, keyId 06212e5df9c3779a. enclave-99 APPROVED it.

## Checked
- **Reproducible.** A second build in a separate clean worktree with a COLD Go cache gave the same id, and every file
  was byte-identical (`diff -r`).
- **A production front.** `go version -m template/front` shows no build tags (no releaselab). The binary contains
  `api.enclave.host` and the pinned key's hex. It contains none of the lab relay name, the lab endpoint name, the
  `.enclave.test` domain or the lab release key.
- **Against the lab release 6d18f7ad (5ce7ced6):** only `template/front` differs, which is the pins. The init, runtime
  set, modules, kernel and firmware are byte-identical.
- **Against the live release 5c3561f9 (0181bce3, `~/enclave-prod/release-0181bce3`):** `template/front` and
  `template/init` differ, which is the reviewed release path (the front's provisioning and dominit's fd-3 config
  handoff). The kernel, firmware, runtime set (wasmtime, glibc, libgcc_s, runtime.json) and guest modules are
  byte-identical, so the third-party components and their corresponding sources are unchanged from 0181bce3.
- **The kernel and firmware** equal the host's `/boot/vmlinuz-linux` (1a3a02d5…) and the VERIFYING OVMF pinned in
  `verifying-firmware.txt` (142589cc…).

## One app's measurement under it
Per-app, from this release and the app's bundle: `expected-measurement.sh --pin bca562cc… <release> <bundle> 1`.
- Bundle: phase 2's derived bundle for catalog api-mcp-adapter 1.0.0 (AppID
  94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2, record bc1ac3be…, 1 vCPU).
- runtime_id: ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8
- **measurement: 30e6fa288b80dcc24b844faa6dea3adcdd406f7398efa7bd60fbccd2fcd7f064a33e03a43abd5f829a4e5f453e0695a2**

The relay's predictor computes every deployment's measurement from the chain. This line is a cross-check, not a pin.

## Rollback
The live release 5c3561f9… (0181bce3) stays installed and pinned beside this one. Guests on the current image keep
their current measurement until they are relaunched on this one (the 4e order in GUEST-POOL-ROLLOUT.md).

Files: `release.json` (the manifest itself) and `files.txt` (sha256, size, path).
