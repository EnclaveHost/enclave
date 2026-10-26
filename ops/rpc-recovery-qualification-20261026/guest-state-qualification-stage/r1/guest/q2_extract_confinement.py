#!/usr/bin/python3 -I
"""q2_extract_confinement.py (guest-state-qualification-stage/r1; PREPARED, never run by Claude). GUEST, root, VM on, no network needed.
Q2 of logs/claude-guest-state-install-review.md: the REAL pinned base binary (reth 7134be3 legacy `snapshot download --url file://`,
i.e. tar 0.4.46 archive.unpack) extracts each tiny fixture under the IDENTICAL systemd sandbox of the CANDIDATE extract unit:
every [Service] property of the candidate unit file is passed to `systemd-run` verbatim, except
  ExecStart       -> the base binary itself (the same argv guest_state.py builds: snapshot download --chain base --datadir STAGE --url file://F)
  ReadWritePaths  -> <scratch>/stage <scratch>/x-home  (the candidate's two extractor-writable dirs, scratch copies)
plus ONE added bound: RuntimeMaxSec=<--case-timeout>. The child environment equals guest_state.py's (PATH, HOME=x-home, TMPDIR=x-home,
LC_ALL). Hostile fixtures aim at <scratch>/decoy (outside the writable paths), never at data/.
PASS per case: good -> rc 0, staging EXACTLY the declared set (sizes + sha256); hostile -> extractor refused OR staging not exact (the
install exact-set check would refuse); and ALWAYS: decoy byte-identical, nothing in <scratch> outside stage/x-home changed, and the datadir
metadata fingerprint unchanged. Any decoy/datadir change is an ESCAPE (FAIL). Writes nothing outside <scratch>. Never starts retention.
Exit 0 only if every case passes; 2 refused precondition; 1 a case failed.
"""
import argparse, hashlib, json, os, re, shutil, stat, subprocess, sys, time

REQUIRED_SANDBOX = {'ProtectSystem': 'strict', 'PrivateNetwork': 'yes', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '',
                    'User': 'root', 'PrivateDevices': 'yes'}
NOT_PASSED = ('ExecStart', 'ReadWritePaths')


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def die(msg, **kw):
    print(json.dumps({'event': 'refused', 'reason': msg, **kw}), flush=True); sys.exit(2)


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


def fingerprint(root, content=True, skip=()):
    """name -> (type, mode, size, mtime_ns, ino, nlink, sha256|None) for every entry under root, without following symlinks"""
    out = {}
    for dp, dns, fns in os.walk(root, followlinks=False):
        rel = os.path.relpath(dp, root)
        if any(rel == s or rel.startswith(s + '/') for s in skip):
            dns[:] = []; continue
        dns[:] = [d for d in dns if os.path.normpath(os.path.join(rel, d)) not in skip]
        for n in dns + fns:
            p = os.path.join(dp, n); st = os.lstat(p); r = os.path.normpath(os.path.join(rel, n))
            dig = sha256(p) if content and stat.S_ISREG(st.st_mode) else (os.readlink(p) if stat.S_ISLNK(st.st_mode) else None)
            out[r] = (stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns, st.st_ino, st.st_nlink, dig)
    return out


