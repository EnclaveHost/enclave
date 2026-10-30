#!/usr/bin/env python3
"""post-run-audit.py: the CORRECTED D-phase "regeneration touched non-generated files" audit for r12, run independently and
READ-ONLY on the SAME actual run (composition-fixture-audit-correction-stage; PREPARED; NOT run by Claude).

r12's jobs/r12-build-validate.sh line 191 lists `git status --untracked-files=all --ignored`, which names every ignored FILE,
but allows only the DIRECTORY names contracts/foundry/out/ and contracts/foundry/cache/ (grep -vxF matches whole lines): the 33
bound contract artifacts B2 placed in the final tree were reported (root-composition-r12-full-0313). This audit allows NO
directory blanket. Every untracked/ignored path outside the three dependency closures must be EXACTLY one of:
  - a bound contract artifact: contracts/foundry/<p> with <p> listed in the run's ARTIFACTS-final.sha256, bytes re-hashed equal;
  - raw build-info contracts/foundry/out/build-info/*: ONLY if the run recorded BUILDINFO-final.sha256 listing it, bytes equal;
  - forge cache contracts/foundry/cache/*: ONLY if the run recorded CACHE-final.sha256 listing it (r12 records none -> refused);
  - relay/network-runtime.bundle.mjs(.manifest.json): bytes equal to the run's gen-pass-2.ignored.sha256 (the generated set);
  - (post-run only) test/<f> for f in r12/stack-tests: bytes equal to that reviewed file (the runner copies them after D).
Anything else - an extra or missing file, a tampered byte, a symlink, a path leaving the tree, a tracked modification, a
generated path left uncommitted - fails. The rest of r12's D rules are re-checked, never relaxed: HEAD = the regenerated
candidate whose parent is the immutable base; base..candidate changes ONLY GENERATED.txt paths, all of which exist; the
closure artifacts equal their recorded first build (which recorded raw build-info); the three dependency closures still equal
DEPS.txt (r12's own deps-identity.py). git runs with --no-optional-locks (no index refresh: nothing is written to the tree).

  audit   RUN_DIR R12_DIR GIT_DIR BASE CANDIDATE JOB_LOG            -> JSON, exit 0 only if clean
  combine RUN_DIR R12_DIR GIT_DIR BASE CANDIDATE JOB_LOG JOB_RC      -> JSON, exit 0 only if the job COMPLETED, its ONLY [FAIL] is
          the D line naming EXACTLY the bound artifacts, every RESULTS.tsv row and every receipt is clean, and the audit is clean
"""
import hashlib, json, os, pathlib, re, stat, subprocess, sys

NM = (':!node_modules', ':!network/node_modules', ':!relay/node_modules')
NR = ('relay/network-runtime.bundle.mjs', 'relay/network-runtime.bundle.mjs.manifest.json')
DEPS_IDENTITY_SHA256 = 'f54c59356e798d5cdb2be7d7642e30e63ae668015c0ee39bccffc254c7b22484'      # r12/tools/deps-identity.py
D_LINE = '[FAIL] regeneration touched non-generated files: '
CLEAN = re.compile(r'0 pass=[1-9][0-9]* fail=0 skip=0 todo=0 cancelled=0')
CAP = 64 << 20


class Fail(Exception):
    pass


