#!/usr/bin/python3 -I
"""q2_extract_confinement.py (guest-state-qualification-stage/r2; PREPARED, never run by Claude). GUEST, root, VM on, no network needed.
Q2 of logs/claude-guest-state-install-review.md, DIRECT form: the REAL pinned base binary itself (reth 7134be3 legacy
`snapshot download --url file://`, tar 0.4.46 unpack) -- NOT the guest_state.py helper (that is Q2b, separate) -- extracts each tiny
fixture under the IDENTICAL systemd sandbox of the frozen CANDIDATE extract unit: every [Service] property passed verbatim to
systemd-run except ExecStart (-> the extractor argv guest_state.py builds) and ReadWritePaths (-> <scratch>/stage <scratch>/x-home), plus
the one reviewed bound RuntimeMaxSec. The child environment equals guest_state.py's.

r2 fixes root's false-PASS findings on r1:
  * preconditions FAIL CLOSED: `systemd-analyze verify` rc != 0, `base --version` rc != 0 / empty -> refuse (rc 2);
  * the fixture map must be EXACTLY the prepared 11 entries (positive control `good` + 10 hostile families) with their exact
    expectations; each fixture's tar members (read IN MEMORY via `zstd -dc`, nothing unpacked) must equal fixtures.json;
  * a case qualifies ONLY from transient-unit evidence that the pinned binary actually ran: systemd-run's own summary
    ("Main processes terminated with: code=exited/status=N") AND the binary's own log line "Extracting local archive"
    (reth extract.rs:346). Client timeout, launch/setup failure (no summary, status 200-245 = systemd exec setup errors),
    signal/timeout/core results, or a missing extraction marker are SETUP/INCONCLUSIVE and NEVER qualify (case FAIL);
  * the exact owned transient unit (a fresh unique name that must not pre-exist) is verified INACTIVE with MainPID 0 (or unloaded)
    BEFORE any inspection or the next case; after a client timeout ONLY that unit is stopped and re-verified; if it cannot be
    verified stopped the run ABORTS (no further cases, no cleanup: never inspect or overwrite while a writer may live).
PASS per case: good -> ran, exit 0, staging exactly the declared bytes; refused-or-confined -> ran, and (genuine refusal: exit 1-199
with the marker) or (exit 0 and staging not exact); refused-or-neutralized -> ran, and genuine refusal or (exit 0 and staging exact,
i.e. special mode bits stripped); ALWAYS: decoy + rest of <scratch> byte-identical and datadir metadata unchanged (else ESCAPE).
Exit 0 all 11 PASS; 1 a case failed/inconclusive; 2 refused precondition; 3 aborted (owned unit not verifiably stopped).
"""
import argparse, hashlib, io, json, os, re, shutil, stat, subprocess, sys, tarfile, time, uuid

REQUIRED_SANDBOX = {'ProtectSystem': 'strict', 'PrivateNetwork': 'yes', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '',
                    'User': 'root', 'PrivateDevices': 'yes'}
NOT_PASSED = ('ExecStart', 'ReadWritePaths')
FIXTURE_FORMAT = 'enclave-guest-qualification-fixtures/r2'
EXPECT = {'good': 'extracted-exact', 'abs-path': 'refused-or-confined', 'traversal': 'refused-or-confined',
          'symlink-write-through': 'refused-or-confined', 'symlink-relative': 'refused-or-confined', 'hardlink-abs': 'refused-or-confined',
          'hardlink-rel': 'refused-or-confined', 'extra-file': 'refused-or-confined', 'device-node': 'refused-or-confined',
          'outside-db': 'refused-or-confined', 'setuid-bits': 'refused-or-neutralized'}
GOOD_PATHS = {'db/database.version', 'db/lock', 'db/mdbx.dat', 'db/mdbx.lck'}
MARKER = 'Extracting local archive'
SETUP_STATUS = range(200, 246)                       # systemd EXIT_* codes for exec setup failures (CHDIR, NAMESPACE, SECCOMP, EXEC, ...)
SYSTEMCTL, SYSTEMD_RUN, ANALYZE = '/usr/bin/systemctl', '/usr/bin/systemd-run', '/usr/bin/systemd-analyze'


class Refuse(Exception):
    def __init__(self, rc, msg, **kw):
        super().__init__(msg); self.rc, self.kw = rc, kw


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- pure logic (covered by test/test_q2_logic.py; NOT native) ---------
def service_properties(unit_text):
    props, sect = [], None
    for raw in unit_text.splitlines():
        line = raw.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('['):
            sect = line; continue
        if sect == '[Service]' and '=' in line:
            k, v = line.split('=', 1); props.append((k.strip(), v.strip()))
    return props


