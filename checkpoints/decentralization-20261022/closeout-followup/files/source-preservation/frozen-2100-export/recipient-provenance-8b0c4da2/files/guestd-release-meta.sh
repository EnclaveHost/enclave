#!/bin/bash
# Read-only: the running guestd's FULL argv (flag paths only; /proc/*/environ is never read), its binary sha256, and the
# public manifest fields + file list of the isolation directories it names. No config/key/env/fw_cfg file content is read.
p=$(pgrep -x -f '/home/steven/enclave-prod/bin/guestd\.[^ ]* .*' | head -1)
[ -n "$p" ] || p=$(pgrep -f 'enclave-prod/bin/guestd\.' | head -1)
echo "guestd PID $p started $(ps -o lstart= -p $p)"
tr '\0' '\n' < /proc/$p/cmdline | sed -E 's/^(.*(key|token|secret|password).*)$/\1   [path only]/I'
exe=$(readlink /proc/$p/exe); echo "exe $exe sha256 $(sha256sum "$exe" | cut -d' ' -f1) bytes $(stat -c %s "$exe") mtime $(stat -c %y "$exe")"
for d in $(tr '\0' '\n' < /proc/$p/cmdline | grep -E '^/home/steven/enclave-prod/(iso|metal)-' ); do
  echo "== $d"; ls -la --time-style=+%FT%T "$d" | head -30
  for m in "$d"/manifest.json "$d"/MANIFEST.json "$d"/*/manifest.json; do [ -f "$m" ] && { echo "-- $m sha256 $(sha256sum "$m" | cut -d' ' -f1)"; python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
def walk(o,p=''):
    if isinstance(o,dict):
        for k,v in o.items(): walk(v,p+'/'+k)
    elif isinstance(o,list): print(p, '[list %d]'%len(o), str(o)[:200])
    else: print(p, str(o)[:200])
walk(m)" "$m" | head -60; }; done
done
