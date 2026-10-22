#!/usr/bin/env bash
# Mutation checks: each mutant breaks one guarantee of the fix; the named test must FAIL on it.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; log="$here/logs/mutants.log"; : > "$log"; : > "$here/logs/mutants-summary.txt"
mk() { rm -rf "$here/mutant"; cp -a "$here/tree" "$here/mutant"; }
run() { # name, python-replacement (old, new), test-name-pattern
  mk
  python3 - "$here/mutant/cli/independent-signer.mjs" "$2" "$3" <<'PY'
import sys; p, a, b = sys.argv[1:4]; a, b = a.replace("\\n", "\n"), b.replace("\\n", "\n"); s = open(p).read(); assert s.count(a) == 1, ("mutation anchor", a); open(p, "w").write(s.replace(a, b))
PY
  for try in 1 2 3 4 5 6 7 8; do
    ( cd "$here/mutant" && "$here/run-guarded.sh" "$log" node --test --test-concurrency=1 --test-name-pattern="$4" test/cli-independent-signer-durability.test.mjs >/dev/null 2>&1 )
    rc=$?; [ $rc -ne 98 ] && break
  done
  echo "MUTANT $1: exit=$rc $([ $rc -eq 98 ] && echo NOT-STARTED || { [ $rc -ne 0 ] && echo KILLED || echo SURVIVED; })" | tee -a "$here/logs/mutants-summary.txt"
}
run no-file-fsync 'o += fs.writeSync(fd, b, o, b.length - o); fs.fsyncSync(fd); }' 'o += fs.writeSync(fd, b, o, b.length - o); }' '^durable writes: intents'
run no-dir-fsync '  if (WIN) return;
  const fd = fs.openSync(d, "r");' '  return;
  const fd = fs.openSync(d, "r");' '^durable writes: intents'
run no-post-record-check 'if (!isReleased(key)) return;' 'return;' '^(a hand release racing|hand release vs a holder in ANOTHER)'
run no-recheck-under-reservation 'assertFree();   // again under the reservation' '' '^an intent recorded between'
run no-auto-complete 'if (pass === 0 && !s.problems.length && bound.length' 'if (false && pass === 0 && !s.problems.length && bound.length' '^crash after the intent is decided'
run unreadable-ignored 'if (s.problems.length) throw new SignerError("state", `refusing to send:' 'if (false) throw new SignerError("state", `refusing to send:' '^an unreadable intent file'
run unknown-state-ignored 'export const isOpen = (rec) => !DECIDED.has(rec?.state);' 'export const isOpen = (rec) => UNRESOLVED.has(rec?.state);' '^an intent in a state'
run reopen-allowed 'if (!isOpen(cur) && isOpen(next)) next.state = cur.state;' '' '^a decided intent never reopens'
rm -rf "$here/mutant"
