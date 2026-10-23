#!/bin/bash
# Read-only: public release.json / runtime.json fields of the guestd CPU release and adopted runtimes, and receipts naming the
# guestd binary hash or the CPU release (text files only, no node_modules/.git).
for r in release-16c2999d release-0181bce3 release-6757d139; do
  f=/home/steven/enclave-prod/$r/release.json; [ -f $f ] || continue
  echo "== $f sha256 $(sha256sum $f | cut -d' ' -f1)"
  python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
def walk(o,p=''):
    if isinstance(o,dict):
        for k,v in o.items(): walk(v,p+'/'+k)
    elif isinstance(o,list): print(p,'[list %d]'%len(o), str(o)[:180])
    else: print(p,str(o)[:180])
walk(m)" $f | head -45
done
echo "== receipts naming guestd 9d1562738cde / release 16c2999d"
grep -rIl --exclude-dir=node_modules --exclude-dir=.git --include='*.json' --include='*.md' --include='*.txt' -e '9d1562738cde' -e 'release-16c2999d' -e '16c2999d' /home/steven/Documents/Codex/2026-10-18/wo/work /home/steven/Documents/Codex/2026-10-18/wo/outputs /home/steven/enclave-prod 2>/dev/null | grep -v '/checkpoints/decentralization-20261022/' | head -30
