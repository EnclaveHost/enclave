#!/bin/bash
# base-bytecode-check v2 release candidate: ABI launch + REFUSAL-ONLY smoke on the Ubuntu RPC guest. PREPARED; NOT run by Claude.
# Reconstructs root's v1 procedure (bytecode-native-validated/release-evidence/ubuntu-smoke.out: pinned sha, usage refusal,
# absent-database refusal, no directory created) as a pinned script, plus two v2 refusals (extra argument, non-UTF-8 datadir).
# NEVER touches a real datadir: every datadir argument is a path INSIDE the fresh private smoke dir that does not exist.
# Root, on the guest, in a NEW private dir holding only this script and the binary:
#   env -i PATH=/usr/bin:/bin LANG=C.UTF-8 unshare -n timeout 300 bash $DIR/abi-smoke.sh $DIR b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7
set -uo pipefail
D=$(cd "${1:?DIR}" && pwd -P); WANT=${2:?binary sha256}; BIN=$D/base-bytecode-check; rc=0
PIN=b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7; SIZE=1276048
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }; die() { echo "[FAIL] $1"; echo "## abi-smoke rc=2 (refused before launch)"; exit 2; }
h() { sha256sum < "$1" | cut -c1-64; }
echo "== environment audit (refusals happen BEFORE the binary is launched)"
[ "$WANT" = "$PIN" ] || die "argument sha $WANT is not the release pin $PIN"
n=$(env | grep -c '^LD_'); [ "$n" = 0 ] && ok "no LD_* variable" || die "$n LD_* variables"
[ ! -e /etc/ld.so.preload ] && ok "/etc/ld.so.preload absent" || die "/etc/ld.so.preload present (the loader reads it)"
[ "$(id -u)" = 0 ] || die "run as root on the guest (private root-owned dir)"
[ "$(stat -c '%u %a' "$D")" = "0 700" ] || die "$D must be owned by root with mode 700"
case "$D" in /srv/*|/var/lib/*|/opt/enclave-rpc*) die "$D is under a service/data tree: use a fresh private dir (e.g. /root/enclave-rpc-bytecode-v2-abi-<UTC>)";; esac
[ "$(ls -A "$D" | sort | tr '\n' ' ')" = "abi-smoke.sh base-bytecode-check " ] || die "$D must contain exactly abi-smoke.sh and base-bytecode-check (fresh dir)"
[ -f "$BIN" ] && [ ! -L "$BIN" ] || die "binary missing or a symlink"
[ "$(h "$BIN")" = "$PIN" ] && [ "$(stat -c %s "$BIN")" = "$SIZE" ] && ok "binary sha256 $PIN size $SIZE" || die "binary sha/size differ from the release pin"
chmod 0500 "$BIN" || die chmod
TO=$(command -v timeout) && [ -x "$TO" ] || die "timeout(1) not found"
echo "[info] $(uname -srm); $( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown OS}"); system $(getconf GNU_LIBC_VERSION)"
echo "[info] network interfaces up: $(ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | tr '\n' ' ')"
echo "== launch + refusal cases (each: stdin /dev/null, empty environment, timeout 30 s, must exit 1 with the exact message)"
case_() { # <label> <expected substring> <args...>
  local label=$1 want=$2; shift 2
  out=$(cd "$D" && env -i "$TO" 30 "$BIN" "$@" < /dev/null 2>&1); r=$?
  printf '%s\n' "$out" | sed "s/^/    [$label] /"
  [ $r = 1 ] && printf '%s' "$out" | grep -qF -- "$want" && ok "$label: rc=1 and refused as expected" || bad "$label: rc=$r (want 1 + '$want')"
}
case_ usage 'usage: base-bytecode-check <datadir>'
case_ extra-arg 'usage: base-bytecode-check <datadir>' "$D/absent-a" "$D/absent-b"
case_ absent-db 'Could not open database at path:' "$D/absent-datadir"
case_ non-utf8 'datadir is not UTF-8' "$(printf '%s/absent-\xff' "$D")"         # a real 0xff byte in the path
echo "== nothing created, binary unchanged"
[ "$(ls -A "$D" | sort | tr '\n' ' ')" = "abi-smoke.sh base-bytecode-check " ] && ok "no file or directory was created in $D" || bad "the smoke dir changed: $(ls -A "$D" | tr '\n' ' ')"
[ "$(h "$BIN")" = "$PIN" ] && ok "binary unchanged" || bad "binary changed"
[ $rc = 0 ] && echo "ABI launch/refusal smoke PASS; no live database accessed" || echo "ABI launch/refusal smoke FAILED; no live database accessed"
echo "## abi-smoke rc=$rc"; exit $rc
