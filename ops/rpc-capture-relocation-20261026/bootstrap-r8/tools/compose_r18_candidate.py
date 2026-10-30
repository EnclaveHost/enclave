#!/usr/bin/env python3
"""compose_r18_candidate.py (historical-origin-segments-stage/r8): build the deployable r18 CANDIDATE tree = frozen r14-witness
(SHA256SUMS 1ba2d51a, never written) + the r5 anchored-coverage + post-bootstrap continuation overlays (wrapper, readiness, publisher, producer) + the pinned verifier library + the full pin cascade + MANIFEST
entries, plus a candidate qualification job generated from r14's own job. Deterministic; every textual substitution is asserted.

usage: compose_r18_candidate.py OUT_DIR        (OUT_DIR must not exist)
Edits:  wrapper/chain_service.py, readiness/readiness_sampler.py, readiness/publish_readiness.py, producer/base_launch.py (= r5 overlay bytes)
New:    historical-capture/<bundle 020cc8bf>/* = the frozen bundle verbatim (+ MANIFEST.json); MANIFEST -> /opt/enclave-rpc/historical-capture/<sha>/ with bundle modes
Cascade: every *.py (outside integration-*/, logs/) that pins an old sha of a changed file is re-pinned to the new sha, to a fixed point
         (r14: src/finality_state.py, producer/base_launch.py, recovery/forward_sync.py pin the wrapper; src/reproof.py pins those);
         install/MANIFEST.json: every non-bundle entry's sha256 recomputed from its src, stage renamed, the 3 lib entries added.
Records: COMPOSITION-r18.tsv (path, sha, kind, r14 sha), integration-r18/<path>.patch (unified diff r14 -> candidate per edited file),
         jobs/root-r18-candidate-tests.sh (r14's job: r14 composition proof kept on r14 itself, plus the candidate proof; readiness no
         longer reused but RUN (ops-readiness 27, sampler 93); MANIFEST expectations 67 files), SHA256SUMS ('./path' format)."""
import difflib, hashlib, json, pathlib, re, shutil, sys

W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
R14 = W / 'base-finality-proof-stage/r14-witness'
R14_SUMS = '1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b'
R4 = pathlib.Path(__file__).resolve().parents[1]
STAGE_NAME = 'historical-origin-segments-stage/r8/compose/r18-candidate'
EDITS = {'wrapper/chain_service.py': R4 / 'overlay/wrapper/chain_service.py',
         'readiness/readiness_sampler.py': R4 / 'overlay/readiness/readiness_sampler.py',
         'readiness/publish_readiness.py': R4 / 'overlay/readiness/publish_readiness.py',
         'producer/base_launch.py': R4 / 'overlay/producer/base_launch.py'}
