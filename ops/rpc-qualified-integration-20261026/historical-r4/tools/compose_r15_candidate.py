#!/usr/bin/env python3
"""compose_r15_candidate.py (historical-origin-segments-stage/r4): build the deployable r15 CANDIDATE tree = frozen r14-witness
(SHA256SUMS 1ba2d51a, never written) + the r4 anchored-coverage overlays + the pinned verifier library + the full pin cascade + MANIFEST
entries, plus a candidate qualification job generated from r14's own job. Deterministic; every textual substitution is asserted.

usage: compose_r15_candidate.py OUT_DIR        (OUT_DIR must not exist)
Edits:  wrapper/chain_service.py, readiness/readiness_sampler.py, readiness/publish_readiness.py   (= r4 overlay bytes)
New:    lib/anchored-coverage/{anchored_origin,segments,anchored_acceptance}.py                     (= r4 src bytes; MANIFEST -> /opt/enclave-rpc/lib/anchored-coverage/)
Cascade: every *.py (outside integration-*/, logs/) that pins an old sha of a changed file is re-pinned to the new sha, to a fixed point
         (r14: src/finality_state.py, producer/base_launch.py, recovery/forward_sync.py pin the wrapper; src/reproof.py pins those);
         install/MANIFEST.json: every non-bundle entry's sha256 recomputed from its src, stage renamed, the 3 lib entries added.
Records: COMPOSITION-r15.tsv (path, sha, kind, r14 sha), integration-r15/<path>.patch (unified diff r14 -> candidate per edited file),
         jobs/root-r15-candidate-tests.sh (r14's job: r14 composition proof kept on r14 itself, plus the candidate proof; readiness no
         longer reused but RUN (ops-readiness 27, sampler 93); MANIFEST expectations 67 files), SHA256SUMS ('./path' format)."""
import difflib, hashlib, json, pathlib, re, shutil, sys

W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
R14 = W / 'base-finality-proof-stage/r14-witness'
R14_SUMS = '1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b'
R4 = pathlib.Path(__file__).resolve().parents[1]
STAGE_NAME = 'historical-origin-segments-stage/r4/compose/r15-candidate'
EDITS = {'wrapper/chain_service.py': R4 / 'overlay/wrapper/chain_service.py',
         'readiness/readiness_sampler.py': R4 / 'overlay/readiness/readiness_sampler.py',
         'readiness/publish_readiness.py': R4 / 'overlay/readiness/publish_readiness.py'}
LIB = ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py')
JOB = 'jobs/root-r15-candidate-tests.sh'
h = lambda b: hashlib.sha256(b).hexdigest()   # noqa: E731


def one(s, a, b):
    assert s.count(a) == 1, ('anchor not unique in the r14 job', a[:90], s.count(a))
    return s.replace(a, b)


