#!/bin/sh
# The runtime set, tested on the host: no guest, no SVSM, no hardware.
#
# What has to hold for "changed or missing runtime files cannot inherit an accepted identity":
#   - the set is the directory the plane runs from, whole (1), and its encoding is a function of the bytes and
#     names alone (2), as the format in guest/rtset.h says (3);
#   - EVERY member, not a sample, changes the digest when its bytes change, when it is shortened, or when it is
#     missing (4-6), and so do an added and a renamed file (7) - the SVSM compares this digest and refuses on any
#     difference, so a different digest is a refusal;
#   - an entry the loader could prefer over a member (a glibc-hwcaps subdirectory), or any non-file, refuses the
#     whole set instead of being skipped (8);
#   - the old meaning cannot satisfy the new (9);
#   - the maps check the plane runs accepts the plane's own command line (10), and refuses a process that maps an
#     unadmitted executable, one whose member was replaced after admission, and one that never finished loading
#     the set (11) - without those three, (10) passing would say nothing;
#   - the guest images carry the set their printed digest names, both builds agree, and a negative-control build
#     really does differ (12-14).
#
# Each loop counts what it covered and fails if that is not every member: a loop over nothing passes.
#
#   usage: test-rtset.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: test-rtset.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/rtset-test-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$W/rtset
gcc -O2 -Wall -Wextra -Werror -o "$T" "$here/rtset.c"
dg() { "$T" encode "$1" | sha256sum | cut -c1-64; }
BUNDLETOOL=${BUNDLETOOL:-$here/.bundle}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
"$BUNDLETOOL" extract "$BUNDLE" "$W/app.wasm"

rm -rf "$W/rt" "$W/aside"; mkdir -p "$W/aside"
"$here/runtime-set.sh" compose "$W/rt"
set -- $("$here/runtime-set.sh" digest "$W/rt"); D=$2
echo "   set $D $3 $4 $5"
members=$(ls "$W/rt"); k=$(echo "$members" | wc -l)

# 1 -------------------------------------------------------------------------------------------------------------
wt=$(command -v wasmtime)
want=$( { echo wasmtime; echo runtime.json; echo ld-linux-x86-64.so.2
          ldd "$wt" | awk '/=>/ {print $3}' | xargs -n1 basename; } | LC_ALL=C sort -u)
[ "$(echo "$members" | LC_ALL=C sort)" = "$want" ] && [ "$k" -ge 5 ] && r=ok || r=no
check "1 the set is exactly the runtime, its interpreter, every library ldd resolves for it, and runtime.json ($k members)" $r

