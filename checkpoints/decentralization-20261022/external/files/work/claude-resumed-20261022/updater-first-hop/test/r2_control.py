#!/usr/bin/env python3
"""Negative control for R3: the current suite against r2 first-hop.ps1 1b573291 (logs/first-hop.r2-1b573291.ps1) must FAIL
EXACTLY the R3 scenarios V-Z (Queued / Unknown / unrecognized state / non-boolean Enabled / incoherent Disabled+enabled)."""
import hashlib, os, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent; r2 = H.parent / 'logs/first-hop.r2-1b573291.ps1'
assert hashlib.sha256(r2.read_bytes()).hexdigest().startswith('1b573291')
p = subprocess.run([sys.executable, '-B', str(H / 'first_hop_test.py')], capture_output=True, text=True, env=dict(os.environ, FH_SCRIPT=str(r2)), timeout=900)
failed = {(l[5:7] if l[6] == ' ' else l[5:8]).strip() for l in p.stdout.splitlines() if l.startswith('FAIL ')}
want = {'V', 'W', 'X', 'Y', 'Z'}
print('failed on r2 1b573291:', sorted(failed), 'want', sorted(want)); ok = failed == want and p.returncode == 1
print('negative control', 'OK' if ok else 'MISMATCH'); sys.exit(0 if ok else 1)
