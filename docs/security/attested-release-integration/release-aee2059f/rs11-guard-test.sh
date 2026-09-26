#!/usr/bin/env bash
# rs-11's ROLLBACK GUARD, every branch (a)-(d), after the window (rs11-selftest.sh ran the pre-window checks: evidence/
# selftest-prewindow.txt). The measurement is passed in, so each branch decides alone; (d) runs on this host's REAL guestd records
# and on synthetic roots; rs-11.sh rollback is shown refusing at its guard on the live state. Read-only: nothing on nan changes.
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
# the wrapper, on the LIVE state: it must refuse at its guard (rc 4) and touch nothing on nan
m=$(node_meas metal-iso0); out=$(bash "$H/rs-11.sh" rollback 2>&1); rc=$?
[ $rc = 4 ] && grep -q "REFUSING rs-11 rollback" <<<"$out" && t ok "rs-11.sh rollback on the live state (node ${m:0:8}) refuses at its guard: ${out:0:110}" || t no "rs-11.sh rollback: rc $rc ${out:0:140}"
echo "rs11-guard-test: $((n-f))/$n"; [ $f = 0 ]
