#!/bin/bash
# Demonstrates that harness-check.sh fails closed, with stub harnesses (no build,
# no model). Each case states what the check must do; the self-test fails if
# any case comes out the other way.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
. "$HERE/harness-check.sh"
bad=0
expect() {   # expect ok|fail DESCRIPTION CMD...
    local want=$1 what=$2; shift 2
    if "$@" > "$T/out" 2>&1; then got=ok; else got=fail; fi
    if [ "$got" = "$want" ]; then echo "PASS  ($want) $what"; else echo "WRONG (wanted $want, got $got) $what"; sed 's/^/      /' "$T/out"; bad=1; fi
}
mk() { printf '#!/bin/bash\n%s\n' "$2" > "$T/$1"; chmod +x "$T/$1"; }
mk pass        'echo "d=1 IDENTICAL"; echo "ALL IDENTICAL"; exit 0'
mk pass_rc1    'echo "ALL IDENTICAL"; exit 1'
mk no_passline 'echo "d=1 IDENTICAL"; exit 0'
mk dies        'echo "partial"; kill -SEGV $$'
expect ok   "harness exits 0 and prints its pass line"            run_equiv stub "ALL IDENTICAL" "$T/pass"
expect fail "harness prints the pass line but exits 1"            run_equiv stub "ALL IDENTICAL" "$T/pass_rc1"
expect fail "harness exits 0 without the pass line"               run_equiv stub "ALL IDENTICAL" "$T/no_passline"
expect fail "harness is killed by a signal"                       run_equiv stub "ALL IDENTICAL" "$T/dies"
# graph stubs: $1 model, $2 output file; ENCLAVE_GGML_CONV_INPLACE picks the arm
mk g_ok    'head -c 4096 /dev/zero > "$2"; echo "steps=3 rows=4 bytes=4096 n_vocab=256"'
mk g_rc    'head -c 4096 /dev/zero > "$2"; echo "steps=3 rows=4 bytes=4096 n_vocab=256"; [ "$ENCLAVE_GGML_CONV_INPLACE" = 1 ] && exit 3; exit 0'
mk g_zero  ': > "$2"; echo "steps=0 rows=0 bytes=0 n_vocab=256"'
mk g_diff  'if [ "$ENCLAVE_GGML_CONV_INPLACE" = 1 ]; then head -c 4096 /dev/zero > "$2"; else head -c 4095 /dev/zero > "$2"; printf x >> "$2"; fi; echo "steps=3 rows=4 bytes=4096 n_vocab=256"'
mk g_count 'head -c 4096 /dev/zero > "$2"; [ "$ENCLAVE_GGML_CONV_INPLACE" = 1 ] && echo "steps=3 rows=4 bytes=4096 n_vocab=256" || echo "steps=2 rows=4 bytes=4096 n_vocab=256"'
mkdir -p "$T/g"
expect ok   "graph: both arms finish, same nonzero counts, same bytes"   run_graph "$T/g_ok" m "$T/g"
expect fail "graph: one arm exits nonzero"                               run_graph "$T/g_rc" m "$T/g"
expect fail "graph: zero steps and an empty dump"                        run_graph "$T/g_zero" m "$T/g"
expect fail "graph: dumps differ in one byte"                            run_graph "$T/g_diff" m "$T/g"
expect fail "graph: the arms report different step counts"              run_graph "$T/g_count" m "$T/g"
# pair stubs: $1 output file; ENCLAVE_TEST_SW picks the arm
mk p_ok    'head -c 64 /dev/zero > "$1"; echo "cases=2 bytes=64"'
mk p_rc    'head -c 64 /dev/zero > "$1"; echo "cases=2 bytes=64"; [ "$ENCLAVE_TEST_SW" = 0 ] && exit 1; exit 0'
mk p_diff  'head -c 63 /dev/zero > "$1"; [ "$ENCLAVE_TEST_SW" = 1 ] && printf x >> "$1" || printf y >> "$1"; echo "cases=2 bytes=64"'
mk p_short 'head -c 32 /dev/zero > "$1"; echo "cases=2 bytes=64"'
mk p_zero  ': > "$1"; echo "cases=0 bytes=0"'
mkdir -p "$T/p"
expect ok   "pair: both arms finish with the same bytes"                 run_pair s "$T/p_ok" ENCLAVE_TEST_SW "$T/p"
expect fail "pair: one arm exits nonzero"                                run_pair s "$T/p_rc" ENCLAVE_TEST_SW "$T/p"
expect fail "pair: dumps differ in one byte"                             run_pair s "$T/p_diff" ENCLAVE_TEST_SW "$T/p"
expect fail "pair: dump shorter than the reported bytes"                 run_pair s "$T/p_short" ENCLAVE_TEST_SW "$T/p"
expect fail "pair: zero cases"                                           run_pair s "$T/p_zero" ENCLAVE_TEST_SW "$T/p"
# the script level: a failing check under set -euo pipefail stops everything after it
cat > "$T/script.sh" <<EOS
set -euo pipefail
. "$HERE/harness-check.sh"
run_equiv stub "ALL IDENTICAL" "$T/pass_rc1"
echo REACHED_AFTER_FAILURE
EOS
if bash "$T/script.sh" > "$T/sout" 2>&1 || grep -q REACHED_AFTER_FAILURE "$T/sout"; then echo "WRONG script continued past a failed check"; bad=1; else echo "PASS  (fail) script stops at the first failed check"; fi
[ $bad -eq 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit $bad
