# Image closure recipe: the Linux relay-mode image carrying the local chain verifier (NOT BUILT)

Per the task, no full image was built while the source composition settles. Everything below names exact,
immutable inputs. The install set it produces was computed without building
(`receipts/image-inputs-<commit>.json`, `tools/image-inputs.py`; RESULT.md §4).

It follows D's reviewed procedure (`linux-runtime-release/RECIPE.md`: s1 compose → t1 tests → b1 build → v1 verify →
s2 scan), with three substitutions:
1. the source commit;
2. `--chain-verifier-dir`;
3. the build allocation.

Run every step through `work/claude-test-queue.py`, inside `unshare -r -n`.

## Inputs (exact)

| input | identity |
|---|---|
| Source commit | **`927e2acfb`** on branch `linux-rpc-runtime-launch` of `linux-rpc-runtime-launch/repo` (full id and tree in RESULT.md §1). It descends from fad657bc → D's fec43a6a → 493ee9ee |
| Overlay tool | `metal/overlay-control-image.py` **at that commit** (its sha256 is recorded in the install-set receipt). It adds `--chain-verifier-dir` to D's 1067a535 and is otherwise the same procedure |
| Production base image | `/home/steven/enclave-prod/dist-sdshield-2857356cd`: initramfs `516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc`, vmlinuz `1a3a02d5…`, MEASUREMENT `b8376e15…`. Debian 12, glibc 2.36, node v20.20.2, `/usr/bin/flock` 2.38.1, no curl |
| Chain verifier native inputs | `linux-rpc-runtime-launch/chain-verifier-inputs/` (flat; `PINS.sha256`). The digests equal `metal/chain-verifier-image.json` at the commit, and the overlay refuses anything else (see the table below) |
| Calibration | as D: the same measurement command must reproduce `b8376e15` (base) and `ed918e4b` (KEPT production) |
| OVMF | `~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd` = `142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9` |
| Measurement tool | `~/.local/bin/sev-snp-measure` 0.0.13: `--mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU` |

Chain verifier native inputs:

| file → image path | sha256 | mode | origin |
|---|---|---|---|
| `enclave-base-head-listener` → `/opt/rpc-runtime/enclave-base-head-listener` | `9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3` | 0555 | release listener; `rpc-runtime-final-integration/bin-release` (built there, closure `scripts/rpc-runtime/closure.json`) |
| `helios` → `/opt/rpc-runtime/helios` | `cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0` | 0555 | `rpc-runtime-final-integration/bin/helios-eeffcc9` (debug profile; NOT rebuilt) |
| `witness-check` → `/opt/rpc-runtime/witness-check` | `4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411` | 0555 | helper 4fe0cd3b, `rpc-runtime-final-integration/bin` |
| `ld-linux-x86-64.so.2` → `/opt/rpc-runtime/glibc/` | `f5e11cc62f8f2c24dff532982559f4303dba3b17e7450551372a88c8e7ea8757` | 0555 | build host: Arch glibc 2.44+r50+g1848099f063e-1 |
| `libc.so.6` | `02c8c3d06180beee9c7d0392aa85736c7d19f274a81e7f8f0b3d9e28e0641524` | 0444 | same package |
| `libm.so.6` | `965106704753eefe8c31ae7da6daba3ead3d18c52b19b5fcc41178bcc4aa999d` | 0444 | same package |
| `libgcc_s.so.1` | `e618cb9c90c2eb3a1dad1cfea5b6c1eebcf2e799ad805976f4ae47bdd61c716a` | 0444 | gcc-libs 16.2.1+r23+gd564253eb6c8-1 |

The overlay also installs:
- `/opt/rpc-runtime/IMAGE.json` (the committed `metal/chain-verifier-image.json`);
- `/opt/metal/chain-verifier.mjs`;
- the runtime's import closure under `/app/network`.

New directories are written 0755 root:root.

## Steps

