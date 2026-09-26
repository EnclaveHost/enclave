#!/bin/sh
# The app runtime's seccomp STATEMENT (enclave-87: positive evidence that the filter is on, not only the absence of an
# error). Checked without root:
#   1. app-seccomp.h's statement is "seccomp sha256=<sha256 of the exact BPF program handed to the kernel> rules=<its
#      length>": recomputed here with Python's hashlib over the program's bytes, independently of sha256-min.h;
#   2. dominit's channel, its real spawn(): the app's child installs the filter (no_new_privs set here, as the drop sets it
#      in the guest), writes the statement on the close-on-exec pipe and execs; dominit prints the positive line and
#      records the statement, 0600, where the front reads it. The pipe must be CLOSED by the exec: dominit reads to EOF,
#      and a child that kept it (sleep 2) would hold that read for 2 s. A child that cannot install the filter states
#      nothing, and nothing is recorded.
# Mutants of dominit.c, each of which must fail: the pipe without O_CLOEXEC, the statement not written, the line not
# printed. The fd-4 channel of m3/domexec.c is checked in m3/test-domexec-frontuid.sh.
#
# usage: test-seccomp-statement.sh   (needs gcc, python3)
set -e
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

cat > "$d/stmt.c" <<'EOF'
#include "app-seccomp.h"
int main(void) {
    char st[160];
    if (app_seccomp_statement(st, sizeof st) < 0) return 1;
    fputs(st, stdout);
    const unsigned char *p = (const unsigned char *)app_seccomp_prog;
    for (size_t i = 0; i < sizeof app_seccomp_prog; i++) printf("%02x", p[i]);
    printf("\n%zu\n", sizeof app_seccomp_prog);
    return 0;
}
EOF
gcc -O2 -Wall -Wextra -Wno-unused-function -I"$here" -o "$d/stmt" "$d/stmt.c"
"$d/stmt" > "$d/stmt.out"
python3 - "$d/stmt.out" <<'EOF'
import hashlib, re, sys
line, hexbytes, size = open(sys.argv[1]).read().split("\n")[:3]
m = re.fullmatch(r"seccomp sha256=([0-9a-f]{64}) rules=(\d+)", line)
assert m, f"FAIL the statement's shape: {line!r}"
raw = bytes.fromhex(hexbytes)
assert len(raw) == int(size) and len(raw) % 8 == 0, "FAIL the program's size"
assert hashlib.sha256(raw).hexdigest() == m.group(1), f"FAIL the hash: {m.group(1)} != {hashlib.sha256(raw).hexdigest()}"
assert int(m.group(2)) == len(raw) // 8, f"FAIL rules={m.group(2)}, the program has {len(raw)//8} instructions"
print(f"ok   the statement's hash is sha256 of the {len(raw)} program bytes ({len(raw)//8} instructions): {m.group(1)[:16]}...")
EOF
want=$(head -1 "$d/stmt.out")

