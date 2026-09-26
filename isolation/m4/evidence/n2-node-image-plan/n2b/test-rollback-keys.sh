#!/usr/bin/env bash
# enclave-bf's required fix: n2b-rollback.sh's current-keys block (extracted VERBATIM between its markers) picks e7's keys
# until n2acc's state records a different key, then n2acc's; and public_ok4 / check_guestd4 read exactly KEYS4 / TSV4.
set -uo pipefail; D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; bad=0
awk '/^# BEGIN current-keys$/{f=1;next} /^# END current-keys$/{f=0} f' $D/n2b-rollback.sh > $W/blk.sh
[ "$(grep -c . $W/blk.sh)" -ge 4 ] || { echo "block not found"; exit 2; }
sed -i "s|^NAK=.*|NAK=$W/n2acc/state|" $W/blk.sh      # the one line pointed at the fixture
# enclave-87's hard rule (09-26): nothing here may reach production. ssh/systemctl/journalctl/sudo/node/systemd-run are
# FAILING shims that record any call, and the run asserts none was made. curl stays real ONLY for the LIVE case (a read-only
# public GET) and the unreachable case (a closed local port); every other case replaces it with a fixture function.
SHIMD=$W/shim; mkdir -p $SHIMD; CALLS=$W/calls; : > $CALLS
for c in ssh systemctl journalctl sudo node systemd-run; do printf '#!/bin/sh\necho "%s $*" >> %s\nexit 97\n' "$c" "$CALLS" > $SHIMD/$c; chmod +x $SHIMD/$c; done
NOPY=$W/nopy; mkdir -p $NOPY; printf '#!/bin/sh\nexit 127\n' > $NOPY/python3; chmod +x $NOPY/python3   # an interpreter error
export PATH="$SHIMD:$PATH"
mk() { mkdir -p $W/e7 $W/n2acc/state; printf '0ddbd824 1868e492\n395bed3e afedf53d\n4e62e60d 39223442\n' > $W/e7/k; printf 'x\t1868e492\n' > $W/e7/t; }
pick() { ( KEYS4=$W/e7/k; TSV4=$W/e7/t; source $W/blk.sh; echo "$KEYS4|$TSV4" ); }
t() { local want=$1 name=$2 got; got=$(pick); [ "$got" = "$want" ] && r=ok || { r=WRONG; bad=1; }; printf '%-5s %s -> %s\n' $r "$name" "${got//$W\//}"; }
rm -rf $W/e7 $W/n2acc; mk; rm -rf $W/n2acc
t "$W/e7/k|$W/e7/t" "n2acc never ran (no state dir): e7's keys"
mk; cp $W/e7/k $W/n2acc/state/canary-keys.txt; cp $W/e7/t $W/n2acc/state/canaries.tsv
t "$W/e7/k|$W/e7/t" "n2acc seeded, proofs not passed (same as e7): e7's keys"
sed -i 's/1868e492/NEWKEY00/' $W/n2acc/state/canary-keys.txt $W/n2acc/state/canaries.tsv
t "$W/n2acc/state/canary-keys.txt|$W/n2acc/state/canaries.tsv" "n2acc recorded hookbin's new key: n2acc's keys"
rm -f $W/n2acc/state/canaries.tsv
t "$W/e7/k|$W/e7/t" "n2acc state incomplete (no tsv): e7's keys (fail closed to the known set)"
# the consumers read exactly these variables (lib-e7.sh): public_ok4 reads $KEYS4, check_guestd4 reads $TSV4
grep -q 'done < \$KEYS4' ~/enclave-bench/e7-20260926/lib-e7.sh && echo "ok    public_ok4 reads \$KEYS4" || { echo "WRONG public_ok4 does not read \$KEYS4"; bad=1; }
grep -q 'python3 - \$ST/.guestd.json \$TSV4' ~/enclave-bench/e7-20260926/lib-e7.sh && echo "ok    check_guestd4 reads \$TSV4" || { echo "WRONG check_guestd4 does not read \$TSV4"; bad=1; }
# the block sits AFTER lib-e7/libn2 are sourced and BEFORE the gate and the post-checks use them
awk '/^# BEGIN current-keys$/{b=NR} /check_guestd4 >\/dev\/null && noncanary_empty/{g=NR} /wait_for 300 public_ok4/{p=NR} /source ~\/enclave-bench\/n2-20260926\/libn2.sh/{l=NR} END{exit !(l<b && b<g && g<p)}' $D/n2b-rollback.sh && echo "ok    order: sources < block < gate < post-check" || { echo "WRONG order"; bad=1; }
[ ! -s "$CALLS" ] && echo "ok    no ssh/systemctl/journalctl/sudo/node/systemd-run call was made" || { echo "WRONG a production tool was called: $(cat "$CALLS")"; bad=1; }
exit $bad
