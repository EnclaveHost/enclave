#!/usr/bin/env python3
"""Rebuild native/stage from this package's r2 sources (EnclaveSetup.cs, BootstrapCheck.cs, bounded-query.ps1, native-bootstrap.ps1;
the other 12 files are r1's stage copies, unchanged) and rewrite the pins: the fixture's $PIN entries for the two C# sources and
run-native.py's FILES. Local only."""
import hashlib, pathlib, re, shutil
N = pathlib.Path(__file__).resolve().parent.parent; B = N.parent; S = N / 'stage'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
SRC = {'repo/windows/installer/EnclaveSetup.cs': B / 'src/EnclaveSetup.cs', 'BootstrapCheck.cs': N / 'BootstrapCheck.cs', 'bounded-query.ps1': N / 'bounded-query.ps1'}
fx = (N / 'native-bootstrap.ps1').read_text()
for rel, src in SRC.items():
    key = rel.replace('/', '\\'); fx, n = re.subn(r"('" + re.escape(key) + r"' = ')[0-9a-f]{64}'", lambda m: m.group(1) + sha(src) + "'", fx); assert n == 1, rel
(N / 'native-bootstrap.ps1').write_text(fx)
for rel, src in {**SRC, 'native-bootstrap.ps1': N / 'native-bootstrap.ps1'}.items(): shutil.copyfile(src, S / rel)
files = sorted(str(p.relative_to(S)) for p in S.rglob('*') if p.is_file())
d = N / 'run-native.py'; s = d.read_text(); i = s.index('FILES = {'); j = s.index('}\n', i) + 2
d.write_text(s[:i] + 'FILES = {\n' + ''.join(f"    '{f}': '{sha(S / f)}',\n" for f in files) + '}\n' + s[j:])
for f in files: print(sha(S / f)[:8], f)