LIB = ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py')
# r8: the immutable historical-capture bundle (frozen historical-capture-deployment-stage) is shipped VERBATIM, file by file with its own
# modes (r14 install trees force 0644, which would drop the exec bit of bin/* and vendor/coverage/kzgcheck); no lib/anchored-coverage copy.
CAPTURE = W / 'historical-capture-deployment-stage'
CAPTURE_SUMS = '7f3fb478445d57ca4d941d48c8a89b0011fc7ca9771f107b8e6f12144ad6b31b'
BUNDLE_SHA = '020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e'
BUNDLE_SRC = f'historical-capture/{BUNDLE_SHA}'
BUNDLE_DEST = f'/opt/enclave-rpc/historical-capture/{BUNDLE_SHA}'
JOB = 'jobs/root-r18-candidate-tests.sh'
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
    cs = (CAPTURE / 'SHA256SUMS').read_bytes()
    assert h(cs) == CAPTURE_SUMS, 'historical-capture-deployment-stage SHA256SUMS is not the frozen 7f3fb478'
    for line in cs.decode().splitlines():
        want, rel = line.split(None, 1); rel = rel.strip().removeprefix('./')
        assert h((CAPTURE / rel).read_bytes()) == want, f'capture stage {rel} differs from its SHA256SUMS'
    bm_raw = (CAPTURE / 'bundle/MANIFEST.json').read_bytes()
    assert h(bm_raw) == BUNDLE_SHA, 'bundle MANIFEST.json is not 020cc8bf'
    bm = json.loads(bm_raw)
    bundle_modes = {'MANIFEST.json': '0644'}
    files[f'{BUNDLE_SRC}/MANIFEST.json'] = bm_raw
    for rel, e in sorted(bm['files'].items()):
        b = (CAPTURE / 'bundle' / rel).read_bytes()
        assert h(b) == e['sha256'] and e['mode'] in ('0644', '0755'), rel
        files[f'{BUNDLE_SRC}/{rel}'] = b; bundle_modes[rel] = e['mode']
    assert not any(b'/home/' in files[f'{BUNDLE_SRC}/lib/{f}'] for f in LIB), 'a shipped verifier names a workstation path'
    # pin cascade to a fixed point (python sources only; history/docs/patches keep the shas they record)
    cascade = lambda rel: rel.endswith('.py') and not rel.startswith(('integration-', 'logs/', 'lib/', 'historical-capture/'))   # noqa: E731  (bundle bytes are immutable)
    # r6 fix (root r15-candidate-1283: reproof kept an INTERMEDIATE producer sha): track, per file, the sha currently written into its
    # pinners and replace exactly that one whenever the file changes again, to a fixed point; every superseded sha is remembered and
    # asserted absent from every cascaded file at the end.
    pinned = dict(listed); history = {r: {listed[r]} for r in listed}
    while True:
        changed = False
        for r in sorted(listed):
            cur = h(files[r])
            if cur == pinned[r]:
                continue
            for rel, b in list(files.items()):
                if cascade(rel) and rel != r and pinned[r].encode() in b:
                    files[rel] = b.replace(pinned[r].encode(), cur.encode())
            history[r].add(pinned[r]); pinned[r] = cur; changed = True
        if not changed:
            break
    stale = sorted((rel, r) for rel, b in files.items() if cascade(rel) for r in listed
                   for old_sha in history[r] - {h(files[r])} if old_sha.encode() in b)
    assert not stale, ('superseded pins remain', stale)
    m = json.loads(files['install/MANIFEST.json'])
    m['stage'] = STAGE_NAME
    for e in m['files']:
        if not e['src'].startswith('bundle/'):
            e['sha256'] = h(files[e['src']])
    dests = {e['dest'] for e in m['files']}
    assert not any('anchored-coverage' in d or d.startswith(BUNDLE_DEST) for d in dests)
    for rel, mode in sorted(bundle_modes.items()):
        m['files'].append({'src': f'{BUNDLE_SRC}/{rel}', 'dest': f'{BUNDLE_DEST}/{rel}', 'sha256': h(files[f'{BUNDLE_SRC}/{rel}']), 'mode': mode})
    files['install/MANIFEST.json'] = (json.dumps(m, indent=1) + '\n').encode()
    edited = sorted(r for r in listed if files[r] != (R14 / r).read_bytes())
    new = sorted(r for r in files if r not in listed)
    rows = ['path\tsha256\tkind\tr14_sha256']
    for r in edited:
        rows.append(f'{r}\t{h(files[r])}\tedit\t{listed[r]}')
        diff = difflib.unified_diff((R14 / r).read_text().splitlines(True), files[r].decode().splitlines(True), f'a/{r}', f'b/{r}')
        files[f'integration-r18/{r.replace("/", "_")}.patch'] = ''.join(diff).encode()
    for r in new:
        rows.append(f'{r}\t{h(files[r])}\tnew\t-')
    files['COMPOSITION-r18.tsv'] = ('\n'.join(rows) + '\n').encode()
    files[JOB] = job(edited).encode()
    for rel, b in files.items():
        p = out / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
        if rel.endswith('.sh') or (R14 / rel).exists() and (R14 / rel).stat().st_mode & 0o111 \
                or rel.startswith(BUNDLE_SRC + '/') and bundle_modes[rel[len(BUNDLE_SRC) + 1:]] == '0755':
            p.chmod(0o755)
    (out / 'SHA256SUMS').write_text(''.join(f'{h(files[r])}  ./{r}\n' for r in sorted(files)))
    print(json.dumps({'out': str(out), 'edited': edited, 'new': new, 'manifestFiles': len(m['files']), 'manifestTrees': len(m['trees']),
                      'SHA256SUMS': h((out / 'SHA256SUMS').read_bytes())}, indent=1))


