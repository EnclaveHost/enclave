#!/usr/bin/env python3
"""Derive jobs/canonical-mutants-repaired.sh from the FROZEN verifier-canonical-stage/jobs/canonical-mutants.sh (c2264d15) by
exact, counted substitutions that touch ONLY the harness: source the ORIGINAL common.sh read-only; work dirs under this
repair stage; `--no-fail-fast` so every requested binary runs; record cargo's real exit code; judge with the corrected
check_cargo_mutant.py (exact footer, exit 101, all binaries). Every mutation, named test, restore, M0 and the informational
I1-I3 are byte-identical. Usage: make-repaired-mutants.py ORIGINAL OUT | --check ORIGINAL OUT"""
import hashlib, sys
ORIG = "c2264d151d6e19bfdf3dc8caf0dbe9d7d7f1d95603bffbed31c4ce06af166ee2"
RS = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-controls-repair"
S = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage"
SUBS = [
 ('#   ./jobs/q-exit-status.sh canonical-mutants 2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-mutants.sh',
  '#   CANONICAL_CACHE_FROM=<ended run> ./jobs/q-exit-status.sh canonical-mutants-repaired-N 2560 unshare -rn bash verifier-canonical-controls-repair/jobs/canonical-mutants-repaired.sh\n'
  '# REPAIRED harness (verifier-canonical-controls-repair): --no-fail-fast, cargo exit recorded, corrected exact-footer checker.'),
 ('. "$(dirname "$0")/common.sh"',
  f'. {S}/jobs/common.sh   # the ORIGINAL, sourced read-only (S = the frozen stage: patch, PATCHED.sha256, EXPECTED-CONTROLS)\n'
  f'RS={RS}; CHECK=$RS/jobs/check_cargo_mutant.py'),
 ('X=$S/run/mutants-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1;', 'X=$RS/run/mutants-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1;'),
 ('  timeout -k 10 1800 cargo test --offline --locked -p helios-core $bins -- --test-threads=1 > $X/$n.out 2>&1',
  '  timeout -k 10 1800 cargo test --offline --locked --no-fail-fast -p helios-core $bins -- --test-threads=1 > $X/$n.out 2>&1; local trc=$?; echo $trc > $X/$n.rc'),
 ("  # killed ONLY by each named test's own assertion panic (check_cargo_output.py mutant); a compiler error is INVALID",
  "  # killed ONLY with cargo exit 101, every requested binary run, cargo's exact footer, and each named test's own assertion panic"),
 ('  python3 $S/jobs/check_cargo_output.py mutant $X/$n.out "$@" > $X/$n.verdict; local v=$?; cat $X/$n.verdict',
  '  python3 -I $CHECK --out $X/$n.out --rc $trc --controls $S/EXPECTED-CONTROLS.txt --bins "$bins" "$@" > $X/$n.verdict; local v=$?; cat $X/$n.verdict'),
 ('  case $v in 0) echo "$n: KILLED ($*)";; 3) echo "$n: INVALID (compiler error)"; rc=1;; *) echo "$n: SURVIVED"; rc=1;; esac',
  '  case $v in 0) echo "$n: KILLED ($*)";; 1) echo "$n: SURVIVED"; rc=1;; *) echo "$n: INVALID (see $n.verdict; never a kill)"; rc=1;; esac'),
 ('echo "== informational (expected SURVIVE: defence in depth)"',
  'echo "== informational (expected SURVIVE: defence in depth; reported separately, never counted as kills or failures)"'),
]
def derive(p):
    raw = open(p, "rb").read(); assert hashlib.sha256(raw).hexdigest() == ORIG, "not the frozen canonical-mutants.sh c2264d15"
    s = raw.decode()
    for a, b in SUBS:
        assert s.count(a) == 1, ("anchor not exactly once", a[:70]); s = s.replace(a, b)
    return s
if __name__ == "__main__":
    if sys.argv[1] == "--check": sys.exit(0 if derive(sys.argv[2]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1]))
