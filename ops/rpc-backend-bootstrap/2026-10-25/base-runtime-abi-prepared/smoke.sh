#!/bin/bash
# Smoke of a pinned Base runtime bundle (abi.py bundle). Usage: smoke.sh BUNDLE_DIR EXPECTED_BASE_SHA256
# Runs on the build host AND, unchanged, on the target guest (root): no network, no data dir, no install, bounded (30 s each).
# Pass = bundle files == SHA256SUMS, binary == expected pin, every library resolves inside the bundle, --version/--help
# work, the M7 flag (--l1.trust-rpc / BASE_NODE_L1_TRUST_RPC) is present, and `update` is refused by the wrapper.
set -uo pipefail
B=$(cd "${1:?bundle}" && pwd); E=${2:?expected base sha256}; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }
(cd "$B" && sha256sum -c --quiet SHA256SUMS) && ok "bundle files == SHA256SUMS" || bad "bundle files differ from SHA256SUMS"
[ "$(sha256sum < "$B/bin/base" | cut -c1-64)" = "$E" ] && ok "bin/base == expected $E" || bad "bin/base is not $E"
python3 -I "$(dirname "$0")/abi.py" guard "$B" > "$T/guard.json" && ok "every library resolves inside the bundle" || { bad "library resolution leaves the bundle"; cat "$T/guard.json"; }
echo "[info] host $(uname -sr); system glibc $(getconf GNU_LIBC_VERSION 2>/dev/null)"
HOME=$T timeout 30 "$B/run" --version > "$T/v" 2>&1 && ok "run --version" || bad "run --version"; sed 's/^/    /' "$T/v" | head -8
HOME=$T timeout 30 "$B/run" --help > "$T/h" 2>&1 && ok "run --help" || bad "run --help"
found=""; for s in $(sed -n '/^Commands:/,/^$/p' "$T/h" | awk 'NR>1 && $1!="help"{print $1}'); do
  HOME=$T timeout 30 "$B/run" $s --help > "$T/h-$s" 2>&1; grep -q BASE_NODE_L1_TRUST_RPC "$T/h-$s" && found="$found $s"
  for s2 in $(sed -n '/^Commands:/,/^$/p' "$T/h-$s" | awk 'NR>1 && $1!="help"{print $1}'); do
    HOME=$T timeout 30 "$B/run" $s $s2 --help 2>&1 | grep -q BASE_NODE_L1_TRUST_RPC && found="$found $s/$s2"; done; done
[ -n "$found" ] && ok "M7 flag present in:$found" || bad "M7 flag BASE_NODE_L1_TRUST_RPC not found in any subcommand help"
HOME=$T timeout 30 "$B/run" update > /dev/null 2>&1; [ $? = 64 ] && ok "self-update refused by the wrapper (64)" || bad "update not refused"
echo "## smoke rc=$rc"; exit $rc
