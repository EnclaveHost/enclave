#!/usr/bin/env bash
# transport-probe.sh - the REAL end-to-end test of transfer-lib.sh copy_create_only between the actual hosts, with PUBLIC
# SYNTHETIC bytes only (root-authorized, limited probe writes). It creates ONE new dedicated directory on each host:
#   us-west: /root/claude-transport-probe-<id> (0700)
#   minipc:  C:\ProgramData\Enclave\claude-transport-probe-<id> (SYSTEM + Administrators only, inheritance removed: the same
#            ACL 12-prepare-relay-dir.ps1 gives the real relay directory)
# Nothing else is read or written; no service is touched. At the end it removes ONLY those two directories.
# The synthetic files (generated ON us-west, never on this workstation):
#   key67    "0x" + sha256("synthetic-probe-key-<id>") + "\n"   67 bytes, key-shaped, public
#   jrnl10k  journal-shaped JSON padding                         10240 bytes
#   bin1m    random bytes                                         1048576 bytes
# Cases:
#   forward us-west -> minipc: key67, jrnl10k and bin1m intact (host-side sha), and the final file's ACL;
#   an existing final is refused (nothing copied, the final unchanged);
#   an interrupted transfer (bandwidth-limited, timed out mid-copy) leaves no final and no temporary file;
#   reverse minipc -> us-west: jrnl10k intact, refused when present, and an interrupted reverse transfer leaves nothing.
#   bash transport-probe.sh us-west minipc            (prints one JSON evidence line last; exit 0 only if every case held)
set -euo pipefail
cd "$(dirname "$0")/.."; . ./transfer-lib.sh
SRC=${1:?us-west alias}; WIN=${2:?minipc alias}
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
LD=/root/claude-transport-probe-$ID
WD="C:\\ProgramData\\Enclave\\claude-transport-probe-$ID"
results=(); fail=0
rec() { results+=("\"$1\":\"$2\""); echo "== $1: $2"; [ "$3" = ok ] || fail=1; }
cleanup() {
  _lx "$SRC" "rm -rf '$LD'" || true
  _ps "$WIN" "if (Test-Path -LiteralPath '$WD') { Remove-Item -LiteralPath '$WD' -Recurse -Force }; 'removed ' + -not (Test-Path -LiteralPath '$WD')" || true
}
trap cleanup EXIT
# the probe directories (new; refuse if they exist)
_lx "$SRC" "test ! -e '$LD' && mkdir -m 0700 '$LD'"
_ps "$WIN" "if (Test-Path -LiteralPath '$WD') { throw 'exists' }; New-Item -ItemType Directory -Path '$WD' | Out-Null; icacls.exe '$WD' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; 'made'" | grep -qx made
# the synthetic public bytes, generated on us-west
_lx "$SRC" "cd '$LD' && printf '0x%s\n' \"\$(printf 'synthetic-probe-key-$ID' | sha256sum | cut -c1-64)\" > key67 && { printf '{\"nonce\":7,\"hash\":\"0x%064d\",\"raw\":\"0x' 0; head -c 10141 /dev/zero | tr '\\0' 'b'; printf '\"}\n'; } > jrnl10k && head -c 1048576 /dev/urandom > bin1m && stat -c '%n %s' key67 jrnl10k bin1m"
sizes=$(_lx "$SRC" "cd '$LD' && stat -c %s key67 jrnl10k bin1m | tr '\n' ' '")
[ "$sizes" = "67 10240 1048576 " ] && rec sizes "67/10240/1048576" ok || rec sizes "$sizes" bad
# forward
for f in key67 jrnl10k bin1m; do
  out=$(copy_create_only "$SRC" linux "$LD/$f" "$WIN" windows "$WD" "$f" 300 || true); echo "$out"
  [ "$out" = "$f: intact" ] && rec "forward_$f" intact ok || rec "forward_$f" "$out" bad
done
acl=$(_ps "$WIN" "((@((Get-Acl -LiteralPath '$WD\\key67').Access | ForEach-Object { \$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) | Sort-Object -Unique) -join ',')")
[ "$acl" = "S-1-5-18,S-1-5-32-544" ] && rec forward_acl "$acl" ok || rec forward_acl "$acl" bad
# an existing final is never overwritten, and nothing is copied
before=$(_sha "$WIN" windows "$WD\\key67")
out=$(copy_create_only "$SRC" linux "$LD/jrnl10k" "$WIN" windows "$WD" key67 300 || true); echo "$out"
[[ "$out" == *"refused: it already exists"* ]] && [ "$(_sha "$WIN" windows "$WD\\key67")" = "$before" ] && rec forward_existing_refused "refused, final unchanged" ok || rec forward_existing_refused "$out" bad
# interrupted mid-copy (200 Kbit/s for 1 MiB ~ 42 s; timed out after 8 s)
out=$(copy_create_only "$SRC" linux "$LD/bin1m" "$WIN" windows "$WD" bin1m-interrupted 8 200 || true); echo "$out"
left=$(_ps "$WIN" "@(Get-ChildItem -LiteralPath '$WD' -Force | Where-Object { \$_.Name -like '.incoming-*' -or \$_.Name -eq 'bin1m-interrupted' }).Count")
[[ "$out" == *"transfer FAILED"* ]] && [ "$left" = 0 ] && rec forward_interrupted "failed; no final, no temporary" ok || rec forward_interrupted "$out / leftovers $left" bad
# reverse: minipc -> us-west
out=$(copy_create_only "$WIN" windows "$WD\\jrnl10k" "$SRC" linux "$LD" jrnl10k.back 300 || true); echo "$out"
[ "$out" = "jrnl10k.back: intact" ] && [ "$(_sha "$SRC" linux "$LD/jrnl10k.back")" = "$(_sha "$SRC" linux "$LD/jrnl10k")" ] && rec reverse_jrnl10k intact ok || rec reverse_jrnl10k "$out" bad
mode=$(_lx "$SRC" "stat -c %a '$LD/jrnl10k.back'")
[ "$mode" = 600 ] && rec reverse_mode 600 ok || rec reverse_mode "$mode" bad
out=$(copy_create_only "$WIN" windows "$WD\\key67" "$SRC" linux "$LD" jrnl10k.back 300 || true); echo "$out"
[[ "$out" == *"refused: it already exists"* ]] && rec reverse_existing_refused "refused" ok || rec reverse_existing_refused "$out" bad
out=$(copy_create_only "$WIN" windows "$WD\\bin1m" "$SRC" linux "$LD" bin1m.back-interrupted 8 200 || true); echo "$out"
left=$(_lx "$SRC" "ls -A '$LD' | grep -c -e '^\.incoming-' -e '^bin1m.back-interrupted\$' || true")
[[ "$out" == *"transfer FAILED"* ]] && [ "$left" = 0 ] && rec reverse_interrupted "failed; no final, no temporary" ok || rec reverse_interrupted "$out / leftovers $left" bad
trap - EXIT; cleanup
gone=$(_ps "$WIN" "-not (Test-Path -LiteralPath '$WD')"); lgone=$(_lx "$SRC" "test ! -e '$LD' && echo True")
[ "$gone" = True ] && [ "$lgone" = True ] && rec probe_dirs_removed "both" ok || rec probe_dirs_removed "win $gone linux $lgone" bad
IFS=,; echo "{\"probe\":\"$ID\",\"at\":\"$(date -u +%FT%TZ)\",${results[*]},\"ok\":$([ $fail = 0 ] && echo true || echo false)}"
exit $fail
