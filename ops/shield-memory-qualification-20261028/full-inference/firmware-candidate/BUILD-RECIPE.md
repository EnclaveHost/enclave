# Build recipe: SNP boot-window candidate (NOT RUN)

This is the exact local recipe for root to run. I ran none of it.
- **Reads only** from `~/.cache/enclave-isolation/fwbuild` (`src/edk2` and `tools/bin`). It writes, copies into and
  replaces nothing there.
- All output goes to a new workspace, `$W`.
- It needs no network: it reuses the existing BaseTools binaries, nasm, iasl, mcopy and the host grub tools.
- It uses no signing and no credentials, and it launches nothing.
- It builds with `-n 1`.

It builds two firmwares from identical copies. **base** is unpatched. It must reproduce RELEASE sha256 `142589cc...`
before the **cand** build means anything.

```sh
#!/bin/sh
set -eu
SRC=$HOME/.cache/enclave-isolation/fwbuild/src/edk2            # read only
TOOLS=$HOME/.cache/enclave-isolation/fwbuild/tools/bin         # read only: nasm, iasl, mcopy
CAND=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/shield-memory-20261028/firmware-candidate
W=$HOME/.cache/snp-fw-candidate-20261027                         # new; refuse to reuse
test ! -e "$W"
mkdir -p "$W/out"

# 1. Baseline identity (read only; --no-optional-locks keeps git from touching $SRC/.git/index)
sha256sum "$SRC/OvmfPkg/PlatformPei/AmdSev.c" "$SRC/OvmfPkg/PlatformPei/PlatformPei.inf" \
  > "$W/out/baseline-targets.sha256"
sha256sum "$CAND/CHANGE.patch" "$CAND/src/OvmfPkg/PlatformPei/SnpBootWindow.h" \
  "$CAND/tests/test_snp_boot_window.c" > "$W/out/candidate-inputs.sha256"
git --no-optional-locks -C "$SRC" rev-parse HEAD > "$W/out/baseline-head.txt"
git --no-optional-locks -C "$SRC" status --porcelain --untracked-files=no > "$W/out/baseline-status.txt"
# Expect only the build script's grub.sh sed edit. Stop on anything else, especially under OvmfPkg/PlatformPei.
if grep -q sevsecret "$SRC/OvmfPkg/AmdSev/Grub/grub.sh"; then echo "grub.sh not in built state" >&2; exit 1; fi

# 2. Two identical copies. Leave out the top-level Build/ (old output) and Conf/, which edksetup regenerates.
for t in base cand; do
  mkdir "$W/$t"
  tar -C "$SRC" --anchored --exclude=./Build --exclude=./Conf -cf - . | tar -C "$W/$t" -xf -
done
cmp "$SRC/OvmfPkg/PlatformPei/AmdSev.c" "$W/cand/OvmfPkg/PlatformPei/AmdSev.c"

# 3. Apply the candidate to cand only. The targets are CRLF and the patch is LF: strip CR, patch with zero fuzz,
#    then restore CRLF on every line. The original files are CRLF on every line (587/587 and 156/156).
cd "$W/cand"
cp "$CAND/src/OvmfPkg/PlatformPei/SnpBootWindow.h" OvmfPkg/PlatformPei/SnpBootWindow.h
for f in OvmfPkg/PlatformPei/AmdSev.c OvmfPkg/PlatformPei/PlatformPei.inf; do sed -i 's/\r$//' "$f"; done
patch -p1 -F0 --dry-run --no-backup-if-mismatch < "$CAND/CHANGE.patch"
patch -p1 -F0 --no-backup-if-mismatch < "$CAND/CHANGE.patch"
for f in OvmfPkg/PlatformPei/AmdSev.c OvmfPkg/PlatformPei/PlatformPei.inf OvmfPkg/PlatformPei/SnpBootWindow.h; do
  sed -i 's/$/\r/' "$f"
done
# The diff must touch exactly three files: AmdSev.c, PlatformPei.inf and the new SnpBootWindow.h.
# If whole-file CR noise appears, stop.
diff -ruN "$W/base/OvmfPkg" "$W/cand/OvmfPkg" > "$W/out/applied.diff" || true
grep '^diff ' "$W/out/applied.diff"
cd "$W"

# 4. Offline tests against the exact header bytes that will be built
cc -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined \
   -I"$W/cand/OvmfPkg/PlatformPei" -o "$W/out/snpwin-test" "$CAND/tests/test_snp_boot_window.c"
"$W/out/snpwin-test" > "$W/out/tests.txt" 2>&1           # set -e stops here unless exit 0
cat "$W/out/tests.txt"                                     # must say ALL PASS

# 5. Build base, then cand: RELEASE, GCC, single thread
for t in base cand; do
  ( cd "$W/$t"
    export PATH="$TOOLS:$PATH"
    unset WORKSPACE EDK_TOOLS_PATH CONF_PATH PACKAGES_PATH 2>/dev/null || true
    set +u                                   # edksetup.sh is not nounset-clean
    . ./edksetup.sh BaseTools >/dev/null
    build -p OvmfPkg/AmdSev/AmdSevX64.dsc -a X64 -t GCC -b RELEASE -n 1
  ) > "$W/out/build-$t.log" 2>&1
  F=$(find "$W/$t/Build" -name OVMF.fd -path "*AmdSev*" -path "*RELEASE*" | head -1)
  test -n "$F"
  cp "$F" "$W/out/OVMF.amdsev.$t.fd"
done
sha256sum "$W/out/"OVMF.amdsev.*.fd | tee "$W/out/firmware.sha256"
```

## How to read the results

- If `OVMF.amdsev.base.fd` is `142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9`, the workspace
  reproduces production. In that case `cand` differs from the baseline only by this patch.
- If `base` does **not** match, the recipe does not reproduce the recorded baseline. Possible causes include a GRUB
  timestamp, a different toolchain or the `-n 1` setting. Record that. Compare `cand` to `base`, not to `142589cc`,
  and do not claim "baseline + patch".
- `cand` has a new sha256, so it will have a **new launch measurement**. It is not the production baseline and is not
  deployed. Both future A/B loader arms must use this same `cand` binary.
- Never copy either output to `fwbuild/OVMF.amdsev.fd`. Never edit `domain.env`, the verifier allowlists or the
  public admission floors. A DEBUG variant (`-b DEBUG`) may be built the same way into its own `$W` for diagnostics
  only.
