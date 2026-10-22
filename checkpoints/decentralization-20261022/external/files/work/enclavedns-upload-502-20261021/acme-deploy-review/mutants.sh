#!/usr/bin/env bash
# Mutation check of activate_certs.py: each mutant must make the unittest suite FAIL. Runs in a scratch copy.
set -u
S=$(mktemp -d); trap 'rm -rf $S' EXIT
cp activate_certs.py test_activate_certs.py $S/
cd $S
m() { cp $OLDPWD/activate_certs.py activate_certs.py; python3 - "$2" "$3" <<'P'
import sys; s=open("activate_certs.py").read(); a,b=sys.argv[1],sys.argv[2]
assert a in s, a; open("activate_certs.py","w").write(s.replace(a,b,1))
P
  if python3 -m unittest -q test_activate_certs >/dev/null 2>&1; then echo "SURVIVED $1"; else echo "killed   $1"; fi; }
m node-check 'run(["node", "--check", staged], timeout=60)' 'pass'
m inflight 'busy = sorted(n for n, (s, _) in state.items() if s == "inflight")' 'busy = []'
m sources 'raise Refused(f"{p} is newer than the running process; a restart would activate it too")' 'pass'
m rollback-cas 'if cur != a.candidate_sha:' 'if False:'
m accounts-fp 'if fp["accounts"] != fp_before["accounts"] or fp["accounts_fp"] != fp_before["accounts_fp"]:' 'if False:'
m base-cas 'if live != BASE_SHA:' 'if False:'
m unit-pin 'raise Refused(f"unit file changed: {f}")' 'pass'
