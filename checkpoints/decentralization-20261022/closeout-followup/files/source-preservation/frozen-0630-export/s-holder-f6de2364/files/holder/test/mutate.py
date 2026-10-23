#!/usr/bin/env python3
"""Mutation controls for holder.py: each mutant breaks one property in a copy; test_holder.py must FAIL for each."""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path
SRC = Path(__file__).resolve().parent.parent
MUTANTS = {
  'inherit-env': ("    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': c['datadir'], 'TMPDIR': c['storage']['mountPoint'] + '/tmp',",
                  "    return {**os.environ, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': c['datadir'], 'TMPDIR': c['storage']['mountPoint'] + '/tmp',"),
  # storage script mutants (file holder-storage.sh.in; killed by test_storage.py)
  'sh:adopt-any-mapping': ('  [ "$have" = "$want" ] || die', '  true || die'),
  'sh:no-invalidate': ('  # INVALIDATE before the origin is touched: writethrough means no dirty blocks, so nothing is lost\n  dd if=/dev/zero of="$CMETA" bs=1M count=8 conv=notrunc,fsync status=none\n',
                       '  # MUTANT: no invalidation\n'),
  'sh:no-unwind': ('  [ "$rc" -eq 0 ] && return 0\n', '  return 0\n'),
  'sh:continue-after-failed-umount': ('umount "$MNT" || die "unmount of $MNT failed: stopping (nothing detached)"', 'umount "$MNT" || true'),
  'sh:measured-cap-ignored': ('  [ "$TOTAL" -le "$CAP" ] || { log "OVER CAP"; exit 3; }', '  true'),
  'public-http': ("'--http', '--http.addr', '127.0.0.1',", "'--http', '--http.addr', '0.0.0.0',"),
  'allow-writeback': ("    if k['mode'] != 'writethrough':", "    if k['mode'] not in ('writethrough', 'writeback'):"),
  'cap-off-by-slack': ("    holder = data + meta + slack\n", "    holder = data + meta\n"),
  'no-group-reap': ("        # the child is gone; reap anything left in its group (it must not outlive the supervisor)\n        self._signal_group(signal.SIGKILL)\n",
                    "        # MUTANT: no group reap\n"),
  'no-pdeathsig': ("        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)", "        pass"),
  'trust-l1': ("    if l1['trustRpc'] is not False:", "    if False:"),
  'verifier-port': ("    if c['verifierPort'] in tcp:", "    if False:"),
}
res = {}
for name, (old, new) in MUTANTS.items():
    d = Path(tempfile.mkdtemp(prefix='hm-'))
    try:
        shutil.copytree(SRC, d / 'holder', ignore=shutil.ignore_patterns('__pycache__'))
        p = d / 'holder' / ('holder-storage.sh.in' if name.startswith('sh:') else 'holder.py'); s = p.read_text()
        assert s.count(old) == 1, name
        p.write_text(s.replace(old, new))
        suite = 'test_storage.py' if name.startswith('sh:') else 'test_holder.py'
        r = subprocess.run([sys.executable, '-I', str(d / 'holder' / 'test' / suite)], capture_output=True, text=True, timeout=240)
        fails = [l for l in r.stderr.splitlines() if l.startswith(('FAIL:', 'ERROR:'))]
        res[name] = r.returncode != 0
        print('=== %s %s' % (name, 'KILLED' if r.returncode else 'SURVIVED'), *fails[:8], sep='\n  ', flush=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)
print('killed %d/%d' % (sum(res.values()), len(res)))
sys.exit(0 if all(res.values()) else 1)
