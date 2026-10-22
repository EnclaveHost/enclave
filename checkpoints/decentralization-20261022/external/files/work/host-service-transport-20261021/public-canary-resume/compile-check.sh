#!/usr/bin/env bash
# Local only: byte-compile the re-pinned wrapper (syntax) and import-check its driver pin against the file on disk.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume
python3 -c "import py_compile;compile(open('root-hs2-r5d.py').read(),'root-hs2-r5d.py','exec');print('py_compile ok')"
python3 - <<'P'
import hashlib,pathlib,re
t=pathlib.Path('root-hs2-r5d.py').read_text();p,h=re.search(r'DRIVER = \(HERE\.parent\.parent / "([^"]+)", "([0-9a-f]{64})"\)',t).groups()
f=pathlib.Path('root-hs2-r5d.py').resolve().parent.parent.parent/p
print('driver',f,'pin matches file:',hashlib.sha256(f.read_bytes()).hexdigest()==h)
P
