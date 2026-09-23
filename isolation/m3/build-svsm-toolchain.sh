#!/bin/sh
# M3a-3 (isolation/m3/PLAN.md section 6): build the pieces M3b needs, WITHOUT installing a host kernel,
# rebooting, or touching anything the running host depends on. Everything lands in one work directory,
# including the cargo home, and nothing is installed system-wide.
#
# What it builds, in the order the plan lists them:
#   1. the x86_64-unknown-none Rust target (the SVSM is a freestanding binary)
#   2. cargo-c and cbindgen, which the IGVM C library needs
#   3. microsoft/igvm: the C library QEMU links against for --enable-igvm
#   4. COCONUT-SVSM through its own Makefile, which also produces igvmmeasure and an IGVM file
#   5. the IGVM digest, from igvmmeasure: the number an allowlist would hold
#   6. the SAME commit in a SECOND checkout at a DIFFERENT path, compared digest for digest. Upstream
#      has had builder paths leak into SVSM binaries, which would make a published measurement
#      unreproducible by anyone else — the property our allowlist depends on.
#
# usage: build-svsm-toolchain.sh <workdir>
# Prints PASS/FAIL per step. Network access is read-only clones of public repositories.
set -e
W=${1:?usage: build-svsm-toolchain.sh <workdir>}
mkdir -p "$W"; W=$(cd "$W" && pwd)
export CARGO_HOME="$W/cargo"        # nothing goes into the user's ~/.cargo
export PATH="$W/tools/bin:$CARGO_HOME/bin:$PATH"
log() { printf '\n=== %s\n' "$1"; }
fails=0
step() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
IGVM_REF=${IGVM_REF:-main}
SVSM_REF=${SVSM_REF:-main}
# vtpm is COCONUT's default feature set and needs the TPM reference implementation; set FEATURES= to
# skip it if that submodule or its toolchain is missing.
# ${FEATURES-vtpm}, not ${FEATURES:-vtpm}: an explicitly EMPTY FEATURES means "no features", and the
# colon form would quietly turn that back into vtpm — which it did once here, making a no-vtpm build
# look byte-identical to a vtpm one.
FEATURES=${FEATURES-vtpm}

log "1. rust target x86_64-unknown-none"
rustup target add x86_64-unknown-none > "$W/1-target.log" 2>&1 && r=ok || r=no
rustup target list --installed | grep -q x86_64-unknown-none || r=no
step "1 x86_64-unknown-none target available" $r

log "2. cargo-c and cbindgen (into $W/tools, not the user's toolchain)"
if [ -x "$W/tools/bin/cbindgen" ]; then r=ok; else
  { cargo install --root "$W/tools" --locked cargo-c cbindgen; } > "$W/2-tools.log" 2>&1 && r=ok || r=no
fi
[ -x "$W/tools/bin/cbindgen" ] || r=no
step "2 cargo-c and cbindgen built" $r

log "3. microsoft/igvm: the C library QEMU links for --enable-igvm"
[ -d "$W/igvm/.git" ] || git clone --depth 1 --branch "$IGVM_REF" https://github.com/microsoft/igvm "$W/igvm" > "$W/3-clone.log" 2>&1
( cd "$W/igvm" && PREFIX="$W/igvminst" make -f igvm_c/Makefile install ) > "$W/3-igvmc.log" 2>&1 && r=ok || r=no
{ [ -f "$W/igvminst/lib/libigvm.a" ] || [ -f "$W/igvminst/lib64/libigvm.a" ]; } || r=no
step "3 libigvm built (QEMU needs it to accept an igvm-cfg object)" $r

# build_svsm <checkout dir>: clone if needed and build through the project's own Makefile, which knows
# which crates are bare-metal and which are host tools. FW_FILE defaults to none, so this needs no
# edk2 build; M3b would pass a real OVMF.
build_svsm() {
  d=$1; tag=$2
  [ -d "$d/.git" ] || git clone --depth 1 --branch "$SVSM_REF" --recurse-submodules --shallow-submodules \
    https://github.com/coconut-svsm/svsm "$d" > "$W/$tag-clone.log" 2>&1
  ( cd "$d" && make RELEASE=1 FEATURES="$FEATURES" igvm ) > "$W/$tag-build.log" 2>&1
}