def check_sandbox(props):
    keys = {}
    for k, v in props:
        keys.setdefault(k, v)
    for k, v in REQUIRED_SANDBOX.items():
        if keys.get(k) != v:
            raise Refuse(2, f'candidate unit lacks {k}={v}: not the reviewed sandbox', got=keys.get(k))
    if 'ExecStart' not in keys or 'ReadWritePaths' not in keys:
        raise Refuse(2, 'candidate unit lacks ExecStart/ReadWritePaths')


def validate_fixture_map(fx):
    """the map must be EXACTLY the prepared 11 fixtures with their expectations and the 4 declared good outputs"""
    if not isinstance(fx, dict) or fx.get('format') != FIXTURE_FORMAT:
        raise Refuse(2, 'fixtures.json format is not ' + FIXTURE_FORMAT)
    f = fx.get('fixtures')
    if not isinstance(f, dict) or set(f) != set(EXPECT):
        raise Refuse(2, 'fixture map is not exactly the prepared 11 (control + 10 hostile families)',
                     missing=sorted(set(EXPECT) - set(f or {})), extra=sorted(set(f or {}) - set(EXPECT)))
    for name, e in f.items():
        if not isinstance(e, dict) or e.get('expect') != EXPECT[name] or not re.fullmatch(r'[0-9a-f]{64}', str(e.get('sha256', ''))) \
                or e.get('file') != f'{name}.tar.zst' or not isinstance(e.get('members'), list) or not e['members']:
            raise Refuse(2, f'fixture entry {name} malformed or with a wrong expectation')
    g = fx.get('goodOutputs')
    if not isinstance(g, dict) or set(g) != GOOD_PATHS or any(not isinstance(v, dict) or not isinstance(v.get('size'), int)
                                                              or not re.fullmatch(r'[0-9a-f]{64}', str(v.get('sha256', ''))) for v in g.values()):
        raise Refuse(2, 'goodOutputs is not exactly the 4 declared outputs with sizes and sha256')
    if not isinstance(fx.get('decoy'), str) or not fx['decoy'].startswith('/'):
        raise Refuse(2, 'fixtures.json decoy missing')


def tar_members(raw_tar):
    """(name, type, linkname, mode) of every member, read in memory; nothing is extracted"""
    with tarfile.open(fileobj=io.BytesIO(raw_tar), mode='r:') as tf:
        return [[m.name, m.type.decode('latin-1'), m.linkname, m.mode] for m in tf.getmembers()]


def parse_run_summary(text, journal=''):
    """systemd-run --wait (not --quiet) summary -> dict, or None if the unit never produced one (launch failure). The status is the
    leading integer of `status=N[/NAME]`; a bare name falls back to the unit's journal line `Main process exited, code=X, status=N/..`.
    Anything else stays non-numeric (-> unclassified -> never PASS)."""
    res = re.search(r'Finished with result: (\S+)', text)
    term = re.search(r'Main processes terminated with: code=(\w+)/status=(\S+)', text)
    if not res or not term:
        return None
    raw = term.group(2); m = re.match(r'(\d+)', raw)
    if m:
        st = int(m.group(1))
    elif raw == 'SUCCESS':
        st = 0
    else:
        j = re.findall(r'Main process exited, code=(\w+), status=(\d+)', journal)
        st = int(j[-1][1]) if j and j[-1][0] == term.group(1) else raw
    return {'result': res.group(1), 'code': term.group(1), 'status': st, 'raw': raw}


def classify_run(client, summary, output):
    """-> ('ran-ok'|'ran-refused'|'setup'|'timeout'|'abnormal'|'unclassified', why). Only ran-* can ever qualify."""
    if client == 'timeout':
        return 'timeout', 'client timeout: never qualifies'
    if summary is None:
        return 'setup', 'no transient-unit summary: the unit never ran the binary (launch/setup failure)'
    if summary['code'] != 'exited':
        return 'abnormal', f'main process {summary["code"]} ({summary["status"]}), result {summary["result"]}'
    st = summary['status']
    if not isinstance(st, int):
        return 'unclassified', f'non-numeric status {st}'
    if st in SETUP_STATUS:
        return 'setup', f'systemd exec setup failure status {st}'
    if MARKER not in output:
        return 'unclassified', f'exit {st} without the binary\'s "{MARKER}" log line: not shown to have run the extraction'
    if st == 0 and summary['result'] == 'success':
        return 'ran-ok', 'exit 0'
    if 1 <= st <= 199 and summary['result'] == 'exit-code':
        return 'ran-refused', f'genuine extractor refusal, exit {st}'
    return 'unclassified', f'exit {st} with result {summary["result"]}'


