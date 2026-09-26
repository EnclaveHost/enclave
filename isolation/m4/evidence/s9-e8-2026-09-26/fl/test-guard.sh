#!/usr/bin/env bash
# bf's should-fix test (fl-check v6): the switch guard, extracted VERBATIM from fl-check.sh, over 11 cases; a missing,
# null or non-numeric createdAt must HOLD, never skip. Exit 0 = every case as expected.
set -uo pipefail; D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
awk '/^CA=\$\(python3 -c/{f=1} f{print} /^done$/ && f{exit}' $D/fl-check.sh > $W/guard.sh
cat > $W/run.sh <<'EOS'
#!/usr/bin/env bash
set -uo pipefail; FST=$(mktemp -d); E=$1; GREL=$2; GID=gdtest
[ -n "$3" ] && echo "$3" > $FST/s8-switched-epoch; [ -n "$4" ] && echo "$4" > $FST/s7-switched-epoch
hold() { echo "HOLD: $*"; rm -rf "$FST"; exit 25; }
source "$(dirname "$0")/guard.sh"
echo PASS; rm -rf "$FST"
EOS
chmod +x $W/run.sh
# enclave-87's hard rule (09-26): nothing here may reach production. ssh/systemctl/journalctl/sudo/node/systemd-run are
# FAILING shims that record any call, and the run asserts none was made. curl stays real ONLY for the LIVE case (a read-only
# public GET) and the unreachable case (a closed local port); every other case replaces it with a fixture function.
SHIMD=$W/shim; mkdir -p $SHIMD; CALLS=$W/calls; : > $CALLS
for c in ssh systemctl journalctl sudo node systemd-run; do printf '#!/bin/sh\necho "%s $*" >> %s\nexit 97\n' "$c" "$CALLS" > $SHIMD/$c; chmod +x $SHIMD/$c; done
NOPY=$W/nopy; mkdir -p $NOPY; printf '#!/bin/sh\nexit 127\n' > $NOPY/python3; chmod +x $NOPY/python3   # an interpreter error
export PATH="$SHIMD:$PATH"
N=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; O=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; bad=0
t() { local want=$1 name=$2; shift 2; local got; got=$($W/run.sh "$@" 2>/dev/null | tail -1 | cut -c1-4); [ "$got" = "$want" ] && r=ok || { r=WRONG; bad=1; }; printf '%-5s %-4s %s\n' "$r" "$got" "$name"; }
t HOLD "no createdAt, S8+S7"            '{"id":"x"}'                 $N 1790000000 1780000000
t HOLD "createdAt null"                 '{"createdAt":null}'         $N 1790000000 1780000000
t HOLD "createdAt 'soon'"               '{"createdAt":"soon"}'       $N 1790000000 1780000000
t HOLD "S7 only, no createdAt"          '{}'                         $O "" 1780000000
t PASS "after S8 on 5db18199"           '{"createdAt":1790000100}'   $N 1790000000 1780000000
t HOLD "after S8 on f7888d86"           '{"createdAt":1790000100}'   $O 1790000000 1780000000
t PASS "S7..S8 on f7888d86"             '{"createdAt":1785000000}'   $O 1790000000 1780000000
t HOLD "S7..S8 on 5db18199"             '{"createdAt":1785000000}'   $N 1790000000 1780000000
t PASS "S7 only, on f7888d86"           '{"createdAt":1785000000}'   $O "" 1780000000
t HOLD "S7 only, on 5db18199"           '{"createdAt":1785000000}'   $N "" 1780000000
t PASS "fractional after S8, 5db18199"  '{"createdAt":1790000100.5}' $N 1790000000 1780000000
R9=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532
cat > $W/run9.sh <<'EOS'
#!/usr/bin/env bash
set -uo pipefail; FST=$(mktemp -d); E=$1; GREL=$2; GID=gdtest
[ -n "$3" ] && echo "$3" > $FST/s9-switched-epoch; [ -n "$4" ] && echo "$4" > $FST/s8-switched-epoch; [ -n "$5" ] && echo "$5" > $FST/s7-switched-epoch
hold() { echo "HOLD: $*"; rm -rf "$FST"; exit 25; }
source "$(dirname "$0")/guard.sh"
echo PASS; rm -rf "$FST"
EOS
chmod +x $W/run9.sh
t9() { local want=$1 name=$2; shift 2; local got; got=$($W/run9.sh "$@" 2>/dev/null | tail -1 | cut -c1-4); [ "$got" = "$want" ] && r=ok || { r=WRONG; bad=1; }; printf '%-5s %-4s %s\n' "$r" "$got" "$name"; }
t9 PASS "after S9 on aee2059f"               '{"createdAt":1795000100}' $R9 1795000000 1790000000 1780000000
t9 HOLD "after S9 on 5db18199"               '{"createdAt":1795000100}' $N  1795000000 1790000000 1780000000
t9 PASS "S8..S9 on 5db18199"                 '{"createdAt":1792000000}' $N  1795000000 1790000000 1780000000
t9 HOLD "S8..S9 on aee2059f"                 '{"createdAt":1792000000}' $R9 1795000000 1790000000 1780000000
t9 HOLD "S9 epoch, no createdAt"             '{}'                       $R9 1795000000 1790000000 1780000000
got=$(PATH="$NOPY:$PATH" $W/run.sh '{"createdAt":1790000100}' $N 1790000000 1780000000 2>/dev/null | tail -1 | cut -c1-4); [ "$got" = HOLD ] && echo "ok    HOLD python3 missing (an interpreter error): the guard fails CLOSED" || { echo "WRONG $got python3 missing"; bad=1; }
[ ! -s "$CALLS" ] && echo "ok    no ssh/systemctl/journalctl/sudo/node/systemd-run call was made" || { echo "WRONG a production tool was called: $(cat "$CALLS")"; bad=1; }
exit $bad
