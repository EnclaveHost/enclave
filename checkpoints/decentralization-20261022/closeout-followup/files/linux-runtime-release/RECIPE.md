# Linux runtime release: reproducible recipe (composed D f1d0666b + ROOT 1086cf23 on the reviewed image commit 493ee9ee)

Everything below reads only immutable Git objects and pinned local files. Each step ran in this directory through
`work/claude-test-queue.py` (`tools/q.sh MIB NAME CMD`), inside `unshare -r -n` (loopback only, no route; proved by
`tools/env.sh`), with ssh/scp/sftp-denying stubs first in PATH (0 invocations).

## Inputs (exact)

| Input | Identity |
|---|---|
| Image base commit | `493ee9ee07497c94159ec4f6916e9ea920d31959` (tree `b21163723ea789db13ff84d148e309e2709a89f4`), branch `work/native-front-abort` of `native-front-abort/repo`. This is the commit of the reviewed, built and reproduced native image fe897820 (`native-final-image`). It is `main 7752a423` plus 9 reviewed composition commits (6f2c7da4..493ee9ee) |
| D + ROOT commits | `2bbea8987ddc3d127c15e9709b5db2f867eae30d..1086cf2346b913177e38cf02e0b2b571628cc758` in `linux-adopt-stop-review` (= D `09ff3ed5`, `b744ba19`, `f1d0666b` + ROOT `1086cf23`), exported with `git format-patch --full-index --no-renames --no-signature` (`patches/`, sha256 in `receipts/patches.sha256`) |
| Overlay tool | `metal/overlay-control-image.py` at the composed commit = `1067a535…` (unchanged since 6f2c7da4) |
| Production base image | `/home/steven/enclave-prod/dist-sdshield-2857356cd`: manifest `cc2571bb…`, initramfs `516d766d…`, vmlinuz `1a3a02d5…` (7.2.3-arch1-2), MEASUREMENT `b8376e15…` |
| Calibration image | KEPT production Linux runtime `dist-leasegas-deabf8f90` (staged copy `work/linux-post-adoption-release/stage/…`, byte-equal to the `enclave-prod` copy): initramfs `c190c040…`, MEASUREMENT `ed918e4b…` |
| OVMF | `~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd` = `142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9` |
| Measurement tool | `~/.local/bin/sev-snp-measure` 0.0.13: `--mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU` |
| Test dependencies | the D candidate's installed `node_modules` (root, network, relay), symlinked into a throwaway clone; their package.json / package-lock.json are byte-identical at 2bbea898 and 493ee9ee (checked in t1) |

## Steps

1. **s1 compose (512)** `tools/s1-compose.sh`
   ```
   git clone --local --no-hardlinks --no-tags --single-branch --branch work/native-front-abort --no-checkout <native-front-abort/repo> src
   git -C src checkout --detach 493ee9ee07497c94159ec4f6916e9ea920d31959
   git -C <linux-adopt-stop-review> format-patch -q --full-index --no-renames --no-signature -o patches 2bbea8987ddc…..1086cf2346b9…
   GIT_COMMITTER_NAME=SteveDeFacto GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com \
     git -C src -c core.hooksPath=/dev/null am -q --no-3way --committer-date-is-author-date patches/*.patch
   ```
   This gives **`fec43a6a08da2ac287fb3a5c42de89f096f4f678`**, tree **`13e18b0895e37a7baa5bc9e11ad1fdcf337daac0`**:
   - the four commits keep their authors, messages and author dates;
   - the committer is SteveDeFacto and the committer date equals the author date, so the ids depend only on these inputs.

   Asserted:
   - Every touched file except `supervisor.js` is byte-identical to 1086cf23.
   - `supervisor.js` (`4939dc68…`) is the exact line union:
     - (composed − 493ee9ee) == (1086cf23 − 2bbea898), the 330 D+root lines;
     - (composed − 1086cf23) == (493ee9ee − 2bbea898), the 18 lines of the root-accepted C2 attestation-paths change plus one
       comment.
   - The relay-mode install set is computed by the commit's own overlay tool: `tools/verify-inputs-relay.py` →
     `receipts/inputs-precheck.json`.
2. **t1 tests (768)** `tools/t1-tests.sh`: the composed tree with its shipped bundles. The groups are listed in
   RESULT-LINUX-PACKAGE.md.
3. **b1 build (768)** `tools/b1-build.sh`:
   - pins, then calibration: the same measurement command must reproduce b8376e15 AND ed918e4b;
   - the install set is recomputed and must equal the s1 precheck;
   - then the overlay with NO `--control`, the mode of the running ed918e4b:
     ```
     python3 src/metal/overlay-control-image.py /home/steven/enclave-prod/dist-sdshield-2857356cd image/dist-linux-fec43a6a0 fec43a6a08da2ac287fb3a5c42de89f096f4f678
     sev-snp-measure … --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app" \
       --kernel image/dist-linux-fec43a6a0/vmlinuz --initrd image/dist-linux-fec43a6a0/initramfs.cpio.gz --output-format hex
     git -C src archive --format=tar -o image/release-fec43a6a0.tar fec43a6a…   # the host launcher's release tree
     ```
4. **v1 verify (768)**, a separate job, `tools/v1-verify.sh`:
   - measurement B is computed from the artifacts on disk;
   - `tools/verify-image-relay.py` checks the image from its own bytes;
   - `tools/import-check-relay.mjs` imports the extracted image under the loopback-only fetch guard.

The overlay writes gzip with mtime 0 and copies committed bytes, so any rebuild of the same commit over the same base
should be byte-identical. That was shown for 6f2c7da4 and 493ee9ee, but not repeated here: one build, per the task.
**A different commit gives a different measurement**, because the commit id is in `manifest.json` inside the
initramfs.