def sha_file(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Fail(f'{p} is not a regular file')
        h, n = hashlib.sha256(), 0
        while (b := os.read(fd, 1 << 20)):
            h.update(b); n += len(b)
            if n > CAP:
                raise Fail(f'{p} exceeds {CAP} bytes')
        return h.hexdigest()
    finally:
        os.close(fd)


def manifest(p, strip=''):
    """'<sha256>  <path>' lines -> {path: sha}; strict, unique"""
    out = {}
    for l in pathlib.Path(p).read_text().splitlines():
        m = re.fullmatch(r'([0-9a-f]{64})  (.+)', l)
        if not m or m.group(2) in out:
            raise Fail(f'{p}: malformed or duplicate line {l[:80]!r}')
        out[m.group(2)] = m.group(1)
    return out


def git(gitdir_or_tree, *a, tree=True):
    cmd = ['git', '--no-optional-locks'] + (['-C', str(gitdir_or_tree)] if tree else [f'--git-dir={gitdir_or_tree}']) + list(a)
    r = subprocess.run(cmd, capture_output=True, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if r.returncode != 0:
        raise Fail(f'git {" ".join(a[:3])} failed: {r.stderr.decode()[-200:]}')
    return r.stdout


def inside(F, rel):
    """no '..'/absolute, no symlink in any component, final path a regular file under F"""
    if rel.startswith('/') or '..' in rel.split('/'):
        raise Fail(f'{rel!r} is not a plain relative path')
    cur = F
    for part in rel.split('/'):
        cur = cur / part
        if os.path.islink(cur):
            raise Fail(f'{rel}: {cur.relative_to(F)} is a symlink')
    if not str(os.path.realpath(F / rel)).startswith(str(os.path.realpath(F)) + os.sep):
        raise Fail(f'{rel} leaves the tree')
    return F / rel


def audit(run, r12, gitdir, base, cand, log, post_run=True):
    run, r12 = pathlib.Path(run), pathlib.Path(r12); F = run / 'trees' / 'final'; fails, notes = [], {}

    def check(name, fn):
        try:
            notes[name] = fn()
        except Fail as e:
            fails.append(f'{name}: {e}')
        except (OSError, ValueError, KeyError) as e:
            fails.append(f'{name}: {type(e).__name__}: {e}')

    gen = [l for l in (r12 / 'GENERATED.txt').read_text().splitlines() if l and not l.startswith('#')]

    def identity():
        head = git(F, 'rev-parse', 'HEAD').decode().strip(); parent = git(F, 'rev-parse', 'HEAD^').decode().strip()
        if head != cand or parent != base:
            raise Fail(f'HEAD {head[:12]} parent {parent[:12]}, expected {cand[:12]} on {base[:12]}')
        changed = git(F, 'diff', '--name-only', '-z', base, cand).decode().split('\0')
        extra = sorted(set(p for p in changed if p) - set(gen))
        if extra:
            raise Fail(f'the regenerated commit changes non-generated paths: {extra[:5]}')
        missing = [p for p in gen if not os.path.lexists(F / p)]
        if missing:
            raise Fail(f'listed generated paths missing: {missing[:5]}')
        return {'head': head, 'changed': len([p for p in changed if p])}
    check('identity', identity)

    arts = manifest(run / 'ARTIFACTS-final.sha256')
    bi = manifest(run / 'BUILDINFO-final.sha256') if (run / 'BUILDINFO-final.sha256').exists() else {}
    cache = manifest(run / 'CACHE-final.sha256') if (run / 'CACHE-final.sha256').exists() else {}
    nr = (run / 'gen-pass-2.ignored.sha256').read_text().split()
    stack = {f'test/{p.name}': sha_file(p) for p in sorted((r12 / 'stack-tests').iterdir())} if post_run else {}

    def listing():
        raw = git(F, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--', '.', *NM).decode().split('\0')
        seen, bad = {'artifact': 0, 'buildinfo': 0, 'cache': 0, 'network-runtime': 0, 'stack-test': 0}, []
        for e in [x for x in raw if x]:
            code, p = e[:2], e[3:]
            if code not in ('??', '!!'):
                bad.append(f'tracked change {code!r} {p}'); continue
            try:
                f = inside(F, p); h = sha_file(f)
            except Fail as ex:
                bad.append(str(ex)); continue
            q = p[len('contracts/foundry/'):] if p.startswith('contracts/foundry/') else None
            if q is not None and q.startswith('out/build-info/'):
                ok, kind = bi.get(q) == h, 'buildinfo'
            elif q is not None and q.startswith('cache/'):
                ok, kind = cache.get(q) == h, 'cache'
            elif q is not None:
                ok, kind = arts.get(q) == h, 'artifact'
            elif p in NR:
                ok, kind = len(nr) == 2 and nr[NR.index(p)] == h, 'network-runtime'
            elif p in stack:
                ok, kind = stack[p] == h, 'stack-test'
            elif p in gen:
                ok, kind = False, 'generated-uncommitted'
            else:
                ok, kind = False, 'unexpected'
            if ok:
                seen[kind] += 1
            else:
                bad.append(f'{kind}: {p} (not an exact recorded file with recorded bytes)')
        present = {p for e in raw if e for p in [e[3:]]}
        lost = sorted(f'contracts/foundry/{q}' for q in arts if f'contracts/foundry/{q}' not in present) + sorted(p for p in NR if p not in present)
        if lost:
            bad.append(f'bound fixtures missing: {lost[:5]}')
        if bad:
            raise Fail('; '.join(bad[:12]) + (f' (+{len(bad) - 12} more)' if len(bad) > 12 else ''))
        if seen['artifact'] != len(arts):
            raise Fail(f'{seen["artifact"]} artifacts listed, {len(arts)} bound')
        return seen
    check('listing', listing)

    def closure():
        reuse = [l for l in (run / 'ARTIFACT-REUSE.txt').read_text().splitlines() if l.startswith('final copied from ')] if (run / 'ARTIFACT-REUSE.txt').exists() else []
        first = reuse[0].split()[3] if reuse else 'final'
        if len(reuse) > 1 or not re.fullmatch(r'[A-Za-z]+', first):
            raise Fail('ambiguous reuse record')
        if manifest(run / f'ARTIFACTS-{first}.sha256') != arts:
            raise Fail(f'final artifacts differ from their recorded build ({first})')
        if not manifest(run / f'BUILDINFO-{first}.sha256'):
            raise Fail(f'the recorded build {first} has no raw build-info record')
        return {'builtBy': first, 'artifacts': len(arts), 'buildInfoFiles': len(manifest(run / f'BUILDINFO-{first}.sha256'))}
    check('closure', closure)

    def deps():
        tool = r12 / 'tools/deps-identity.py'
        if sha_file(tool) != DEPS_IDENTITY_SHA256:
            raise Fail('deps-identity.py is not the pinned r12 tool')
        want = dict(l.split() for l in (r12 / 'DEPS.txt').read_text().splitlines() if l.strip())
        got = {}
        for d in ('.', 'network', 'relay'):
            nm = F / 'node_modules' if d == '.' else F / d / 'node_modules'
            r = subprocess.run([sys.executable, '-I', '-B', str(tool), str(gitdir), base, d, str(nm)], capture_output=True, text=True)
            j = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
            if r.returncode != 0 or j.get('treehash') != want.get(d):
                raise Fail(f'{d} closure differs from DEPS.txt ({j.get("error") or j.get("treehash")})')
            got[d] = j['treehash'][:12]
        return got
    check('deps', deps)

    def dtime():
        lines = pathlib.Path(log).read_text(errors='replace').splitlines()
        idx = [i for i, l in enumerate(lines) if l.startswith(D_LINE)]
        if len(idx) != 1:
            return {'dLine': 'absent'} if not idx else (_ for _ in ()).throw(Fail('more than one D audit line'))
        flagged = [lines[idx[0]][len(D_LINE):]]
        for l in lines[idx[0] + 1:]:
            if l.startswith('[') or l.startswith('==') or l.startswith('##') or not l.strip():
                break
            flagged.append(l)
        want = {f'contracts/foundry/{q}' for q in arts}
        if set(flagged) != want or len(flagged) != len(want):
            raise Fail(f'the D line flagged other paths than exactly the bound artifacts: {sorted(set(flagged) ^ want)[:5]}')
        return {'dLine': f'exactly the {len(want)} bound artifacts'}
    check('dTime', dtime)
    return {'ok': not fails, 'fails': fails, **notes}


def combine(run, r12, gitdir, base, cand, log, rcfile):
    a = audit(run, r12, gitdir, base, cand, log); fails = list(a['fails']); run = pathlib.Path(run)
    text = pathlib.Path(log).read_text(errors='replace'); lines = text.splitlines()
    rc = pathlib.Path(rcfile).read_text().strip() if os.path.exists(rcfile) else None
    if rc is None or not any(l.startswith('## summary:') for l in lines):
        return {'ok': False, 'verdict': 'INCOMPLETE (the job has not finished: no rc file or no summary line)', 'audit': a}
    results = [l for l in lines if l.startswith('RESULT:') or l.startswith('## rc=')]
    fl = [l for l in lines if l.startswith('[FAIL]')]
    if rc != '1' or results[-1:] != ['RESULT: FAIL']:
        fails.append(f'job rc {rc} / last result {results[-1:]}: only a completed FAIL caused by the D line can be corrected')
    if [l for l in fl if not l.startswith(D_LINE)] or len(fl) != 1:
        fails.append(f'other [FAIL] lines exist: {[l[:100] for l in fl if not l.startswith(D_LINE)][:5]}')
    rows, bad = (run / 'RESULTS.tsv').read_text().splitlines(), []
    for r in rows:
        f = r.split('\t'); k = f[0]
        if k == 'STACK':
            ok = len(f) == 3 and CLEAN.fullmatch(f[2].removeprefix('final: '))
        elif k == 'NATIVE':
            ok = len(f) >= 3 and f[2].startswith('rc 0 ') and f[2].endswith(' OK')
        elif k == 'REGRESS':
            ok = f[-1] == 'ok' and CLEAN.fullmatch(f[3].removeprefix('final: '))
        else:
            ok = f[-1].startswith('ok') and all(CLEAN.fullmatch(x.split(': ', 1)[1]) for x in f[2:4])
        if not ok:
            bad.append(r[:160])
    if not rows or bad:
        fails.append(f'not every result row is clean: {bad[:5]}')
    rec, rb = run / 'receipts/RECEIPTS.tsv', []
    for l in rec.read_text().splitlines() if rec.exists() else []:
        key, tree, test, tb, logsha = l.split('\t')
        if sha_file(run / f'receipts/{key}.out') != logsha or (run / f'receipts/{key}.rc').read_text().strip() != '0':
            rb.append(key[:12])
    if not rec.exists() or rb:
        fails.append(f'receipts missing or not clean/byte-identical: {rb[:5]}')
    ok = not fails
    return {'ok': ok, 'verdict': 'PASS WITH THE CORRECTED D AUDIT (actual receipts; no product test rerun) - root review required' if ok else 'FAIL',
            'fails': fails, 'rows': len(rows), 'audit': a}


def main(argv):
    try:
        if len(argv) == 8 and argv[1] == 'audit':
            r = audit(*argv[2:8])
        elif len(argv) == 9 and argv[1] == 'combine':
            r = combine(*argv[2:9])
        else:
            print(__doc__); return 2
    except (Fail, OSError, ValueError) as e:
        r = {'ok': False, 'fails': [f'{type(e).__name__}: {e}']}
    print(json.dumps(r, indent=1)); return 0 if r['ok'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
