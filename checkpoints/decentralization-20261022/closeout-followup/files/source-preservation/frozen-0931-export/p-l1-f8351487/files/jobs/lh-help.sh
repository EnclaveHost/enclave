#!/bin/bash
# Offline (unshare -rn): the verified Lighthouse v8.3.2 binary's own version/help, its dynamic deps, every rendered flag
# present in its own help, and a diff against the pinned SOURCE help (book/src/help_bn.md @ a376defa).
set -u
cd "$(dirname "$0")/.." || exit 2
L=bin-staging/lighthouse-v8.3.2/lighthouse; O=evidence/lighthouse-help-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"
sha256sum "$L" | tee "$O/binary.sha256"
file "$L" > "$O/file.txt" 2>&1; ldd "$L" > "$O/ldd.txt" 2>&1; cat "$O/file.txt" "$O/ldd.txt"
E="unshare -rn env -i PATH=/usr/bin:/bin HOME=/nonexistent"
$E "$L" --version > "$O/version.txt" 2>&1; echo "version rc=$?" | tee -a "$O/rc.txt"; cat "$O/version.txt"
$E "$L" beacon_node --help > "$O/bn-help.txt" 2>&1; echo "bn-help rc=$?" | tee -a "$O/rc.txt"
python3 -I - "$O/bn-help.txt" <<'PY'
import importlib.util, json, re, sys, copy
sys.path.insert(0, 'l1pair/test')
spec = importlib.util.spec_from_file_location('l1pair', 'l1pair/l1pair.py'); L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
from test_l1pair import good
text = open(sys.argv[1]).read()
src = open('evidence/sources/lighthouse-v8.3.2/book/src/help_bn.md').read()
body = src.split('```', 2)[1].strip('\n') if '```' in src else src
same = [l.rstrip() for l in body.splitlines()] == [l.rstrip() for l in text.strip('\n').splitlines()]
print('binary help == pinned source help_bn.md:', same)
cfgs = {'file/semi': good()}
c = good(); c['consensus']['custody'] = 'supernode'; cfgs['file/super'] = c
c = good(); c['p2p']['nat'] = 'extip:203.0.113.7'; cfgs['extip'] = c
c = good(); c['consensus']['checkpoint'] = {'mode': 'url', 'url': 'https://bn.example/', 'wss': good()['consensus']['checkpoint']['wss'],
    'provenance': good()['consensus']['checkpoint']['provenance'], 'oneTimeBootstrapUrlAcknowledged': True}; cfgs['url'] = c
miss = {}
for n, raw in cfgs.items():
    flags = sorted({f for f in L.cl_argv(L.validate(raw)) if f.startswith('--')})
    miss[n] = [f for f in flags if not L._help_has(text, f)]
    print(n, len(flags), 'flags, missing:', miss[n])
sys.exit(0 if not any(miss.values()) else 4)
PY
echo "flagcheck rc=$?" | tee -a "$O/rc.txt"
(cd "$O" && sha256sum *.txt > SHA256SUMS)
