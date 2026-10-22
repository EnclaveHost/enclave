#!/bin/bash
set -uo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); S="$H/mut/p3dbg"; rm -rf "$S"; mkdir -p "$H/mut"; cp -al "$H/tree" "$S"
true python3 - "$S/relay/dns-relay.js" "$H/tree/relay/dns-relay.js" <<'PY'
import sys,os
src=open(sys.argv[2]).read(); o='LOOPBACK_RELAY.has(src)'; assert src.count(o)==1
t=sys.argv[1]+'.m'; open(t,'w').write(src.replace(o,'String(src).startsWith("127.")')); os.replace(t,sys.argv[1])
PY
python3 - "$S/test/route-dns-transport-rate.test.mjs" <<'PY'
import sys,os
p=sys.argv[1]; s=open(p).read(); o="  const other = await udpBurst(withT.port, 300, '127.0.0.2');"
assert s.count(o)==1; s=s.replace(o,o+"\n  console.log('DBG other', other, 'tcp-other', await tcpBurst(withT.port, 300, '127.0.0.2', 1500));")
t=p+'.m'; open(t,'w').write(s); os.replace(t,p)
PY
cd "$S" && node --test --test-reporter=spec test/route-dns-transport-rate.test.mjs 2>&1 | grep -E "✖|✔|answered|Error|DBG" | head -12
rm -rf "$S"