def job(edited):
    s = (R14 / 'jobs/root-finality-r14-witness-tests.sh').read_text()
    cand = str(W / 'historical-origin-segments-stage' / STAGE_NAME.split('historical-origin-segments-stage/')[1])
    s = one(s, '#!/bin/bash\n', '#!/bin/bash\n# r18 CANDIDATE (generated by historical-origin-segments-stage/r8/tools/compose_r18_candidate.py from r14-witness 1ba2d51a):\n'
            '# r14 + the anchored-coverage wrapper/readiness/publisher overlays + the historical-capture bundle (020cc8bf) + pin cascade + MANIFEST (82 files).\n'
            '# Root runs it (foreground): ./jobs/q-exit-status.sh root-r18-candidate-1 1024 unshare -Urn bash ' + cand + '/' + JOB + '\n'
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
            f"assert m['stage'] == '{STAGE_NAME}' and (len(m['files']), len(m['trees'])) == (82, 14)")
    s = one(s, "print('r14 manifest: stage r14-witness, 64 files (61 + bridge + 2 units), 14 trees, 32 bundle entries')",
            "bm = json.loads((S / 'historical-capture/" + BUNDLE_SHA + "/MANIFEST.json').read_text())\n"
            "for r, be in list(bm['files'].items()) + [('MANIFEST.json', {'mode': '0644', 'sha256': '" + BUNDLE_SHA + "'})]:\n"
            "    e = got['" + BUNDLE_DEST + "/' + r]; assert (e['src'], e['mode'], e['sha256']) == ('" + BUNDLE_SRC + "/' + r, be['mode'], be['sha256']) == ('" + BUNDLE_SRC + "/' + r, be['mode'], h('" + BUNDLE_SRC + "/' + r)), r\n"
            "assert not [d for d in got if 'anchored-coverage' in d]\n"
            "print('r18 candidate manifest: 64 r14 files (re-pinned) + 18 historical-capture bundle files (020cc8bf, own modes), 14 trees, 32 bundle entries')")
    s = one(s, '# ---- the witness r2 job (12)', READINESS_RUNS + '# ---- the witness r2 job (12)')
    return s


CANDIDATE_PROOF = r'''/usr/bin/python3 -I - $ST $R14 <<'PYR18' || die "r18 candidate composition"
import difflib, hashlib, pathlib, sys
S, R = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
sums = lambda d: {l.split(None, 1)[1].strip().removeprefix('./'): l.split()[0] for l in (d / 'SHA256SUMS').read_text().splitlines()}
a, b = sums(R), sums(S); rows = [l.split('\t') for l in (S / 'COMPOSITION-r18.tsv').read_text().splitlines()[1:]]
EDIT = {r[0] for r in rows if r[2] == 'edit'}; NEW = {r[0] for r in rows if r[2] == 'new'}
assert {'wrapper/chain_service.py', 'readiness/readiness_sampler.py', 'readiness/publish_readiness.py', 'producer/base_launch.py', 'install/MANIFEST.json'} <= EDIT, EDIT
import json
BS = '020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e'; bm_raw = (S / f'historical-capture/{BS}/MANIFEST.json').read_bytes()
assert hashlib.sha256(bm_raw).hexdigest() == BS, 'bundle MANIFEST is not 020cc8bf'
assert NEW == {f'historical-capture/{BS}/{r}' for r in json.loads(bm_raw)['files']} | {f'historical-capture/{BS}/MANIFEST.json'}, sorted(NEW)[:4]
assert all(hashlib.sha256((S / f'historical-capture/{BS}/{r}').read_bytes()).hexdigest() == e['sha256'] for r, e in json.loads(bm_raw)['files'].items())
ADDED = NEW | {'COMPOSITION-r18.tsv', 'jobs/root-r18-candidate-tests.sh'} | {f'integration-r18/{r.replace("/", "_")}.patch' for r in EDIT}
assert set(b) == set(a) | ADDED, sorted(set(a) ^ set(b))
assert not [p for p in a if p not in EDIT and a[p] != b[p]], 'changed outside the declared edits'
for r in rows:
    assert h(S / r[0]) == r[1], r[0]
    if r[2] == 'edit':
        d = ''.join(difflib.unified_diff((R / r[0]).read_text().splitlines(True), (S / r[0]).read_text().splitlines(True), f'a/{r[0]}', f'b/{r[0]}'))
        assert d == (S / 'integration-r18' / (r[0].replace('/', '_') + '.patch')).read_text() and r[3] == a[r[0]], ('edit record', r[0])
print('r18 candidate = r14 (1ba2d51a) +', sorted(EDIT), '+', sorted(NEW))
PYR18
'''

READINESS_RUNS = r'''# ---- readiness (changed by the candidate, so RUN, never reused): ops-readiness 27 on the candidate tree, sampler 93 on the candidate sampler
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 1200 /usr/bin/python3 -I -B tests/test_ops_readiness.py -v < /dev/null) > $OUT/ops-readiness.txt 2>&1; check ops-readiness 27 $?
(cd $SC/readiness && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp ORIGIN_EXTRACT=$P/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/origin_extract.py \
   timeout 2400 /usr/bin/python3 -I -B test_readiness_sampler.py -v < /dev/null) > $OUT/sampler.txt 2>&1; check sampler 93 $?
'''

if __name__ == '__main__':
    main(sys.argv[1])