def main(out):
    out = pathlib.Path(out)
    assert not out.exists(), f'{out} exists'
    sums_raw = (R14 / 'SHA256SUMS').read_bytes()
    assert h(sums_raw) == R14_SUMS, 'r14-witness SHA256SUMS is not 1ba2d51a'
    listed = {}
    for line in sums_raw.decode().splitlines():
        want, rel = line.split(None, 1); rel = rel.strip().removeprefix('./')
        assert h((R14 / rel).read_bytes()) == want, f'r14 {rel} differs from its SHA256SUMS'
        listed[rel] = want
    files = {rel: (R14 / rel).read_bytes() for rel in listed}
    for rel, src in EDITS.items():
        files[rel] = src.read_bytes()
    for f in LIB:
        files[f'lib/anchored-coverage/{f}'] = (R4 / 'src' / f).read_bytes()
    # pin cascade to a fixed point (python sources only; history/docs/patches keep the shas they record)
    cascade = lambda rel: rel.endswith('.py') and not rel.startswith(('integration-', 'logs/', 'lib/'))   # noqa: E731
    while True:
        moved = {listed[r]: h(b) for r, b in files.items() if r in listed and h(b) != listed[r]}
        changed = False
        for rel, b in list(files.items()):
            if not cascade(rel) or rel in EDITS:
                continue
            t = b.decode()
            for old, new in moved.items():
                t = t.replace(old, new)
            if t.encode() != b:
                files[rel] = t.encode(); changed = True
        if not changed:
            break
    m = json.loads(files['install/MANIFEST.json'])
    m['stage'] = STAGE_NAME
    for e in m['files']:
        if not e['src'].startswith('bundle/'):
            e['sha256'] = h(files[e['src']])
    dests = {e['dest'] for e in m['files']}
    for f in LIB:
        d = f'/opt/enclave-rpc/lib/anchored-coverage/{f}'
        assert d not in dests
        m['files'].append({'src': f'lib/anchored-coverage/{f}', 'dest': d, 'sha256': h(files[f'lib/anchored-coverage/{f}']), 'mode': '0644'})
    files['install/MANIFEST.json'] = (json.dumps(m, indent=1) + '\n').encode()
    edited = sorted(r for r in listed if files[r] != (R14 / r).read_bytes())
    new = sorted(r for r in files if r not in listed)
    rows = ['path\tsha256\tkind\tr14_sha256']
    for r in edited:
        rows.append(f'{r}\t{h(files[r])}\tedit\t{listed[r]}')
        diff = difflib.unified_diff((R14 / r).read_text().splitlines(True), files[r].decode().splitlines(True), f'a/{r}', f'b/{r}')
        files[f'integration-r15/{r.replace("/", "_")}.patch'] = ''.join(diff).encode()
    for r in new:
        rows.append(f'{r}\t{h(files[r])}\tnew\t-')
    files['COMPOSITION-r15.tsv'] = ('\n'.join(rows) + '\n').encode()
    files[JOB] = job(edited).encode()
    for rel, b in files.items():
        p = out / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
        if rel.endswith('.sh') or (R14 / rel).exists() and (R14 / rel).stat().st_mode & 0o111:
            p.chmod(0o755)
    (out / 'SHA256SUMS').write_text(''.join(f'{h(files[r])}  ./{r}\n' for r in sorted(files)))
    print(json.dumps({'out': str(out), 'edited': edited, 'new': new, 'manifestFiles': len(m['files']), 'manifestTrees': len(m['trees']),
                      'SHA256SUMS': h((out / 'SHA256SUMS').read_bytes())}, indent=1))


def job(edited):
    s = (R14 / 'jobs/root-finality-r14-witness-tests.sh').read_text()
    cand = str(W / 'historical-origin-segments-stage' / STAGE_NAME.split('historical-origin-segments-stage/')[1])
    s = one(s, '#!/bin/bash\n', '#!/bin/bash\n# r15 CANDIDATE (generated by historical-origin-segments-stage/r4/tools/compose_r15_candidate.py from r14-witness 1ba2d51a):\n'
            '# r14 + the anchored-coverage wrapper/readiness/publisher overlays + lib/anchored-coverage + pin cascade + MANIFEST (67 files).\n'
            '# Root runs it (foreground): ./jobs/q-exit-status.sh root-r15-candidate-1 1024 unshare -Urn bash ' + cand + '/' + JOB + '\n'
            '# The r14 header below is kept verbatim for provenance; where it says "r14"/"PREPARED" read "this candidate".\n')
    s = one(s, f'ST={R14}', f'ST={cand}; R14={R14}')
    # r14's own composition proof stays, applied to r14 itself; then the candidate = r14 + declared edits/new files proof
    s = one(s, "/usr/bin/python3 -I - $ST $BASE $WIT <<'PYC' || die \"r14 composition\"", "/usr/bin/python3 -I - $R14 $BASE $WIT <<'PYC' || die \"r14 composition\"")
    s = one(s, '\nPYC\n', '\nPYC\n' + CANDIDATE_PROOF)
    s = one(s, 'diff -rq $R10/readiness $ST/readiness > /dev/null || die "readiness differs from r10 (reused receipts)"\n',
            'echo "NOT REUSED readiness (candidate changes readiness_sampler/publish_readiness): ops-readiness 27 + sampler 93 run below"\n')
    s = re.sub(r'\nreceipt \S+/ops-readiness\.txt \S+ 27\n', '\n', s, count=1)
    s = re.sub(r'\nreceipt \S+/sampler\.txt \S+ 93\n', '\n', s, count=1)
    assert 'ops-readiness.txt' not in s and 'sampler.txt' not in s, 'readiness receipts still reused'
    s = one(s, "assert m['stage'] == 'base-finality-proof-stage/r14-witness' and (len(m['files']), len(m['trees'])) == (64, 14)",
            f"assert m['stage'] == '{STAGE_NAME}' and (len(m['files']), len(m['trees'])) == (67, 14)")
    s = one(s, "print('r14 manifest: stage r14-witness, 64 files (61 + bridge + 2 units), 14 trees, 32 bundle entries')",
            "for f in ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py'):\n"
            "    e = got['/opt/enclave-rpc/lib/anchored-coverage/' + f]; assert (e['src'], e['mode'], e['sha256']) == ('lib/anchored-coverage/' + f, '0644', h('lib/anchored-coverage/' + f)), f\n"
            "print('r15 candidate manifest: 64 r14 files (re-pinned) + 3 anchored-coverage lib files, 14 trees, 32 bundle entries')")
    s = one(s, '# ---- the witness r2 job (12)', READINESS_RUNS + '# ---- the witness r2 job (12)')
    return s


