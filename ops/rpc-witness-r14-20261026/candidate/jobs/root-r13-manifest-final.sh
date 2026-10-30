#!/bin/bash
# base-finality-proof-stage/r13-manifest-final: qualification of a METADATA-ONLY revision of root-qualified r13-final (PREPARED; root runs):
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh r13-manifest-final-1 512 unshare -Urn bash base-finality-proof-stage/r13-manifest-final/jobs/root-r13-manifest-final.sh
# Proves, never self-claims: (1) r13-final is still its qualified f58b0b4f bytes and root's ACTUAL receipt 0918 (sha 01c34175, rc 0) names it;
# (2) this stage = r13-final except install/MANIFEST.json (JSON differs ONLY in `stage`, by one exact byte span) + the two declared added
# files -> every other byte is r13-final's, so the 0918 suites are REUSED for them; (3) RETESTS what the change can affect: manifest
# closure (61 files, 14 trees, 32 bundle entries), bundle assembly + closure, ops-installer 18 on the unchanged installer with the new
# manifest, the frozen cold canary assembler (61ba3daf, unchanged, imported) accepting THIS stage and refusing r13-final / stale pins.
# Prints the installer's qualification lines `## r13 SHA256SUMS <this stage>` and `## finality-r13 rc=N` (rc 0 only on a genuine pass).
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r13-manifest-final; R13=$B/r13-final
NAME=base-finality-proof-stage/r13-manifest-final; COLD=$P/cold-proof-timeout-stage/r3/canary/tools/assemble_canary_bundle.py
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## r13 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r13 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -n"
mkdir -p "$OUT/tmp" || die "out"
# ---- 1 the qualified base and root's ACTUAL receipt ----
pin $R13/SHA256SUMS f58b0b4f70cf830e3d5a9a2ec975a932143e79432d36660241b937701f73a347; (cd $R13 && sha256sum -c --quiet SHA256SUMS) || die "r13-final changed"
pin $P/logs/root-finality-r13-final-0918.out 01c341753573e427b87c372d6049e7b72305f94adca509cb288518a530862b8c
grep -qx '## r13 SHA256SUMS f58b0b4f70cf830e3d5a9a2ec975a932143e79432d36660241b937701f73a347' $P/logs/root-finality-r13-final-0918.out \
  && grep -qx '## finality-r13 rc=0' $P/logs/root-finality-r13-final-0918.out && [ "$(cat $P/logs/root-finality-r13-final-0918.rc)" = 0 ] || die "root receipt 0918 is not a PASS of f58b0b4f"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "this stage != its SHA256SUMS"
