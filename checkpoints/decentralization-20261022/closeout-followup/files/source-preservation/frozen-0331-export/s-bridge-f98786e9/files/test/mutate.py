#!/usr/bin/env python3
"""Mutation controls: each mutant breaks one bridge property in a copy of the candidate; its suites must FAIL."""
import shutil, subprocess, sys, os
C = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the candidate repo (this file is test/mutate.py)
M = os.path.join(os.path.dirname(C), 'mutants')
MUTANTS = {
  'status-ignored': ("""                if status != b'\\1':""", """                if status not in (b'\\1', b'\\0', b''):""", 'harness bridge'),
  'no-stall-timeout': ("""                    if now - min(waiting) >= c['stalledSendSecs']:""", """                    if False:""", 'bridge'),
  'eof-closes-both': ("""            d.eof = True
            self._end(d, conn)""", """            d.eof = True
            self._close(conn, abort=False, why=None)""", 'bridge'),
  'no-idle-timeout': ("""                elif now - conn.last >= c['idleSecs']:""", """                elif False:""", 'bridge'),
  'no-limits': ("""        return self.per_ep[ep] < self.cfg['maxConnsPerEndpoint'] and len(self.conns) < self.max_conns""",
                """        return True""", 'bridge'),
  'evict-half-closed': ("""        return self.per_ep[ep] < self.cfg['maxConnsPerEndpoint'] and len(self.conns) < self.max_conns""",
                        """        for full, pool in ((lambda: self.per_ep[ep] >= self.cfg['maxConnsPerEndpoint'], lambda c: c.ep == ep),
                           (lambda: len(self.conns) >= self.max_conns, lambda c: True)):
            if full():
                half = [c for c in self.conns if pool(c) and c.state == 'relay' and (c.up.eof or c.down.eof)]
                if not half:
                    return False
                self._close(min(half, key=lambda c: c.last), abort=True, why='resets')
        return True""", 'bridge'),
  'half-idle-while-waiting': ("""                if waiting:  # bytes wait for a slow destination: only the stall deadline applies
                    if now - min(waiting) >= c['stalledSendSecs']:
                        self._close(conn, abort=True, why='stalledTimeouts')
                elif""", """                if waiting and now - min(waiting) >= c['stalledSendSecs']:
                    self._close(conn, abort=True, why='stalledTimeouts')
                elif""", 'bridge'),
  'stop-leaves-conns': ("""        self.stats['openAtStop'] = len(self.conns)
        for conn in list(self.conns):""", """        self.stats['openAtStop'] = len(self.conns)
        for conn in []:""", 'bridge'),
  'unbounded-queue': [("""                if d.src is sock and not d.eof and d.buf is None:""", """                if d.src is sock and not d.eof:"""),
                      ("""                if ev & selectors.EVENT_READ and d.src is sock and d.buf is None and not d.eof:""",
                       """                if ev & selectors.EVENT_READ and d.src is sock and not d.eof:"""),
                      ("""        conn.last = now
        self.stats['bytesAtoB' if d is conn.up else 'bytesBtoA'] += n
""", """        conn.last = now
        self.stats['bytesAtoB' if d is conn.up else 'bytesBtoA'] += n
        if d.buf is not None:  # MUTANT: queue without bound behind a slow destination
            d.buf[d.end:] = memoryview(self.scratch)[:n]
            d.end += n
            return
"""), 'bridge'],
}
src = open(os.path.join(C, 'runner.py')).read()
for name, spec in MUTANTS.items():  # every mutant applies exactly once before anything runs
    for old, _ in (spec[:-1] if isinstance(spec, list) else [spec[:2]]):
        assert src.count(old) == 1, name
os.makedirs(M, exist_ok=True)
fails = {}
only = sys.argv[1:]
for name, spec in MUTANTS.items():
    if only and name not in only:
        continue
    edits, suites = (spec[:-1], spec[-1]) if isinstance(spec, list) else ([spec[:2]], spec[2])
    d = os.path.join(M, name)
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(C, d, ignore=shutil.ignore_patterns('.git', '__pycache__'))
    p = os.path.join(d, 'runner.py')
    s = open(p).read()
    for old, new in edits:
        assert s.count(old) == 1, name
        s = s.replace(old, new)
    open(p, 'w').write(s)
    r = subprocess.run([os.path.join(d, 'run-tests.sh'), suites], capture_output=True, text=True, env=dict(os.environ, JOB_SEC="240", TESTS=os.environ.get("MUT_TESTS", "")))
    lines = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith(('FAIL:', 'ERROR:', 'Ran ', 'OK', 'FAILED'))]
    print('=== %s rc=%d (%s)' % (name, r.returncode, 'KILLED' if r.returncode else 'SURVIVED'), *lines, sep='\n  ', flush=True)
    fails[name] = r.returncode
    shutil.rmtree(d, ignore_errors=True)
print('mutants killed: %d/%d' % (sum(1 for v in fails.values() if v), len(fails)))
sys.exit(0 if all(fails.values()) else 1)