def staged_exact(stage, good):
    seen = {}
    for dp, dns, fns in os.walk(stage, followlinks=False):
        rel = os.path.relpath(dp, stage)
        for d in dns:
            r = os.path.normpath(os.path.join(rel, d))
            if r != 'db' or os.path.islink(os.path.join(dp, d)):
                return False, f'unexpected directory {r}'
        for n in fns:
            r = os.path.normpath(os.path.join(rel, n)); st = os.lstat(os.path.join(dp, n))
            if r not in good or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != good[r]['size'] \
                    or sha256(os.path.join(dp, n)) != good[r]['sha256']:
                return False, f'not a declared regular single-link file with the expected bytes: {r}'
            seen[r] = True
    missing = sorted(set(good) - set(seen))
    return (False, f'missing {missing}') if missing else (True, 'exact')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--candidate-unit', required=True); ap.add_argument('--candidate-unit-sha256', required=True)
    ap.add_argument('--base-bin', required=True); ap.add_argument('--base-bin-sha256', required=True)
    ap.add_argument('--fixtures-dir', required=True); ap.add_argument('--fixtures-json-sha256', required=True)
    ap.add_argument('--scratch', required=True, help='NEW dir under /srv/enclave-base-holder/tmp/gsq-r1/ (created 0700 here)')
    ap.add_argument('--datadir', default='/srv/enclave-base-holder/data')
    ap.add_argument('--case-timeout', type=int, default=300)
    a = ap.parse_args()
    if os.getuid() != 0:
        die('run as root (the candidate unit runs as root)')
    sc = os.path.normpath(a.scratch)
    if not sc.startswith('/srv/enclave-base-holder/tmp/gsq-r1/') or os.path.lexists(sc):
        die('--scratch must be a NEW path under /srv/enclave-base-holder/tmp/gsq-r1/')
    unit_text = open(a.candidate_unit).read()
    if sha256(a.candidate_unit) != a.candidate_unit_sha256:
        die('candidate extract unit is not the pinned candidate')
    props = service_properties(unit_text)
    keys = {k: v for k, v in props}
    for k, v in REQUIRED_SANDBOX.items():
        if keys.get(k) != v:
            die(f'candidate unit lacks {k}={v}: not the reviewed sandbox', got=keys.get(k))
    if sha256(a.base_bin) != a.base_bin_sha256:
        die('base binary is not the pinned one')
    fj = os.path.join(a.fixtures_dir, 'fixtures.json')
    if sha256(fj) != a.fixtures_json_sha256:
        die('fixtures.json is not the root-pinned fixture record')
    fx = json.load(open(fj))
    for name, f in fx['fixtures'].items():
        if sha256(os.path.join(a.fixtures_dir, f['file'])) != f['sha256']:
            die(f'fixture {name} differs from fixtures.json')
    decoy = os.path.join(sc, 'decoy')
    if fx['decoy'].rstrip('/') != decoy:
        die('fixtures were generated for another decoy path', fixtures_decoy=fx['decoy'], expected=decoy)
    os.makedirs('/srv/enclave-base-holder/tmp/gsq-r1', mode=0o700, exist_ok=True)
    os.mkdir(sc, 0o700)
    for d in ('stage', 'x-home', 'decoy', 'fixtures', 'logs'):
        os.mkdir(os.path.join(sc, d), 0o700)
    with open(os.path.join(decoy, 'victim'), 'xb') as f:
        f.write(b'decoy victim bytes\n')
    for name, f in fx['fixtures'].items():
        shutil.copyfile(os.path.join(a.fixtures_dir, f['file']), os.path.join(sc, 'fixtures', f['file']))
    logs = os.path.join(sc, 'logs')
    rec = {'format': 'enclave-guest-qualification-q2/r1', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'candidateUnitSha256': a.candidate_unit_sha256, 'baseBinSha256': a.base_bin_sha256, 'fixturesJsonSha256': a.fixtures_json_sha256,
           'scratch': sc, 'cases': {}}
    av = subprocess.run(['/usr/bin/systemd-analyze', 'verify', a.candidate_unit], capture_output=True, text=True, timeout=120)
    rec['systemdAnalyzeVerify'] = {'rc': av.returncode, 'out': (av.stdout + av.stderr)[-4000:]}
    ver = subprocess.run([a.base_bin, '--version'], capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    rec['baseVersion'] = (ver.stdout + ver.stderr).strip()[:400]
    passed = [(k, v) for k, v in props if k not in NOT_PASSED]
    rec['sandboxPassedVerbatim'] = passed
    rec['sandboxReplaced'] = {'ReadWritePaths': f'{sc}/stage {sc}/x-home', 'ExecStart': 'base snapshot download (guest_state.py argv)'}
    rec['sandboxAdded'] = {'RuntimeMaxSec': a.case_timeout}
    data_before = fingerprint(a.datadir, content=False) if os.path.isdir(a.datadir) else {}
    ok_all = True
    for name, f in fx['fixtures'].items():
        for d in ('stage', 'x-home'):
            p = os.path.join(sc, d); shutil.rmtree(p); os.mkdir(p, 0o700)
        outside_before = fingerprint(sc, skip=('stage', 'x-home', 'logs'))
        unit = f'gsq-r1-{os.path.basename(sc)}-{name}'[:200]
        cmd = ['/usr/bin/systemd-run', '--wait', '--collect', '--quiet', '--pipe', f'--unit={unit}']
        for k, v in passed:
            cmd += ['-p', f'{k}={v}']
        cmd += ['-p', f'ReadWritePaths={sc}/stage {sc}/x-home', '-p', f'RuntimeMaxSec={a.case_timeout}',
                '-E', 'PATH=/usr/bin:/bin', '-E', f'HOME={sc}/x-home', '-E', f'TMPDIR={sc}/x-home', '-E', 'LC_ALL=C',
                '--', a.base_bin, 'snapshot', 'download', '--chain', 'base', '--datadir', f'{sc}/stage', '--url',
                'file://' + os.path.join(sc, 'fixtures', f['file'])]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=a.case_timeout + 60, stdin=subprocess.DEVNULL)
            rc, out = r.returncode, (r.stdout + r.stderr)
        except subprocess.TimeoutExpired as e:
            rc, out = 'timeout', str(e)
        with open(os.path.join(logs, f'{name}.log'), 'x') as lf:
            lf.write(' '.join(cmd) + '\n\n' + out)
        exact, why = staged_exact(os.path.join(sc, 'stage'), fx['goodOutputs'])
        outside_after = fingerprint(sc, skip=('stage', 'x-home', 'logs'))
        data_after = fingerprint(a.datadir, content=False) if os.path.isdir(a.datadir) else {}
        escape = outside_after != outside_before or data_after != data_before
        if f['expect'] == 'extracted-exact':
            verdict = 'PASS' if rc == 0 and exact and not escape else 'FAIL'
        else:
            verdict = 'PASS' if (rc != 0 or not exact) and not escape else 'FAIL'
        errs = sorted(set(re.findall(r'(Read-only file system|Permission denied|Operation not permitted|EROFS|EACCES|EPERM|'
                                     r'outside of the|invalid path|path traversal|error unpacking[^\n]{0,120})', out)))
        rec['cases'][name] = {'verdict': verdict, 'rc': rc, 'stagedExact': exact, 'stagedWhy': why, 'escape': escape,
                              'decoyOrScratchChanged': outside_after != outside_before, 'datadirChanged': data_after != data_before,
                              'refusalEvidence': errs, 'expect': f['expect'], 'log': f'logs/{name}.log'}
        ok_all &= verdict == 'PASS'
        print(json.dumps({'case': name, **rec['cases'][name]}), flush=True)
    rec['result'] = 'PASS' if ok_all else 'FAIL'
    with open(os.path.join(sc, 'q2-result.json'), 'x') as f:
        json.dump(rec, f, indent=1); f.write('\n')
    print(json.dumps({'event': 'q2-result', 'result': rec['result'], 'record': os.path.join(sc, 'q2-result.json')}), flush=True)
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
