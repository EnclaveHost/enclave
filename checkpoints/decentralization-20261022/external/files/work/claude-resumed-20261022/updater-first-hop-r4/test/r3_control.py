#!/usr/bin/env python3
"""Negative control: the r4 suite against r3 d57c5ef6 (logs/first-hop.r3-d57c5ef6.ps1, the bytes root applied natively) must FAIL
EXACTLY AA (Replace drift -> r3 ends RECOVERY_REQUIRED, as in root Apply 33600), AB (r3 never refuses before the replace) and
AC (r3 has no original-descriptor gate)."""
import hashlib, os, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent; r3 = H.parent / 'logs/first-hop.r3-d57c5ef6.ps1'
assert hashlib.sha256(r3.read_bytes()).hexdigest().startswith('d57c5ef6')
p = subprocess.run([sys.executable, '-B', str(H / 'first_hop_test.py')], capture_output=True, text=True, env=dict(os.environ, FH_SCRIPT=str(r3)), timeout=900)
failed = {l[5:].split(' ')[0] for l in p.stdout.splitlines() if l.startswith('FAIL ')}
want = {'AA', 'AB', 'AC'}
print(p.stdout[-2500:]); print('failed on r3 d57c5ef6:', sorted(failed), 'want', sorted(want)); ok = failed == want and p.returncode == 1
print('negative control', 'OK' if ok else 'MISMATCH'); sys.exit(0 if ok else 1)