log "4. COCONUT-SVSM (its own Makefile: the VMPL0 monitor, igvmbuilder and igvmmeasure)"
build_svsm "$W/svsm" 4 && r=ok || r=no
SVSM_ELF="$W/svsm/target/x86_64-unknown-none/release/svsm"
IGVM_FILE="$W/svsm/bin/coconut-qemu.igvm"
MEASURE="$W/svsm/bin/igvmmeasure"
[ -f "$SVSM_ELF" ] || r=no
step "4 COCONUT-SVSM builds here (the VMPL0 monitor M3b would run)" $r
[ -x "$MEASURE" ] && r=ok || r=no
step "4b igvmmeasure built -- it lives in THIS repo, not microsoft/igvm (a correction to PLAN.md)" $r
[ -f "$IGVM_FILE" ] && r=ok || r=no
step "4c an IGVM file was produced (firmware-less: FW_FILE=none; M3b supplies a real OVMF)" $r

log "5. the digest an allowlist would hold"
r=no
if [ -x "$MEASURE" ] && [ -f "$IGVM_FILE" ]; then
  # the input file comes BEFORE the subcommand: igvmmeasure [OPTIONS] <INPUT> <COMMAND>
  "$MEASURE" "$IGVM_FILE" measure -b > "$W/5-measure.txt" 2>&1 || true
  cat "$W/5-measure.txt"
  grep -qiE '[0-9a-f]{64}' "$W/5-measure.txt" && r=ok || r=no
fi
step "5 igvmmeasure prints a launch digest for the IGVM (sev-snp-measure cannot: it does not read IGVM)" $r

log "6. the same commit, a different path: is that digest reproducible by someone else?"
# Checkout B is cloned FROM checkout A, so the commit is identical by construction and any difference
# is the build, not the source.
r=no
if [ "$SKIP_REBUILD" != 1 ] && [ -x "$MEASURE" ] && [ -f "$IGVM_FILE" ]; then
  [ -d "$W/svsm-b/.git" ] || git clone --recurse-submodules "$W/svsm" "$W/svsm-b" > "$W/6-clone.log" 2>&1
  ( cd "$W/svsm-b" && make RELEASE=1 FEATURES="$FEATURES" igvm ) > "$W/6-build.log" 2>&1 || true
  IGVM_B="$W/svsm-b/bin/coconut-qemu.igvm"
  if [ -f "$IGVM_B" ]; then
    "$W/svsm-b/bin/igvmmeasure" "$IGVM_B" measure -b > "$W/6-measure.txt" 2>&1 || true
    a=$(grep -ioE '[0-9a-f]{64,96}' "$W/5-measure.txt" | head -1)
    b=$(grep -ioE '[0-9a-f]{64,96}' "$W/6-measure.txt" | head -1)
    echo "  checkout A ($W/svsm):   $a"
    echo "  checkout B ($W/svsm-b): $b"
    [ -n "$a" ] && [ "$a" = "$b" ] && r=ok || r=no
    sha_a=$(sha256sum "$SVSM_ELF" | cut -c1-16); sha_b=$(sha256sum "$W/svsm-b/target/x86_64-unknown-none/release/svsm" | cut -c1-16)
    echo "  svsm binary sha256: A $sha_a  B $sha_b"
  fi
fi
step "6 two checkouts at different paths give the SAME IGVM digest (what makes a published measurement auditable)" $r

