#!/usr/bin/env bash
# each mutant: a temp copy of this dir with one defect; the test must FAIL (exit 1)
set -u; D=$(cd "$(dirname "$0")" && pwd)
run() { t=$(mktemp -d); cp -r "$D/base" "$D/patched" "$D/src-87ce2b2fd" "$D/src-45801c22" "$D/activate-bridge-cap.ps1" "$D/test_durable.py" "$t/"; eval "$2"; python3 "$t/test_durable.py" >/dev/null 2>&1; rc=$?; echo "$1 -> exit $rc $( [ $rc -eq 1 ] && echo CAUGHT || echo MISSED )"; rm -rf "$t"; }
run "trailing space on the set line" "sed -i 's/^set SHIELDED_BRIDGE_MAX_CONNS=96$/set SHIELDED_BRIDGE_MAX_CONNS=96 /' \$t/patched/install-host.ps1"
run "value 64 instead of 96"        "sed -i 's/^set SHIELDED_BRIDGE_MAX_CONNS=96$/set SHIELDED_BRIDGE_MAX_CONNS=64/' \$t/patched/install-host.ps1"
run "line moved into node-config"   "python3 - \$t <<'P'
import sys,pathlib;p=pathlib.Path(sys.argv[1])/'patched/install-host.ps1';s=p.read_text();l='set SHIELDED_BRIDGE_MAX_CONNS=96\n';s=s.replace(l,'',1);i=s.index('node-config.cmd\")');j=s.rfind('\n',0,s.rfind('\n',0,i));p.write_text(s[:j+1]+l+s[j+1:])
P"
run "script inserts other text"     "sed -i 's/set SHIELDED_BRIDGE_MAX_CONNS=96/set SHIELDED_BRIDGE_MAX_CONNS=128/' \$t/activate-bridge-cap.ps1"
run "a \$ in a comment line"         "sed -i 's/^rem same as shield-egress/rem same as \$shield-egress/' \$t/patched/install-host.ps1"
