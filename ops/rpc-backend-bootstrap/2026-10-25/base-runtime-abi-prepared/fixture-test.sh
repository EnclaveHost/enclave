#!/bin/bash
# Fixture test of the bundle MECHANICS without the (still building) Base binary and without compiling: host binaries stand in.
#   python3 work/claude-test-queue.py --mib 256 --log $A/logs/fixture.guard -- unshare -rn bash $A/fixture-test.sh
set -uo pipefail
A=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d -p "$A" fixture.XXXX); trap 'rm -rf "$T"' EXIT; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }
ABI="python3 -I $A/abi.py"
echo "== T1 closure of /usr/bin/openssl (stand-in: links the host's OpenSSL 3.6.5 + glibc 2.44)"
$ABI closure /usr/bin/openssl > "$T/c.json"
python3 - "$T/c.json" <<'PY' && ok "closure complete, package-owned, loader == native verifier pin f5e11cc6" || bad "closure"
import json,sys; c=json.load(open(sys.argv[1]))
print("   needed", c["needed"], "| libs", sorted(c["libraries"]), "| highest", c["closureHighest"])
assert not c["missing"] and all(l["package"] for l in c["libraries"].values()) and c["interpreterFile"]["package"]
assert c["interpreterFile"]["sha256"].startswith("f5e11cc62f8f2c24"), c["interpreterFile"]["sha256"]
assert {"libssl.so.3","libcrypto.so.3","libc.so.6"} <= set(c["libraries"])
PY
$ABI report "$T/c.json" --target-glibc 2.39 --target-openssl 3.0.13 | sed 's/^/   /'
echo "== T2 bundle + SHA256SUMS"
S=$(sha256sum < /usr/bin/openssl | cut -c1-64)
$ABI bundle /usr/bin/openssl --expect-sha "$S" --out "$T/b" --name openssl > "$T/bundle.json" && ok "bundle built" || bad "bundle"
(cd "$T/b" && sha256sum -c --quiet SHA256SUMS) && ok "SHA256SUMS verify" || bad "SHA256SUMS"
$ABI bundle /usr/bin/openssl --expect-sha "$(printf 0%.0s {1..64})" --out "$T/wrong" --name openssl > /dev/null 2>&1 && bad "wrong pin accepted" || ok "a wrong binary pin is refused"
echo "== T3 run through the wrapper; resolution guard"
v=$("$T/b/run" version -v 2>&1); echo "   $v"; echo "$v" | grep -q '^OpenSSL 3\.6\.5' && ok "bundled libcrypto/libssl used" || bad "unexpected version"
$ABI guard "$T/b" > "$T/g.json" && ok "guard: every library inside the bundle" || { bad "guard"; cat "$T/g.json"; }
echo "== T4 fail closed: a library missing from the bundle would silently fall back to the loader's default dir"
cp -a "$T/b" "$T/m"; rm -f "$T/m/lib/libcrypto.so.3"
$ABI guard "$T/m" > "$T/gm.json"; r=$?
o=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['outside'])" "$T/gm.json" 2>/dev/null) || o=""
[ $r = 1 ] && echo "$o" | grep -q "libcrypto.so.3 => /usr/lib" && ok "guard refuses the fallback: $o" || { bad "guard rc $r outside=[$o]"; cat "$T/gm.json"; }
"$T/m/run" version -v > "$T/mrun" 2>&1; r=$?; [ $r = 65 ] && ok "wrapper refuses to start (65): $(head -1 "$T/mrun")" || bad "wrapper rc $r"
echo "== T5 LD_* scrub"
LD_PRELOAD=/nonexistent/evil.so "$T/b/lib/ld-linux-x86-64.so.2" --inhibit-cache --library-path "$T/b/lib" "$T/b/bin/openssl" version > /dev/null 2> "$T/pre"; grep -q evil.so "$T/pre" && echo "   (bare loader honours LD_PRELOAD: $(head -c 90 "$T/pre"))"
# /bin/sh itself is loaded by the SYSTEM loader before any wrapper line runs and prints exactly one warning; every
# further process (helpers, the bundled loader's --list and exec) would add one more if the scrub were missing.
n=$(LD_PRELOAD=/nonexistent/evil.so "$T/b/run" version 2>&1 >/dev/null | grep -c evil.so)
sed '/^unset LD_/d' "$T/b/run" > "$T/b/run-noscrub"; chmod 555 "$T/b/run-noscrub"
c=$(LD_PRELOAD=/nonexistent/evil.so "$T/b/run-noscrub" version 2>&1 >/dev/null | grep -c evil.so); rm -f "$T/b/run-noscrub"
[ "$n" = 1 ] && [ "$c" -gt 1 ] && ok "wrapper scrubs LD_PRELOAD (warnings: $n = the shell's own; unscrubbed control: $c)" || bad "LD_PRELOAD scrub: $n warnings (control $c)"
echo "== T6 CA plumbing (local test CA; no network)"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$T/ca.key" -out "$T/ca.pem" -subj /CN=fixture-ca -days 2 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$T/l.key" -out "$T/l.csr" -subj /CN=fixture-leaf 2>/dev/null
openssl x509 -req -in "$T/l.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial -out "$T/l.pem" -days 1 2>/dev/null
SSL_CERT_FILE="$T/ca.pem" SSL_CERT_DIR=/nonexistent "$T/b/run" verify "$T/l.pem" > /dev/null 2>&1 && ok "SSL_CERT_FILE honoured by the bundled libcrypto" || bad "CA via SSL_CERT_FILE"
SSL_CERT_FILE=/dev/null SSL_CERT_DIR=/nonexistent "$T/b/run" verify "$T/l.pem" > /dev/null 2>&1 && bad "verified without the CA" || ok "without the CA: verification fails (no hidden store)"
"$T/b/run" list -providers 2>&1 | grep -q "default" && ok "pinned openssl.cnf loads the default provider" || bad "provider config"
echo "== T7 name resolution under the bundled glibc (NSS files/dns are built into glibc >= 2.34)"
$ABI bundle /usr/bin/getent --expect-sha "$(sha256sum < /usr/bin/getent | cut -c1-64)" --out "$T/g" --name getent > /dev/null && \
  { o=$("$T/g/run" hosts localhost 2>&1); echo "   $o" | head -2; echo "$o" | grep -q "127.0.0.1\|::1" && ok "localhost resolves via /etc/hosts" || bad "getent hosts localhost"; } || bad "getent bundle"
echo "== T8 self-update refused"
"$T/b/run" update > /dev/null 2>&1; [ $? = 64 ] && ok "update refused (64)" || bad "update"
echo "## fixture rc=$rc"; exit $rc