1. **s1 (512): compose and precheck.** Make a `--local --no-hardlinks` clone of `linux-rpc-runtime-launch/repo` and
   check out the commit (no `git am` is needed: the commit is final). Then:
   `python3 -I tools/image-inputs.py <clone> <commit> <chain-verifier-inputs> receipts/inputs-precheck.json`.
   It must report `ok: true`, and `nativeCollisions`, `nonRegularTargets` and `doMirrorLiterals` must all be empty.
   It reads ~230 MB of native files, so use **512, not 256**: it was guard-stopped at 259 MiB under 256.
2. **t1 (≤1408): tests at that commit,** as RESULT.md §3, including `test/chain-verifier-guest.e2e.test.mjs` with
   `GUEST_ROOTFS` (the extracted base rootfs) and the 2935 genesis.
3. **b1 (1024): build.**
   - Calibration as D: reproduce b8376e15 and ed918e4b.
   - Recompute the install set; it must equal s1.
   - Then build and measure:
   ```
   python3 <clone>/metal/overlay-control-image.py --chain-verifier-dir <chain-verifier-inputs> \
     /home/steven/enclave-prod/dist-sdshield-2857356cd image/dist-linux-<commit9> <commit>
   sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU \
     --ovmf ~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd \
     --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app" \
     --kernel image/dist-linux-<commit9>/vmlinuz --initrd image/dist-linux-<commit9>/initramfs.cpio.gz --output-format hex
   git -C <clone> archive --format=tar -o image/release-<commit9>.tar <commit>   # the host launcher's release tree
   ```
   - Memory: the overlay keeps the ~234 MB native files in memory. D's b1 peaked at 301 MiB without them, and the
     overlay unittest with them peaked at 500 MiB, so use 1024.
   - **No `--control direct`:** the launcher refuses `chainVerifier` for a direct guest.
4. **v1 (768): separate verify job.**
   - Measurement B is recomputed from the artifacts and must equal A.
   - D's `verify-image-relay.py` checks are extended with:
     - `manifest.json controlOverlay.chainVerifier.installed == true`;
     - each `/opt/rpc-runtime` entry's digest and mode as in the table above;
     - `/opt/rpc-runtime/IMAGE.json` == the commit's `metal/chain-verifier-image.json`.
5. **s2 (256): scan** (gitleaks over the receipts and logs), as D.

The overlay writes gzip with mtime 0 and copies committed bytes. **Any other commit gives a different measurement**,
because the commit id is in the initramfs `manifest.json`.

## What the image costs and does not do

- **Guest RAM:** the ramfs holds about **+234 MB** for every guest booted from this image, opted in or not.
  - That is the listener 76 MB, Helios 125 MB, the helper 30 MB and the glibc runtime 3.9 MB.
  - An opted-in guest uses about **+234 MB more** while the verifier runs. Its staging is `copy`: the files are copied
    into a 0700 run directory on the `/mnt/ramdisk` tmpfs and hashed there.
  - `verify-in-place`, which would avoid that copy, cannot hold on this base. 29027 of its 29040 entries (`/`, `/opt`,
    `/app`, `/usr` included) are uid/gid 1000 (`node`), and the runtime requires root-owned ancestors.
    `receipts/base-owners.json` has the facts. A base built with root ownership could switch the image record to
    verify-in-place; `tools/image-inputs.py` gates that on the real owners.
  - An image built **without** `--chain-verifier-dir` (same commit, so a different measurement) carries only the
    JavaScript. Its `chainVerifier.installed` is false, and an opt-in on it refuses in the guest.
  - Root decides whether every Linux host carries the verifier image or only opted-in hosts get that measurement.
- **Debug profiles:** Helios and the helper are DEBUG builds (the release Helios build exceeded 1536 MiB, and was not
  repeated, per the task).
- **No S3/Sia archive in the guest:** there is no curl, so `witnessArchive` is refused there. There is no local cache
  either.