# 2 -------------------------------------------------------------------------------------------------------------
rm -rf "$W/rt2"; mkdir "$W/rt2"
for f in $(echo "$members" | sort -r); do cp "$W/rt/$f" "$W/rt2/$f"; done
chmod 600 "$W/rt2"/*; touch -d @123456789 "$W/rt2"/*
[ "$(dg "$W/rt")" = "$D" ] && [ "$(dg "$W/rt2")" = "$D" ] && r=ok || r=no
check "2 the digest is reproducible, and independent of creation order, modes and timestamps" $r
rm -rf "$W/rt2"

# 3 -------------------------------------------------------------------------------------------------------------
spec=$(python3 - "$W/rt" <<'PY'
# An independent reading of the format in guest/rtset.h - a SPEC check, never a producer.
import hashlib, os, stat, struct, sys
d = os.fsencode(sys.argv[1])
names = sorted(os.listdir(d))                      # bytes sort bytewise, as the format says
h = hashlib.sha256(b"enclave-runtime-set-v1\n")
h.update(struct.pack("<I", len(names)))
for n in names:
    p = os.path.join(d, n)
    assert stat.S_ISREG(os.lstat(p).st_mode)
    b = open(p, "rb").read()
    h.update(struct.pack("<I", len(n)) + n + struct.pack("<Q", len(b)) + b)
print(h.hexdigest())
PY
)
[ "$spec" = "$D" ] && r=ok || r=no
check "3 an independent reading of the documented format gives the same digest" $r

# 4-6 -----------------------------------------------------------------------------------------------------------
n_flip=0; n_short=0; n_drop=0
for f in $members; do
  cp -p "$W/rt/$f" "$W/aside/$f"
  python3 -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[len(b)//2]^=1; open(p,"wb").write(b)' "$W/rt/$f"
  [ "$(dg "$W/rt")" != "$D" ] && n_flip=$((n_flip + 1))
  cp -p "$W/aside/$f" "$W/rt/$f"
  truncate -s -1 "$W/rt/$f"
  [ "$(dg "$W/rt")" != "$D" ] && n_short=$((n_short + 1))
  cp -p "$W/aside/$f" "$W/rt/$f"
  mv "$W/rt/$f" "$W/aside/$f.gone"
  [ "$(dg "$W/rt")" != "$D" ] && n_drop=$((n_drop + 1))
  mv "$W/aside/$f.gone" "$W/rt/$f"
  rm -f "$W/aside/$f"
done
[ "$(dg "$W/rt")" = "$D" ] && restored=ok || restored=no
[ $n_flip = "$k" ] && [ $restored = ok ] && r=ok || r=no
check "4 ONE flipped bit in ANY member changes the digest ($n_flip of $k members)" $r
[ $n_short = "$k" ] && [ $restored = ok ] && r=ok || r=no
check "5 ANY member one byte shorter changes the digest ($n_short of $k)" $r
[ $n_drop = "$k" ] && [ $restored = ok ] && r=ok || r=no
check "6 ANY member MISSING changes the digest ($n_drop of $k), and restoring them all restores it" $r

# 7 -------------------------------------------------------------------------------------------------------------
printf 'x' > "$W/rt/extra"; a=$(dg "$W/rt"); rm "$W/rt/extra"
mv "$W/rt/libm.so.6" "$W/rt/libm.so.7"; b=$(dg "$W/rt"); mv "$W/rt/libm.so.7" "$W/rt/libm.so.6"
[ "$a" != "$D" ] && [ "$b" != "$D" ] && [ "$(dg "$W/rt")" = "$D" ] && r=ok || r=no
check "7 an ADDED file and a RENAMED member each change the digest" $r

# 8 -------------------------------------------------------------------------------------------------------------
refused() { ! "$T" encode "$1" > /dev/null 2> "$W/refusal.txt" && grep -q "$2" "$W/refusal.txt"; }
r=ok
mkdir -p "$W/rt/glibc-hwcaps/x86-64-v3"; cp "$W/rt/libc.so.6" "$W/rt/glibc-hwcaps/x86-64-v3/"
refused "$W/rt" "is a directory" || r=no; rm -rf "$W/rt/glibc-hwcaps"
ln -s libc.so.6 "$W/rt/libc.so.7"; refused "$W/rt" "is a symlink" || r=no; rm "$W/rt/libc.so.7"
mkfifo "$W/rt/fifo"; refused "$W/rt" "is a FIFO" || r=no; rm "$W/rt/fifo"
mkdir -p "$W/empty"; refused "$W/empty" "is empty" || r=no
mkdir -p "$W/big"; truncate -s 65M "$W/big/huge"; refused "$W/big" "over the" || r=no; rm -rf "$W/big"
[ "$(dg "$W/rt")" = "$D" ] || r=no
check "8 a glibc-hwcaps subdirectory, a symlink, a FIFO, an empty set and an oversized set are each REFUSED, not skipped" $r

# 9 -------------------------------------------------------------------------------------------------------------
[ "$(sha256sum "$W/rt/wasmtime" | cut -c1-64)" != "$D" ] && [ "$(head -c 23 "$W/rt/wasmtime" | od -An -c | tr -d ' \n' | cut -c1-4)" = '177E' ] && r=ok || r=no
check "9 the old meaning (sha256 of the wasmtime ELF) is not the set digest, so an SVSM built for either refuses the other" $r

# 10-11 ---------------------------------------------------------------------------------------------------------
R=$W/rt
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
plane_argv() {   # the plane's own command line (planeinit.c), with $1 for /rt
  echo "$1/ld-linux-x86-64.so.2 --library-path $1 $1/wasmtime serve -S cli -C cache=n --addr 127.0.0.1:$(port) $W/app.wasm"
}
"$T" cover "$R" 10000 -- $(plane_argv "$R") > "$W/cover-plane.txt" 2>&1 || true
sed 's/^/     /' "$W/cover-plane.txt"
elf=$("$T" list "$R" | tail -1 | awk '{print $6}')
grep -q "^COVER ok elf_members_mapped=$elf/$elf " "$W/cover-plane.txt" && [ "$elf" -ge 5 ] && r=ok || r=no
check "10 the plane's own command line maps EVERY admitted ELF ($elf) and no executable outside the set" $r

"$T" cover "$R" 3000 -- "$(readlink -f "$wt")" serve -S cli -C cache=n --addr "127.0.0.1:$(port)" "$W/app.wasm" \
  > "$W/cover-system.txt" 2>&1 || true
rm -rf "$W/rtswap"; cp -a "$R" "$W/rtswap"
"$T" cover "$W/rtswap" 10000 --swap libm.so.6 -- $(plane_argv "$W/rtswap") > "$W/cover-swap.txt" 2>&1 || true
rm -rf "$W/vac"; mkdir "$W/vac"; cp "$R/libc.so.6" "$W/vac/"
printf '#include <unistd.h>\nint main(void){sleep(30);return 0;}\n' | gcc -static -O2 -x c -o "$W/vac/sleeper" -
"$T" cover "$W/vac" 500 -- "$W/vac/sleeper" > "$W/cover-vacuous.txt" 2>&1 || true
for x in system swap vacuous; do sed "s/^/     $x: /" "$W/cover-$x.txt"; done
r=ok
grep -q "^COVER refused: .* is mapped EXECUTABLE and is not a member" "$W/cover-system.txt" || r=no
grep -q "^COVER refused: .*libm.so.6 is mapped, but it is not the file object that was admitted" "$W/cover-swap.txt" || r=no
grep -q "^COVER refused: not every admitted ELF member was mapped .* libc.so.6" "$W/cover-vacuous.txt" || r=no
check "11 the maps check REFUSES an unadmitted executable, a member replaced after admission, and a load it never saw complete" $r
rm -rf "$W/rtswap" "$W/vac"

# 12-14 ---------------------------------------------------------------------------------------------------------
"$here/build-plane-guest.sh" "$BUNDLE" "$W/plane.cpio.gz" > "$W/build-plane.txt"
pd=$(sed -n 's/.*runtime set     \([0-9a-f]*\) .*/\1/p' "$W/build-plane.txt")
rm -rf "$W/img"; mkdir "$W/img"
(cd "$W/img" && gzip -dc "$W/plane.cpio.gz" | cpio -id --quiet)
[ ${#pd} = 64 ] && [ "$(dg "$W/img/rt")" = "$pd" ] && [ "$pd" = "$D" ] && r=ok || r=no
check "12 the plane image's /rt encodes to the digest its build printed, which is this host's set" $r
"$here/build-admit-guest.sh" "$BUNDLE" "$W/admit.cpio.gz" > "$W/build-admit.txt"
ad=$(sed -n 's/.*runtime set     \([0-9a-f]*\) .*/\1/p' "$W/build-admit.txt")
[ "$ad" = "$pd" ] && r=ok || r=no
check "13 the admission fixture carries the same set under the same digest: one meaning of ENCLAVE_RUNTIME_SHA256" $r
RT_MUTATE=flip:libc.so.6 "$here/build-plane-guest.sh" "$BUNDLE" "$W/neg.cpio.gz" > "$W/build-neg.txt" 2>&1
nd=$(sed -n 's/.*runtime set     \([0-9a-f]*\) .*/\1/p' "$W/build-neg.txt")
[ ${#nd} = 64 ] && [ "$nd" != "$pd" ] && grep -q "NEGATIVE CONTROL" "$W/build-neg.txt" && r=ok || r=no
check "14 a negative-control build (one byte of libc) prints a DIFFERENT digest and says it is a negative control" $r
rm -rf "$W/img"

echo
echo "rtset: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
