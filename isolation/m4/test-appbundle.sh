#!/bin/sh
# The app a plane runs is the component of the bundle it ADMITTED - tested on the host, no guest.
#
# What has to hold, and what each check would still pass if the mechanism were absent:
#   1  the plane's SHA-256 is SHA-256 - over the padding boundaries and a 45 MB file (a wrong hash would make the
#      manifest check below pass or fail for the wrong reason)
#   2  the plane's cut of the component equals the CONTRACT's own extractor, byte for byte, on two different bundles
#   3  every malformed variant the contract refuses, the plane refuses too - counted, so a loop over nothing fails
#   4  the one documented divergence: an empty artifact, which Parse accepts and the plane refuses
#   5  what is served FOLLOWS THE BUNDLE: bundle A serves A's label and bundle B serves B's, through the sealed
#      fd-3 path the plane uses; with a decoy component planted at the old /app.wasm path beside it. Serving one
#      bundle alone would not show that the served bytes come from the bundle rather than from a fixed file.
#   6  the component the runtime holds cannot be written or truncated, even through /proc/<pid>/fd/3
#
#   usage: test-appbundle.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: test-appbundle.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/appbundle-test-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$W/appbundle
gcc -O2 -Wall -Wextra -Werror -o "$T" "$here/appbundle.c"
BT=${BUNDLETOOL:-$here/.bundle}
[ -x "$BT" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BT" ./cmd/bundle)
cp "$BUNDLE" "$W/A.bundle"

# a SECOND, genuinely different app: the label is compiled into the component, so the bytes differ
if [ ! -s "$W/decoy.wasm" ]; then
  M2_LABEL=DECOY cargo build --release --locked --target wasm32-wasip2 \
    --manifest-path "$here/../m2/app/Cargo.toml" --target-dir "$W/target-decoy" 2> "$W/cargo-decoy.txt"
  cp "$W/target-decoy/wasm32-wasip2/release/m2_app.wasm" "$W/decoy.wasm"
fi
"$BT" build -label DECOY -cpu 100 -mem 512 -vcpus 1 "$W/decoy.wasm" "$W/B.bundle" > /dev/null

# 1 -------------------------------------------------------------------------------------------------------------
n=0; good=0
for size in 0 1 55 56 57 63 64 65 119 120 1000 100000; do
  head -c "$size" /dev/urandom > "$W/h.bin"; n=$((n + 1))
  [ "$("$T" sha256 "$W/h.bin")" = "$(sha256sum "$W/h.bin" | cut -c1-64)" ] && good=$((good + 1))
done
wt=$(readlink -f "$(command -v wasmtime)"); n=$((n + 1))
[ "$("$T" sha256 "$wt")" = "$(sha256sum "$wt" | cut -c1-64)" ] && good=$((good + 1))
[ $good = $n ] && r=ok || r=no
check "1 the plane's SHA-256 equals sha256sum on $good of $n inputs, across every padding boundary and a 45 MB file" $r

# 2 -------------------------------------------------------------------------------------------------------------
r=ok
for x in A B; do
  "$T" extract "$W/$x.bundle" > "$W/$x.c.wasm" || r=no
  "$BT" extract "$W/$x.bundle" "$W/$x.go.wasm" || r=no
  cmp -s "$W/$x.c.wasm" "$W/$x.go.wasm" || r=no
done
cmp -s "$W/A.c.wasm" "$W/B.c.wasm" && r=no
check "2 the plane's cut equals the contract's extractor byte for byte, on two different bundles" $r

# 3-4 -----------------------------------------------------------------------------------------------------------
mkdir -p "$W/bad"; rm -f "$W/bad"/*
python3 - "$W/A.bundle" "$W/bad" <<'PY'
import hashlib, json, struct, sys
b = open(sys.argv[1], "rb").read(); d = sys.argv[2]
M = b"ENCLAVE-BUNDLE/1\n"
ml = struct.unpack("<I", b[17:21])[0]; man = b[21:21 + ml]; art = b[25 + ml:]
def frame(man, art, al=None):
    return M + struct.pack("<I", len(man)) + man + struct.pack("<I", len(art) if al is None else al) + art
def w(name, data): open(f"{d}/{name}", "wb").write(data)
def canon(m): return json.dumps(m, sort_keys=True, separators=(",", ":")).encode()
m = json.loads(man)
w("badmagic", b"X" + b[1:])
w("mlen_over_cap", b[:17] + struct.pack("<I", 65537) + b[21:])
w("mlen_over_rest", b[:17] + struct.pack("<I", len(b)) + b[21:])
w("trunc_in_alen", b[:21 + ml + 2])
w("trailing_byte", b + b"\0")
w("short_by_one", b[:-1])
w("artifact_flipped", b[:-100] + bytes([b[-100] ^ 1]) + b[-99:])
w("alen_lies", frame(man, art, len(art) - 1))
m2 = dict(m); m2["abi"] = "enclave-domain-abi/2"; w("abi_2", frame(canon(m2), art))
m3 = json.loads(man); m3["artifact"]["kind"] = "cwasm"; w("kind_cwasm", frame(canon(m3), art))
w("noncanonical", frame(json.dumps(m, sort_keys=True).encode(), art))
m4 = json.loads(man); m4["artifact"]["sha256"] = "0" * 64; w("names_other", frame(canon(m4), art))
w("bare_component", art)
m5 = json.loads(man); m5["artifact"]["sha256"] = hashlib.sha256(b"").hexdigest()
open(f"{d}/../empty_artifact.bundle", "wb").write(frame(canon(m5), b""))
PY
n=0; both=0
for f in "$W/bad"/*; do
  n=$((n + 1))
  c=0; g=0
  "$T" extract "$f" > /dev/null 2>> "$W/bad-c.txt" || c=1
  "$BT" extract "$f" "$W/bad.out" > /dev/null 2>> "$W/bad-go.txt" || g=1
  if [ $c = 1 ] && [ $g = 1 ]; then both=$((both + 1)); else echo "     disagreement on $(basename "$f"): plane refused=$c contract refused=$g"; fi
done
[ $n -ge 13 ] && [ $both = $n ] && r=ok || r=no
check "3 every malformed bundle ($both of $n variants) is refused by the plane AND by the contract" $r
"$BT" extract "$W/empty_artifact.bundle" "$W/bad.out" > /dev/null 2>&1 && go_ok=1 || go_ok=0
"$T" extract "$W/empty_artifact.bundle" > /dev/null 2>&1 && c_ok=1 || c_ok=0
[ $go_ok = 1 ] && [ $c_ok = 0 ] && r=ok || r=no
check "4 the documented divergence: an EMPTY artifact is accepted by the contract and refused by the plane" $r

# 5-6 -----------------------------------------------------------------------------------------------------------
rm -rf "$W/rt"; "$here/runtime-set.sh" compose "$W/rt"; R=$W/rt
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
cp "$W/decoy.wasm" "$W/app.wasm"   # the decoy where the OLD argv would have read the component from
for x in A B; do
  p=$(port)
  (cd "$W" && "$T" serve "$W/$x.bundle" "$p" 15000 -- "$R/ld-linux-x86-64.so.2" --library-path "$R" "$R/wasmtime" \
     serve -S cli -C cache=n --addr "127.0.0.1:$p" /proc/self/fd/3) > "$W/serve-$x.txt" 2>&1 || true
  sed "s/^/     $x: /" "$W/serve-$x.txt" | grep -v "Serving HTTP"
done
r=ok
grep -q "^BODY APP STEP2 " "$W/serve-A.txt" || grep -q "^BODY APP " "$W/serve-A.txt" || r=no
grep -q "^BODY APP DECOY " "$W/serve-B.txt" || r=no
grep -q "^BODY APP DECOY " "$W/serve-A.txt" && r=no
[ "$(sed -n 's/^COMPONENT sha256=\([0-9a-f]*\).*/\1/p' "$W/serve-A.txt")" = "$(sha256sum "$W/A.go.wasm" | cut -c1-64)" ] || r=no
check "5 the served app FOLLOWS THE BUNDLE through the sealed fd-3 path (A serves A, B serves B), with a decoy at the old /app.wasm path" $r
r=ok
for x in A B; do grep -q "^SEAL write=Operation not permitted truncate=Operation not permitted" "$W/serve-$x.txt" || r=no; done
check "6 the runtime's component can be neither written nor truncated, even through /proc/<pid>/fd/3" $r

echo
echo "appbundle: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
