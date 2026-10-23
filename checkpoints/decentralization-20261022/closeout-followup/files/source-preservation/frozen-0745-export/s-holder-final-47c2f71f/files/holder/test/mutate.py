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
  'sh:verify-bypassed': ('  if cached; then exec "$PY" -I "$BUDGET_TOOL" verify "$LEDGER" "$RESERVATION"; fi', '  if false; then :; fi'),
  'sh:admit-bypassed': ('    "$PY" -I "$BUDGET_TOOL" admit "$LEDGER" "$RESERVATION" "$CDATA=$CDATA_BYTES" "$CMETA=$CMETA_BYTES" \\\n      || die "NVMe cache budget reservation refused"',
                        '    true'),
  # budget.py mutants (file budget.py; killed by test_budget.py)
  'b:no-share-sum': ('    if sum(hosts.values()) > CAP:', '    if False:'),
  'b:no-per-host': ('        if u > hosts[m]:', '        if False:'),
  'b:allow-directory': ("KINDS = ('preallocated-files',)", "KINDS = ('preallocated-files', 'directory')"),
  'b:missing-ok': ('                check_file(f, r[\'id\'], must_exist=(r is mine))', '                check_file(f, r[\'id\'], must_exist=False)'),
  'b:allow-sparse': ("    if st.st_blocks * 512 < f['bytes']:", '    if False:'),
  'b:adopt-foreign': ("                if not os.path.exists(p + MARKER):\n                    fail(f'{p} exists without this reservation\\'s ownership marker: refusing (no reuse of foreign files)')\n"
                      "                if not stat.S_ISREG(os.lstat(p).st_mode) or not _owned(p, rid):",
                      "                if not stat.S_ISREG(os.lstat(p).st_mode):"),
  # accounting boundaries (2681e8a charged declared bytes only): each killed by test_budget.py Accounting/Rules
  'b:no-alignment': ("            if f['bytes'] % r['blockBytes']:", '            if False:'),
  'b:no-headroom': ('        if slack < need:', '        if False:'),
  'b:no-bookkeeping': ('    used, ids, paths = {m: BOOKKEEPING_BYTES for m in hosts}, set(), []', '    used, ids, paths = {m: 0 for m in hosts}, set(), []'),
  'b:markers-uncharged': ("    return sum(allocated(f['path']) + allocated(f['path'] + MARKER) for f in r['files']) + entry_bytes(r)",
                          "    return sum(allocated(f['path']) for f in r['files']) + entry_bytes(r)"),
  'b:no-prewrite-bound': ("        _bound(r, kept + markers + entry_bytes(r) + remaining + (step_headroom(r) if todo else 0), 'before any write')", '        pass'),
  'b:no-step-bound': ("                        _bound(r, actual_bytes(r) + remaining + step_headroom(r), f'before allocating {p} at {off}')", '                        pass'),
  'b:no-final-bound': ("            _bound(r, actual_bytes(r), 'after allocation')", '            pass'),
  'b:no-verify-actual': ("            if actual[r['id']] > r['maxBytes']:", '            if False:'),
  'b:any-block-size': ("        if bs != r['blockBytes']:", '        if False:'),
  'b:any-fs': ('        if fstype not in SUPPORTED_FS:', '        if False:'),
  'b:no-lock': ('        fcntl.flock(self.fd, self.mode)', '        pass'),
  'public-http': ("'--http', '--http.addr', '127.0.0.1',", "'--http', '--http.addr', '0.0.0.0',"),
  'allow-writeback': ("    if k['mode'] != 'writethrough':", "    if k['mode'] not in ('writethrough', 'writeback'):"),
  'cap-off-by-slack': ("    holder = data + meta + slack\n", "    holder = data + meta\n"),
  'no-group-reap': ("        # the child is gone; reap anything left in its group (it must not outlive the supervisor)\n        self._signal_group(signal.SIGKILL)\n",
                    "        # MUTANT: no group reap\n"),
  'no-pdeathsig': ("        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)", "        pass"),
  'trust-l1': ("    if l1['trustRpc'] is not False:", "    if False:"),
  'verifier-port': ("    if c['verifierPort'] in tcp:", "    if False:"),
  'cli-prune-flag': ("         '--ipcdisable',\n", "         '--ipcdisable', f\"--{c['prune']}\",\n"),
  'toml-exists-only': ("    if seg.get('sender_recovery') != 'full' or (c['prune'] == 'minimal' and seg.get('transaction_lookup') != 'full'):",
                       "    if False:"),
}
res = {}
only = sys.argv[1:]
for name, (old, new) in MUTANTS.items():
    if only and name not in only:
        continue
    d = Path(tempfile.mkdtemp(prefix='hm-'))
    try:
        shutil.copytree(SRC, d / 'holder', ignore=shutil.ignore_patterns('__pycache__'))
        p = d / 'holder' / ('holder-storage.sh.in' if name.startswith('sh:') else 'budget.py' if name.startswith('b:') else 'holder.py'); s = p.read_text()
        assert s.count(old) == 1, name
        p.write_text(s.replace(old, new))
        suite = 'test_storage.py' if name.startswith('sh:') else 'test_budget.py' if name.startswith('b:') else 'test_holder.py'
        r = subprocess.run([sys.executable, '-I', str(d / 'holder' / 'test' / suite)], capture_output=True, text=True, timeout=240)
        fails = [l for l in r.stderr.splitlines() if l.startswith(('FAIL:', 'ERROR:'))]
        res[name] = r.returncode != 0
        print('=== %s %s' % (name, 'KILLED' if r.returncode else 'SURVIVED'), *fails[:8], sep='\n  ', flush=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)
print('killed %d/%d' % (sum(res.values()), len(res)))
sys.exit(0 if all(res.values()) else 1)