CANDIDATE_PROOF = r'''/usr/bin/python3 -I - $ST $R14 <<'PYR15' || die "r15 candidate composition"
import difflib, hashlib, pathlib, sys
S, R = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
sums = lambda d: {l.split(None, 1)[1].strip().removeprefix('./'): l.split()[0] for l in (d / 'SHA256SUMS').read_text().splitlines()}
a, b = sums(R), sums(S); rows = [l.split('\t') for l in (S / 'COMPOSITION-r15.tsv').read_text().splitlines()[1:]]
EDIT = {r[0] for r in rows if r[2] == 'edit'}; NEW = {r[0] for r in rows if r[2] == 'new'}
assert {'wrapper/chain_service.py', 'readiness/readiness_sampler.py', 'readiness/publish_readiness.py', 'install/MANIFEST.json'} <= EDIT, EDIT
assert NEW == {'lib/anchored-coverage/anchored_origin.py', 'lib/anchored-coverage/segments.py', 'lib/anchored-coverage/anchored_acceptance.py'}, NEW
ADDED = NEW | {'COMPOSITION-r15.tsv', 'jobs/root-r15-candidate-tests.sh'} | {f'integration-r15/{r.replace("/", "_")}.patch' for r in EDIT}
assert set(b) == set(a) | ADDED, sorted(set(a) ^ set(b))
assert not [p for p in a if p not in EDIT and a[p] != b[p]], 'changed outside the declared edits'
for r in rows:
    assert h(S / r[0]) == r[1], r[0]
    if r[2] == 'edit':
        d = ''.join(difflib.unified_diff((R / r[0]).read_text().splitlines(True), (S / r[0]).read_text().splitlines(True), f'a/{r[0]}', f'b/{r[0]}'))
        assert d == (S / 'integration-r15' / (r[0].replace('/', '_') + '.patch')).read_text() and r[3] == a[r[0]], ('edit record', r[0])
print('r15 candidate = r14 (1ba2d51a) +', sorted(EDIT), '+', sorted(NEW))
PYR15
'''

READINESS_RUNS = r'''# ---- readiness (changed by the candidate, so RUN, never reused): ops-readiness 27 on the candidate tree, sampler 93 on the candidate sampler
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 1200 /usr/bin/python3 -I -B tests/test_ops_readiness.py -v < /dev/null) > $OUT/ops-readiness.txt 2>&1; check ops-readiness 27 $?
(cd $SC/readiness && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp ORIGIN_EXTRACT=$P/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/origin_extract.py \
   timeout 2400 /usr/bin/python3 -I -B test_readiness_sampler.py -v < /dev/null) > $OUT/sampler.txt 2>&1; check sampler 93 $?
'''

if __name__ == '__main__':
    main(sys.argv[1])