def verdict(expect, run_kind, exact, escape, stopped):
    if escape:
        return 'FAIL', 'ESCAPE: decoy/scratch/datadir changed'
    if not stopped:
        return 'FAIL', 'owned unit not verified stopped'
    if run_kind not in ('ran-ok', 'ran-refused'):
        return 'FAIL', f'inconclusive ({run_kind}): never qualifies'
    if expect == 'extracted-exact':
        return ('PASS', 'extracted exactly') if run_kind == 'ran-ok' and exact else ('FAIL', 'positive control not extracted exactly')
    if expect == 'refused-or-confined':
        if run_kind == 'ran-refused':
            return 'PASS', 'refused by the pinned binary'
        return ('PASS', 'extracted but staging not exact (install refuses)') if not exact else ('FAIL', 'hostile fixture staged as exact')
    if expect == 'refused-or-neutralized':
        if run_kind == 'ran-refused':
            return 'PASS', 'refused by the pinned binary'
        return ('PASS', 'special mode bits stripped; staging exact') if exact else ('FAIL', 'staging differs from the neutralized form')
    return 'FAIL', f'unknown expectation {expect}'


# ---------------------------------------------------------------- guest side effects -------------------------------------------------
def fingerprint(root, content=True, skip=()):
    out = {}
    for dp, dns, fns in os.walk(root, followlinks=False):
        rel = os.path.relpath(dp, root)
        dns[:] = [d for d in dns if os.path.normpath(os.path.join(rel, d)) not in skip]
        for n in dns + fns:
            p = os.path.join(dp, n); st = os.lstat(p); r = os.path.normpath(os.path.join(rel, n))
            dig = sha256(p) if content and stat.S_ISREG(st.st_mode) else (os.readlink(p) if stat.S_ISLNK(st.st_mode) else None)
            out[r] = (stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns, st.st_ino, st.st_nlink, dig)
    return out


def staged_exact(stage, good):
    seen = set()
    for dp, dns, fns in os.walk(stage, followlinks=False):
        rel = os.path.relpath(dp, stage)
        for d in dns:
            r = os.path.normpath(os.path.join(rel, d))
            if r != 'db' or os.path.islink(os.path.join(dp, d)):
                return False, f'unexpected directory {r}'
        for n in fns:
            r = os.path.normpath(os.path.join(rel, n)); p = os.path.join(dp, n); st = os.lstat(p)
            if r not in good or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != good[r]['size'] \
                    or st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX) or sha256(p) != good[r]['sha256']:
                return False, f'not a declared regular single-link file with the expected bytes and no special bits: {r}'
            seen.add(r)
    missing = sorted(set(good) - seen)
    return (False, f'missing {missing}') if missing else (True, 'exact')


def unit_state(unit):
    r = subprocess.run([SYSTEMCTL, 'show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
                        '-p', 'Result', '-p', 'InvocationID'], capture_output=True, text=True, timeout=30)
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def is_stopped(s):
    return s.get('LoadState') == 'not-found' or (s.get('ActiveState') in ('inactive', 'failed') and s.get('MainPID', '0') == '0')


def ensure_stopped(unit, after_timeout):
    """our exact transient unit (fresh unique name, verified absent before launch) must be stopped before any inspection; if it is
    still active (client timeout or otherwise) stop ONLY it, then verify inactive/failed with MainPID 0 (or unloaded)"""
    ev = {'before': unit_state(unit), 'afterClientTimeout': after_timeout}
    if not is_stopped(ev['before']):
        ev['stopIssued'] = True
        subprocess.run([SYSTEMCTL, 'stop', unit], capture_output=True, text=True, timeout=180)
    for _ in range(60):
        s = unit_state(unit)
        if is_stopped(s):
            ev['after'] = s; return True, ev
        time.sleep(1)
    ev['after'] = unit_state(unit)
    return False, ev


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--candidate-unit', required=True); ap.add_argument('--candidate-unit-sha256', required=True)
    ap.add_argument('--base-bin', required=True); ap.add_argument('--base-bin-sha256', required=True)
    ap.add_argument('--fixtures-dir', required=True); ap.add_argument('--fixtures-json-sha256', required=True)
    ap.add_argument('--scratch', required=True, help='NEW dir under /srv/enclave-base-holder/tmp/gsq-r2/ (created 0700 here)')
    ap.add_argument('--datadir', default='/srv/enclave-base-holder/data')
    ap.add_argument('--zstd', default='/usr/bin/zstd')
    ap.add_argument('--case-timeout', type=int, default=300)
    a = ap.parse_args()
    try:
        return run(a)
    except Refuse as e:
        print(json.dumps({'event': 'refused', 'rc': e.rc, 'reason': str(e), **e.kw}), flush=True); return e.rc


