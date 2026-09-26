#!/usr/bin/env bash
# rs-11's ROLLBACK GUARD, every branch (a)-(d), after the window (rs11-selftest.sh ran the pre-window checks: evidence/
# selftest-prewindow.txt). The measurement is passed in, so each branch decides alone; (d) runs on this host's REAL guestd records
# and on synthetic roots; the wrapper only as a SANDBOXED copy (stub lib, NAN=false, failing ssh/git/gh, fixture curl).
# Read-only: nothing on nan, GitHub or the live relay can be reached by any case.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs11-lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
E=$(mktemp); rm -f "$E"; G=$(mktemp -d); mk() { mkdir -p "$G/$1"; printf '%s' "$2" > "$G/$1/instance.json"; }
pass() { local why; why=$(S9_EPOCH=${EP:-$E} GUESTD_ROOT=${GR:-$GUESTD_ROOT} rollback_guard "$2") && t ok "$1 -> passes" || t no "$1 -> refuses: $why"; }
refuse() { local why; why=$(S9_EPOCH=${EP:-$E} GUESTD_ROOT=${GR:-$GUESTD_ROOT} rollback_guard "$2") && t no "$1 -> PASSES" || t ok "$1 -> refuses (${why:0:90})"; }
# (a)/(c): the node's measurement
pass   "node on 02f6e313 (f6cbd75a), no S9, the REAL guestd records ($(ls -d $GUESTD_ROOT/gd* | wc -l), all 5db18199)" "$LIVE_NODE"
refuse "(a) node on N1" "$N1"; refuse "(a) node on N2" "$N2"; refuse "(c) node unreadable" "absent"
# (b) the S9 epoch
echo 1790410000 > "$E"; refuse "(b) S9 epoch present" "$LIVE_NODE"; rm -f "$E"
# (d) the guestd records
mk gdaaaa "{\"Releases\":[\"$K\"]}"; mk gdbbbb "{\"Releases\":[\"$K\"]}"
GR=$G pass "(d) synthetic records on 5db18199 only" "$LIVE_NODE"
mk gdcccc "{\"Releases\":[\"$R\"]}"; GR=$G refuse "(d) a record naming R" "$LIVE_NODE"
mk gdcccc "{\"Releases\":[\"$K\",\"$R\"]}"; GR=$G refuse "(d) a record naming 5db18199 AND R" "$LIVE_NODE"; rm -rf "$G/gdcccc"
mkdir -p "$G/gddddd"; GR=$G refuse "(d) a guest dir without a record" "$LIVE_NODE"; rm -rf "$G/gddddd"
mk gdeeee "{not json"; GR=$G refuse "(d) a malformed record" "$LIVE_NODE"; rm -rf "$G/gdeeee"
mk gdffff "{\"Other\":1}"; GR=$G refuse "(d) a record without a Releases list" "$LIVE_NODE"; rm -rf "$G/gdffff"
GR=$G/no-such-dir refuse "(d) an unreadable guestd root" "$LIVE_NODE"
rm -rf "$G"
# (d) the check itself failing must REFUSE (enclave-5d: an exact "clear" is the only pass): python3 missing, garbage, nothing
SH=$(mktemp -d)
PATH="$SH" rollback_guard "$LIVE_NODE" >/dev/null 2>&1 && t no "(d) python3 NOT on PATH -> PASSES" || t ok "(d) python3 not on PATH -> refuses ($(PATH="$SH" rollback_guard "$LIVE_NODE" 2>&1 | head -c 70))"
printf '#!/bin/sh\necho "Traceback (most recent call last): boom"\nexit 0\n' > "$SH/python3"; chmod 755 "$SH/python3"
PATH="$SH:$PATH" rollback_guard "$LIVE_NODE" >/dev/null && t no "(d) a traceback with exit 0 -> PASSES" || t ok "(d) a traceback (exit 0) -> refuses"
printf '#!/bin/sh\nexit 0\n' > "$SH/python3"; PATH="$SH:$PATH" rollback_guard "$LIVE_NODE" >/dev/null && t no "(d) empty output -> PASSES" || t ok "(d) empty output (exit 0) -> refuses ($(PATH="$SH:$PATH" rollback_guard "$LIVE_NODE"))"
printf '#!/bin/sh\necho clear; echo "Traceback: late"\n' > "$SH/python3"; PATH="$SH:$PATH" rollback_guard "$LIVE_NODE" >/dev/null && t no "(d) clear + trailing traceback -> PASSES" || t ok "(d) 'clear' followed by a traceback -> refuses"
rm -rf "$SH"
# the WRAPPER, only as a SANDBOXED COPY (enclave-87's hard rule: a test never calls a production apply/rollback path on live
# state): rs-11.sh + rs11-lib.sh copied into a temp dir; its shared lib replaced by a stub (NAN=false); ssh, git, gh FAIL and curl
# answers a FIXTURE /enclaves from shims on PATH - so even a regressed guard cannot reach nan, GitHub or the live relay
SB=$(mktemp -d); mkdir -p $SB/bin $SB/pkg $SB/three-line
cp "$H/rs-11.sh" "$H/rs11-lib.sh" $SB/pkg/; : > $SB/three-line/rs4-remote.sh
printf 'RS=%s; LOG=%s/log; NAN=false\nsay() { echo "$*"; }\n' "$SB" "$SB" > $SB/stub-lib.sh
sed -i "s#source ~/enclave-bench/relay-slice-20260925/lib.sh#source $SB/stub-lib.sh#" $SB/pkg/rs-11.sh
grep -q "source $SB/stub-lib.sh" $SB/pkg/rs-11.sh || t no "HARNESS: the stub lib did not apply"
for c in ssh git gh; do printf '#!/bin/sh\necho "SHIM-CALLED %s $*" >> %s/shim.log; exit 1\n' "$c" "$SB" > $SB/bin/$c; done
fix() { printf '#!/bin/sh\necho "SHIM-CALLED curl" >> %s/curl.log; echo %s\n' "$SB" "'{\"enclaves\":[{\"name\":\"metal-iso0\",\"measurement\":\"$1\"}]}'" > $SB/bin/curl; chmod 755 $SB/bin/*; }
G=$(mktemp -d); mkdir -p $G/gdaaaa; printf '{"Releases":["%s"]}' "$K" > $G/gdaaaa/instance.json
wr() { PATH="$SB/bin:$PATH" S9_EPOCH=$E GUESTD_ROOT=${1} bash $SB/pkg/rs-11.sh rollback 2>&1; }
fix "$N2";        out=$(wr $G); rc=$?; [ $rc = 4 ] && grep -q "REFUSING rs-11 rollback: metal-iso0 attests fab9c6c7" <<<"$out" && t ok "SANDBOXED rs-11.sh rollback, fixture node on N2 -> refuses at its guard (rc 4)" || t no "sandboxed wrapper, node N2: rc $rc ${out:0:100}"
mkdir -p $G/gdbbbb; printf '{"Releases":["%s"]}' "$R" > $G/gdbbbb/instance.json
fix "$LIVE_NODE"; out=$(wr $G); rc=$?; [ $rc = 4 ] && grep -q "names aee2059f" <<<"$out" && t ok "SANDBOXED rs-11.sh rollback, a record naming R -> refuses at its guard (rc 4)" || t no "sandboxed wrapper, R record: rc $rc ${out:0:100}"
rm -rf $G/gdbbbb
out=$(wr $G); rc=$?; [ $rc != 0 ] && [ $rc != 4 ] && t ok "SANDBOXED rs-11.sh rollback, guard CLEAR -> proceeds into the stub (NAN=false) and stops rc $rc: nothing can act" || t no "sandboxed wrapper, clear: rc $rc ${out:0:100}"
[ ! -s $SB/shim.log ] && t ok "no ssh/git/gh was called by the sandboxed wrapper (curl only answered the fixture)" || t no "a network shim was called: $(cat $SB/shim.log)"
rm -rf "$SB" "$G"
echo "rs11-guard-test: $((n-f))/$n"; [ $f = 0 ]