pin $COLD 61ba3daf39768232572f34cf9266723ab04cc3264c3dd565c60f841d795c3dae
# ---- 2 metadata-only diff (from the two SHA256SUMS + bytes; nothing taken from this stage's own claims) ----
/usr/bin/python3 -I - $R13 $ST $NAME <<'PYD' > $OUT/diff.json || die "not a metadata-only revision of r13-final (see $OUT/diff.json)"
import hashlib, json, pathlib, sys
R, S, name = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
sums = lambda d: {l.split(None, 1)[1].strip().removeprefix('./'): l.split()[0] for l in (d / 'SHA256SUMS').read_text().splitlines()}
a, b = sums(R), sums(S); CHANGED, ADDED = {'install/MANIFEST.json'}, {'METADATA-REVISION.json', 'jobs/root-r13-manifest-final.sh'}
assert set(b) == set(a) | ADDED and not ADDED & set(a), ('file set', sorted(set(a) ^ set(b)))
same = [p for p in a if p not in CHANGED]; bad = [p for p in same if a[p] != b[p]]; assert not bad, ('changed beyond the manifest', bad)
ob, nb = (R / 'install/MANIFEST.json').read_bytes(), (S / 'install/MANIFEST.json').read_bytes()
assert nb == ob.replace(b'"stage": "base-finality-proof-stage/r10"', ('"stage": "%s"' % name).encode()), 'manifest is not the one-span stage edit'
oj, nj = json.loads(ob), json.loads(nb); assert {k for k in set(oj) | set(nj) if oj.get(k) != nj.get(k)} == {'stage'} and nj['stage'] == name
md = json.loads((S / 'METADATA-REVISION.json').read_text())
assert md['base']['sha256sums'] == hashlib.sha256((R / 'SHA256SUMS').read_bytes()).hexdigest() and set(md['changed']) == CHANGED and set(md['added']) == ADDED
assert md['changed']['install/MANIFEST.json']['to'] == b['install/MANIFEST.json'] and md['changed']['install/MANIFEST.json']['from'] == a['install/MANIFEST.json']
print(json.dumps({'byteIdentical': len(same), 'changed': sorted(CHANGED), 'added': sorted(ADDED), 'manifest': [a['install/MANIFEST.json'], b['install/MANIFEST.json']]}))
PYD
echo "REUSED root-finality-r13-final-0918 (PASS f58b0b4f) for $(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["byteIdentical"])' $OUT/diff.json) byte-identical files; metadata diff: install/MANIFEST.json stage only"
# ---- 3 manifest closure (61 files, 14 trees, 32 bundle entries) ----
/usr/bin/python3 -I - $ST <<'PYM' || fail "manifest closure"
import hashlib, json, pathlib, sys
S = pathlib.Path(sys.argv[1]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest(); m = json.loads((S / 'install/MANIFEST.json').read_bytes())
assert (len(m['files']), len(m['trees'])) == (61, 14), (len(m['files']), len(m['trees']))
dests = [e['dest'] for e in m['files'] + m['trees']]; assert len(dests) == len(set(dests)), 'duplicate dest'
for e in m['files']:
    assert not e['src'].startswith('/'), e
    if not e['src'].startswith('bundle/'):
        assert h(S / e['src']) == e['sha256'], e['src']
bo = json.loads((S / 'bundle-origin.json').read_text())['entries']
need = {e['src'] for e in m['files'] if e['src'].startswith('bundle/')} | {t['src'] for t in m['trees']}
assert need == set(bo) and len(bo) == 32, (len(need), len(bo), sorted(need ^ set(bo))[:5])
print('manifest closure OK: 61 files, 14 trees, 32 bundle entries')
PYM
/usr/bin/python3 -I $ST/tools/assemble_bundle.py > $OUT/assemble-bundle.txt 2>&1 && echo "bundle assembled: $(tail -1 $OUT/assemble-bundle.txt)" || fail "bundle assembly (see $OUT/assemble-bundle.txt)"
/usr/bin/python3 -I - $ST <<'PYB' || fail "bundle closure"
import hashlib, json, os, pathlib, sys
S = pathlib.Path(sys.argv[1]); m = json.loads((S / 'install/MANIFEST.json').read_bytes()); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest(); n = 0
for e in m['files']:
    if e['src'].startswith('bundle/'):
        p = S / e['src']; assert p.is_file() and not p.is_symlink() and h(p) == e['sha256'], e['src']; n += 1
for t in m['trees']:
    root = S / t['src']; found = {}
    for dp, dns, fns in os.walk(root):
        for x in dns + fns:
            q = pathlib.Path(dp, x); assert not q.is_symlink(), q
            if q.is_file(): found[q.relative_to(root).as_posix()] = h(q)
    assert found == t['files'], (t['src'], sorted(set(found) ^ set(t['files']))[:5]); n += 1
assert n == 32, n
print('bundle closure OK:', n, 'entries')
PYB
# ---- 4 ops-installer 18 (unchanged installer + tests) on a private copy with the NEW manifest ----
SC=$OUT/stage; mkdir -p $SC && (cd $ST && tar --exclude=./logs --exclude=./bundle --exclude='__pycache__' -cf - .) | (cd $SC && tar -xf -) || die "copy"
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_ops_installer.py -v < /dev/null) > $OUT/ops-installer.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests? in ' $OUT/ops-installer.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $OUT/ops-installer.txt | tail -1)
[ $r = 0 ] && [ "$ran" = 18 ] && [ "$last" = OK ] && ! grep -qE 'skipped|expected failure|unexpected success' $OUT/ops-installer.txt && echo "PASS ops-installer Ran 18 (expected 18)" || fail "ops-installer: rc $r Ran ${ran:-?} last ${last:-none}"
# ---- 5 the frozen cold canary assembler (imported unchanged; S -> a private pins dir): accepts THIS stage, refuses r13-final and stale pins ----
/usr/bin/python3 -I - $COLD $ST $R13 $NAME $OUT/tmp <<'PYC' || fail "canary assembler regression"
import hashlib, importlib.util, json, pathlib, sys
cold, S, R, name, tmp = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4], pathlib.Path(sys.argv[5])
h = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
spec = importlib.util.spec_from_file_location('cold_assembler', cold); A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
base = {'captureModule': h(S / 'capture/a1_capture.py'), 'finalityState': h(S / 'src/finality_state.py'), 'finalityCore': h(S / 'src/finality-core.mjs'),
        'a1Read': 'da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274f85', 'a1RecheckRead': '78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825',
        'bundleOrigin': h(S / 'bundle-origin.json')}
new = {'stage': name, 'stageSha256sums': h(S / 'SHA256SUMS'), 'manifest': h(S / 'install/MANIFEST.json'), **base}
old = {'stage': 'base-finality-proof-stage/r13-final', 'stageSha256sums': h(R / 'SHA256SUMS'), 'manifest': h(R / 'install/MANIFEST.json'), **base}
def run(pins, tag):
    d = tmp / f'pins-{tag}'; d.mkdir(); (d / 'COMPOSED-STAGE-PINS.json').write_text(json.dumps(pins)); A.S = d
    try:
        A.main(str(tmp / f'out-{tag}')); return 'OK'
    except SystemExit as e:
        return str(e)
r = run(new, 'new'); assert r == 'OK', r
bo = json.loads((tmp / 'out-new/BUNDLE-ORIGIN.json').read_text()); assert bo['stage'] == name and bo['files'] > 0, bo
print('ACCEPT this stage:', name, 'bundle files', bo['files'])
for tag, pins, want in (('r13final', old, 'manifest stage is base-finality-proof-stage/r10'), ('stalesums', {**new, 'stageSha256sums': old['stageSha256sums']}, 'SHA256SUMS is not the reviewed one'),
                        ('stalemanifest', {**new, 'manifest': old['manifest']}, 'install/MANIFEST.json is not the reviewed manifest'),
                        ('wrongstage', {**new, 'stage': 'base-finality-proof-stage/r13-final'}, 'SHA256SUMS is not the reviewed one')):
    r = run(pins, tag); assert r.startswith('REFUSED') and want in r, (tag, r); print('REFUSE', tag, '->', r)
PYC
rm -rf $OUT/tmp/out-* $OUT/stage
(cd $ST && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r13 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r13 rc=$rc"; exit $rc
