#!/usr/bin/env python3
"""Negative control: the suite against the PRE-root-review first-hop.ps1 0b8748a0 (logs/first-hop.pre-root-review-0b8748a0.ps1)
must FAIL exactly the scenarios root's two required fixes address: Q (unknown next run accepted), J/R/S/T/U (post-replace
errors: unguarded or no restore, no RECOVERY_REQUIRED)."""
import os, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent; old = H.parent / 'logs/first-hop.pre-root-review-0b8748a0.ps1'
import hashlib; assert hashlib.sha256(old.read_bytes()).hexdigest().startswith('0b8748a0')
p = subprocess.run([sys.executable, '-B', str(H / 'first_hop_test.py')], capture_output=True, text=True, env=dict(os.environ, FH_SCRIPT=str(old)), timeout=900)
failed = {(l[5:7] if l[6] == ' ' else l[5:8]).strip() for l in p.stdout.splitlines() if l.startswith('FAIL ')}
want = {'J', 'Q', 'R', 'S', 'T', 'U'}
print('failed on 0b8748a0:', sorted(failed), 'want', sorted(want)); print('negative control', 'OK' if failed == want and p.returncode == 1 else 'MISMATCH')
sys.exit(0 if failed == want and p.returncode == 1 else 1)