log "7. the remedy: remap the build paths and measure again"
# COCONUT pins its own Rust toolchain (rust-toolchain.toml -> cargo 1.88), where the `trim-paths` profile
# option is still unstable, so setting CARGO_PROFILE_RELEASE_TRIM_PATHS just fails the build. The fix that
# works within their pinned toolchain is --remap-path-prefix, and it has to be APPENDED to the rustflags
# their own .cargo/config.toml already sets for the bare-metal target: putting flags in RUSTFLAGS would
# REPLACE those (force-frame-pointers, soft AES) and silently change the thing being measured.
#
# Both checkouts remap their own absolute path to the SAME placeholder, which is what makes the outputs
# comparable — and is exactly the change upstream would need for its measurements to be auditable.
r=no
if [ -d "$W/svsm-b" ]; then
  for d in "$W/svsm" "$W/svsm-b"; do
    python3 - "$d" "$CARGO_HOME" <<'PY'
import re, sys, pathlib
d, cargo = sys.argv[1], sys.argv[2]
p = pathlib.Path(d) / ".cargo" / "config.toml"
s = p.read_text()
# TWO sources of absolute paths end up in the binary, and both have to go:
#   the checkout itself, and the DEPENDENCY SOURCES under CARGO_HOME, which panic messages in crates
#   like intrusive-collections and cipher carry. The second is why this is not just our problem: every
#   builder's cargo home is a different absolute path. rustc already remaps its own sysroot to
#   /rustc/<hash>, which is the same idea.
flags = ('"--remap-path-prefix",\n    "%s=/svsm",\n    '
         '"--remap-path-prefix",\n    "%s=/cargo",\n    ') % (d, cargo)
if "--remap-path-prefix" in s:
    s = re.sub(r'\s*"--remap-path-prefix",\n\s*"[^"]*",', '', s)
s = re.sub(r'(\[target\.x86_64-unknown-none\]\nrustflags = \[\n)', r'\1    ' + flags, s, count=1)
p.write_text(s)
print("patched", p)
PY
    ( cd "$d" && rm -rf target bin && make RELEASE=1 FEATURES="$FEATURES" igvm ) \
      > "$W/7-build-$(basename "$d").log" 2>&1 || true
  done
  ma="$W/svsm/bin/igvmmeasure"; mb="$W/svsm-b/bin/igvmmeasure"
  ia="$W/svsm/bin/coconut-qemu.igvm"; ib="$W/svsm-b/bin/coconut-qemu.igvm"
  if [ -x "$ma" ] && [ -f "$ia" ] && [ -x "$mb" ] && [ -f "$ib" ]; then
    ta=$("$ma" "$ia" measure -b 2>&1 | tr -d '\r\n')
    tb=$("$mb" "$ib" measure -b 2>&1 | tr -d '\r\n')
    echo "  remapped A: $ta"
    echo "  remapped B: $tb"
    ea="$W/svsm/target/x86_64-unknown-none/release/svsm"
    left=$(strings "$ea" 2>/dev/null | grep -cE "$W/svsm(-b)?/" || true)
    echo "  absolute build paths left in the rebuilt A binary: $left (3 before the remedy)"
    [ -n "$ta" ] && [ "$ta" = "$tb" ] && r=ok || r=no
  else
    echo "  one of the rebuilds did not produce an IGVM and an igvmmeasure; see $W/7-build-*.log"
    tail -4 "$W/7-build-svsm.log" 2>/dev/null | sed 's/^/    /'
  fi
fi
step "7 with --remap-path-prefix, the same commit at two paths measures the SAME (a fix we can carry, and upstream)" $r

echo
echo "--- what this establishes, and what it does not ---"
echo "Built in $W with nothing installed system-wide and the running host untouched."
[ -f "$SVSM_ELF" ] && echo "svsm ELF:      $(stat -c %s "$SVSM_ELF") bytes"
[ -f "$IGVM_FILE" ] && echo "IGVM file:     $(stat -c %s "$IGVM_FILE") bytes"
[ -x "$MEASURE" ] && echo "igvmmeasure:   $MEASURE"
echo "NOT built here: OVMF/edk2 firmware for a real IGVM, the KVM planes kernel, and the patched QEMU."
echo "Those are M3b: they need a host kernel and VMM change, which is Steven's decision, not this step's."
du -sh "$W" 2>/dev/null
[ "$fails" -eq 0 ] && echo "TOOLCHAIN: ALL PASS" || { echo "TOOLCHAIN: $fails FAILED"; exit 1; }
