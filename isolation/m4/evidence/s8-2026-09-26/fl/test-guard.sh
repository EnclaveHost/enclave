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
exit $bad