def run(a):
    if os.getuid() != 0:
        raise Refuse(2, 'run as root (the candidate unit runs as root)')
    if not 30 <= a.case_timeout <= 3600:
        raise Refuse(2, '--case-timeout must be within 30..3600 s')
    sc = os.path.normpath(a.scratch)
    if not sc.startswith('/srv/enclave-base-holder/tmp/gsq-r2/') or os.path.lexists(sc):
        raise Refuse(2, '--scratch must be a NEW path under /srv/enclave-base-holder/tmp/gsq-r2/')
    if sha256(a.candidate_unit) != a.candidate_unit_sha256:
        raise Refuse(2, 'candidate extract unit is not the pinned candidate')
    props = service_properties(open(a.candidate_unit).read()); check_sandbox(props)
    if sha256(a.base_bin) != a.base_bin_sha256:
        raise Refuse(2, 'base binary is not the pinned one')
    fj = os.path.join(a.fixtures_dir, 'fixtures.json')
    if sha256(fj) != a.fixtures_json_sha256:
        raise Refuse(2, 'fixtures.json is not the root-pinned fixture record')
    fx = json.load(open(fj)); validate_fixture_map(fx)
    for name, f in fx['fixtures'].items():
        p = os.path.join(a.fixtures_dir, f['file'])
        if sha256(p) != f['sha256']:
            raise Refuse(2, f'fixture {name} differs from fixtures.json')
        z = subprocess.run([a.zstd, '-dc', p], capture_output=True, timeout=60)
        if z.returncode != 0 or tar_members(z.stdout) != f['members']:
            raise Refuse(2, f'fixture {name} members differ from fixtures.json (read in memory, not extracted)')
    decoy = os.path.join(sc, 'decoy')
    if fx['decoy'].rstrip('/') != decoy:
        raise Refuse(2, 'fixtures were generated for another decoy path', fixtures_decoy=fx['decoy'], expected=decoy)
    av = subprocess.run([ANALYZE, 'verify', a.candidate_unit], capture_output=True, text=True, timeout=120)
    if av.returncode != 0:
        raise Refuse(2, 'systemd-analyze verify failed on the candidate unit', out=(av.stdout + av.stderr)[-2000:])
    ver = subprocess.run([a.base_bin, '--version'], capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    if ver.returncode != 0 or not ver.stdout.strip():
        raise Refuse(2, 'base --version failed', rc=ver.returncode, out=(ver.stdout + ver.stderr)[-500:])
    os.makedirs('/srv/enclave-base-holder/tmp/gsq-r2', mode=0o700, exist_ok=True)
    os.mkdir(sc, 0o700)
    for d in ('stage', 'x-home', 'decoy', 'fixtures', 'logs'):
        os.mkdir(os.path.join(sc, d), 0o700)
    with open(os.path.join(decoy, 'victim'), 'xb') as f:
        f.write(b'decoy victim bytes\n')
    for f in fx['fixtures'].values():
        shutil.copyfile(os.path.join(a.fixtures_dir, f['file']), os.path.join(sc, 'fixtures', f['file']))
    passed = [(k, v) for k, v in props if k not in NOT_PASSED]
    rec = {'format': 'enclave-guest-qualification-q2/r2', 'form': 'DIRECT base binary (Q2b = guest_state.py helper, separate)',
           'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'candidateUnitSha256': a.candidate_unit_sha256,
           'baseBinSha256': a.base_bin_sha256, 'baseVersion': ver.stdout.strip()[:400], 'fixturesJsonSha256': a.fixtures_json_sha256,
           'systemdAnalyzeVerify': {'rc': 0, 'out': (av.stdout + av.stderr)[-2000:]}, 'scratch': sc,
           'sandboxPassedVerbatim': passed, 'sandboxReplaced': {'ReadWritePaths': f'{sc}/stage {sc}/x-home', 'ExecStart': 'extractor argv'},
           'sandboxAdded': {'RuntimeMaxSec': a.case_timeout}, 'cases': {}}
    data_before = fingerprint(a.datadir, content=False) if os.path.isdir(a.datadir) else {}
    tag = uuid.uuid4().hex[:12]; ok_all = True; aborted = False
    for name in sorted(EXPECT, key=lambda n: (n != 'good', n)):          # positive control first
        f = fx['fixtures'][name]
        for d in ('stage', 'x-home'):
            p = os.path.join(sc, d); shutil.rmtree(p); os.mkdir(p, 0o700)
        outside_before = fingerprint(sc, skip=('stage', 'x-home', 'logs'))
        unit = f'gsq-r2-{tag}-{name}.service'
        if unit_state(unit).get('LoadState') != 'not-found':
            raise Refuse(3, f'transient unit name {unit} already exists: never adopted')
        cmd = [SYSTEMD_RUN, '--wait', '--pipe', f'--unit={unit}']             # no --quiet: the summary is the run evidence
        for k, v in passed:
            cmd += ['-p', f'{k}={v}']
        cmd += ['-p', f'ReadWritePaths={sc}/stage {sc}/x-home', '-p', f'RuntimeMaxSec={a.case_timeout}',
                '-E', 'PATH=/usr/bin:/bin', '-E', f'HOME={sc}/x-home', '-E', f'TMPDIR={sc}/x-home', '-E', 'LC_ALL=C',
                '--', a.base_bin, 'snapshot', 'download', '--chain', 'base', '--datadir', f'{sc}/stage', '--url',
                'file://' + os.path.join(sc, 'fixtures', f['file'])]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=a.case_timeout + 60, stdin=subprocess.DEVNULL)
            client, out = r.returncode, r.stdout + r.stderr
        except subprocess.TimeoutExpired as e:
            client, out = 'timeout', f'client timeout after {a.case_timeout + 60}s: {e}'
        stopped, unit_ev = ensure_stopped(unit, after_timeout=(client == 'timeout'))
        jr = subprocess.run(['/usr/bin/journalctl', '-u', unit, '-o', 'cat', '--no-pager'], capture_output=True, text=True, timeout=60)
        with open(os.path.join(sc, 'logs', f'{name}.log'), 'x') as lf:
            lf.write(' '.join(cmd) + '\n\n--- systemd-run ---\n' + out + '\n--- journal ---\n' + jr.stdout[-20000:])
        if not stopped:
            rec['cases'][name] = {'verdict': 'FAIL', 'why': 'owned transient unit not verifiably stopped: run ABORTED', 'unit': unit,
                                  'unitEvidence': unit_ev}
            aborted = True; ok_all = False
            print(json.dumps({'case': name, **rec['cases'][name]}), flush=True)
            break                                                             # never inspect or reuse scratch while a writer may live
        summary = parse_run_summary(out, jr.stdout)
        kind, why = classify_run(client, summary, out + '\n' + jr.stdout)
        exact, exact_why = staged_exact(os.path.join(sc, 'stage'), fx['goodOutputs'])
        outside_after = fingerprint(sc, skip=('stage', 'x-home', 'logs'))
        data_after = fingerprint(a.datadir, content=False) if os.path.isdir(a.datadir) else {}
        escape = outside_after != outside_before or data_after != data_before
        v, vwhy = verdict(f['expect'], kind, exact, escape, stopped)
        errs = sorted(set(re.findall(r'(Read-only file system|Permission denied|Operation not permitted|EROFS|EACCES|EPERM|'
                                     r'outside of the|invalid path|error unpacking[^\n]{0,120})', out + jr.stdout)))
        rec['cases'][name] = {'verdict': v, 'why': vwhy, 'expect': f['expect'], 'client': client, 'summary': summary, 'run': kind,
                              'runWhy': why, 'stagedExact': exact, 'stagedWhy': exact_why, 'escape': escape, 'unit': unit,
                              'unitEvidence': unit_ev, 'refusalEvidence': errs, 'log': f'logs/{name}.log'}
        ok_all &= v == 'PASS'
        print(json.dumps({'case': name, 'verdict': v, 'why': vwhy, 'run': kind}), flush=True)
    rec['result'] = 'ABORTED' if aborted else ('PASS' if ok_all and len(rec['cases']) == len(EXPECT) else 'FAIL')
    with open(os.path.join(sc, 'q2-result.json'), 'x') as fh:
        json.dump(rec, fh, indent=1); fh.write('\n')
    print(json.dumps({'event': 'q2-result', 'result': rec['result'], 'record': os.path.join(sc, 'q2-result.json')}), flush=True)
    return 3 if aborted else (0 if rec['result'] == 'PASS' else 1)


if __name__ == '__main__':
    sys.exit(main())