cat > "$d/h.c" <<'EOF'
#define main dominit_main
#include "dominit.c"
#undef main
#include <time.h>
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
/* one app start through dominit's own channel: argv is what the child execs; nnp: whether it may install the filter */
int main(int argc, char **argv) {
    if (argc < 3) return 2;
    if (strcmp(argv[1], "nnp") == 0 && prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 2;
    double t0 = now();
    pid_t pid = spawn_app(argv + 2, NULL, SPAWN_FILTER);   /* dominit's own channel, as main uses it */
    printf("statement read in %.2f s\n", now() - t0);
    fflush(stdout);
    int st = 0;
    waitpid(pid, &st, 0);
    printf("child exit %d\n", WIFEXITED(st) ? WEXITSTATUS(st) : -1);
    return 0;
}
EOF
run_all() {  # <dominit.c> -> 0 only if every check passes
  mkdir -p "$d/b" && cp "$1" "$d/b/dominit.c" && cp "$here/app-seccomp.h" "$here/sha256-min.h" "$d/b/"
  rm -rf "$d/sdir"
  gcc -O2 -Wall -Wno-unused-function -I"$d/b" -DSECCOMP_DIR="\"$d/sdir\"" -o "$d/h" "$d/h.c" 2>"$d/cc.txt" || { echo "FAIL dominit did not build: $(head -3 "$d/cc.txt")"; return 1; }
  rc=0
  "$d/h" nnp /bin/sleep 2 > "$d/run.txt" 2>&1 || true
  if grep -qx "DOM seccomp: app filter installed (sha256 $(echo "$want" | sed 's/.*sha256=\([0-9a-f]*\).*/\1/'), $(echo "$want" | sed 's/.*rules=//') rules)" "$d/run.txt"
  then echo "ok   dominit printed the positive line: $(grep '^DOM seccomp' "$d/run.txt" | cut -c1-60)..."
  else echo "FAIL no positive line: $(tr '\n' ' ' < "$d/run.txt" | cut -c1-200)"; rc=1; fi
  if [ -f "$d/sdir/seccomp" ] && [ "$(cat "$d/sdir/seccomp")" = "$want" ] && [ "$(stat -c %a "$d/sdir/seccomp")" = 600 ] && [ "$(stat -c %a "$d/sdir")" = 700 ]
  then echo "ok   the statement is recorded for the front, 0600 in a 0700 directory, byte for byte"
  else echo "FAIL the recorded statement: $(cat "$d/sdir/seccomp" 2>&1 | head -1) ($(stat -c %a "$d/sdir/seccomp" 2>&1))"; rc=1; fi
  secs=$(sed -n 's/^statement read in \([0-9.]*\) s$/\1/p' "$d/run.txt")
  if [ -n "$secs" ] && python3 -c "import sys; sys.exit(0 if float('$secs') < 1.0 else 1)"
  then echo "ok   the exec closed the pipe: dominit's read ended in ${secs} s while the app (sleep 2) ran on"
  else echo "FAIL the app held the statement pipe past its exec (read took ${secs:-?} s)"; rc=1; fi
  rm -rf "$d/sdir"
  "$d/h" none /bin/true > "$d/run2.txt" 2>&1 || true
  if grep -q "^child exit 125$" "$d/run2.txt" && ! grep -q "^DOM seccomp:" "$d/run2.txt" && [ ! -e "$d/sdir/seccomp" ]
  then echo "ok   a child that cannot install the filter states nothing and is not started (exit 125)"
  else echo "FAIL without the filter: $(tr '\n' ' ' < "$d/run2.txt" | cut -c1-200)"; rc=1; fi
  return $rc
}
set +e
run_all "$here/dominit.c"; g=$?
[ $g = 0 ] && echo "seccomp statement: PASS" || echo "seccomp statement: FAIL"
mut() {  # <label> <python replace: old> <new>
  python3 - "$here/dominit.c" "$d/mutant.c" "$2" "$3" <<'EOF'
import sys; src, dst, old, new = sys.argv[1:5]; s = open(src).read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w").write(s.replace(old, new))
EOF
  [ $? = 0 ] || { echo "FAIL mutant $1: the edit did not apply"; return 1; }
  if run_all "$d/mutant.c" > "$d/mutant.log" 2>&1; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-160)"
}
k=0
mut "the statement pipe without O_CLOEXEC" '    if (pipe2(sfd, O_CLOEXEC) != 0) {' '    if (pipe2(sfd, 0) != 0) {' || k=1
mut "the statement not written" '            if (n < 0 || write(seccomp_status_fd, st, (size_t)n) != n) {' '            if (n < 0) {' || k=1
mut "the positive line not printed" '    printf("DOM seccomp: app filter installed (sha256 %s, %u rules)\n", hex, rules);' '    (void)rules;' || k=1
[ $k = 0 ] && echo "seccomp statement mutants: all killed" || echo "seccomp statement mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
