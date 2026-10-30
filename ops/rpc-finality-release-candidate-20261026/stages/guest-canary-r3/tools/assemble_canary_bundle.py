#!/usr/bin/env python3
"""assemble_canary_bundle.py OUTDIR (workstation; r3; PREPARED, NOT run). The canary bundle is EXACTLY the frozen
base-finality-proof-stage/r10's OWN install/MANIFEST.json entries under /opt/enclave-rpc/{a1-capture,a1gate,finality}/, each read from
r10 itself or from r10's bundle-origin.json origin, every byte checked against r10's manifest. Nothing is patched, re-derived or taken
from an older closure. Refuses unless R10-REVIEW-PINS.json is fully filled, logs/claude-finality-r10-result.md exists, r10's
SHA256SUMS digest equals the pin and every r10 file still matches it, and the three reviewed modules equal their pins.
Writes OUTDIR/bundle/opt/... (the /opt/enclave-rpc layout, so a1_capture.py finds <grandparent>/a1gate and finality_state.py finds
<parent>/src exactly as in production), OUTDIR/BUNDLE.sha256, OUTDIR/HELIOS.txt and OUTDIR/BUNDLE-ORIGIN.json. Never writes into r10."""
import ast, hashlib, json, os, pathlib, re, stat, sys
W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'); R10 = W / 'base-finality-proof-stage/r10'
S = pathlib.Path(__file__).resolve().parent.parent; OPT = '/opt/enclave-rpc/'
WANT = (OPT + 'a1-capture/', OPT + 'a1gate/', OPT + 'finality/')
PIN_KEYS = ('r10Sha256sums', 'r10Manifest', 'r10BundleOrigin', 'captureModule', 'finalityState', 'finalityCore')
HEX = re.compile(r'[0-9a-f]{64}')
sha = lambda b: hashlib.sha256(b).hexdigest()
def regular(p):
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode):
        raise SystemExit(f'{p} is not a regular file')
    return pathlib.Path(p).read_bytes()
def put(src, dst, want, mode, rows):
    b = regular(src)
    if sha(b) != want:
        raise SystemExit(f'{src} is not the r10-manifest {want[:12]}')
    if os.path.lexists(dst):
        raise SystemExit(f'{dst} listed twice')
    dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(b); os.chmod(dst, mode); rows.append((want, dst))
def main(out):
    pins = json.loads((S / 'R10-REVIEW-PINS.json').read_text())
    pending = [k for k in PIN_KEYS if not HEX.fullmatch(str(pins.get(k)))]
    if pending:
        raise SystemExit(f'REFUSED: r10 not frozen/reviewed; pins pending: {pending}')
    if not (W / 'logs/claude-finality-r10-result.md').is_file():
        raise SystemExit('REFUSED: logs/claude-finality-r10-result.md (r10 freeze report) is missing')
    sums = regular(R10 / 'SHA256SUMS')
    if sha(sums) != pins['r10Sha256sums']:
        raise SystemExit('REFUSED: r10 SHA256SUMS is not the reviewed one')
    listed = {}
    for line in sums.decode().splitlines():
        h, rel = line.split(None, 1); rel = rel.strip().removeprefix('./'); listed[rel] = h
        if sha(regular(R10 / rel)) != h:
            raise SystemExit(f'REFUSED: r10/{rel} changed since its freeze')
    for rel, key in (('install/MANIFEST.json', 'r10Manifest'), ('bundle-origin.json', 'r10BundleOrigin')):
        if listed.get(rel) != pins[key]:
            raise SystemExit(f'REFUSED: r10 {rel} is not the reviewed {key}')
    m = json.loads((R10 / 'install/MANIFEST.json').read_bytes()); bo = json.loads((R10 / 'bundle-origin.json').read_bytes())['entries']
    if m.get('stage') != 'base-finality-proof-stage/r10':
        raise SystemExit(f'REFUSED: manifest stage is {m.get("stage")}')
    B = pathlib.Path(out) / 'bundle'
    if os.path.lexists(B):
        raise SystemExit(f'{B} exists')
    rows = []; dst = lambda dest: B / 'opt' / dest[len(OPT):]
    def origin(rel, want=None):
        if not rel.startswith('bundle/'):
            if rel not in listed:
                raise SystemExit(f'REFUSED: {rel} is not covered by r10 SHA256SUMS')
            return R10 / rel
        e = bo.get(rel)
        if e is None or (want is not None and e.get('sha256') != want):
            raise SystemExit(f'REFUSED: {rel} has no matching r10 bundle-origin entry')
        return pathlib.Path(e['origin'])
    for e in m['files']:
        if e['dest'].startswith(WANT) and not e.get('config'):
            put(origin(e['src'], e['sha256']), dst(e['dest']), e['sha256'], int(e['mode'], 8), rows)
    for t in m['trees']:
        if not t['dest'].startswith(WANT):
            continue
        if not isinstance(t.get('files'), dict):
            raise SystemExit(f'REFUSED: tree {t["src"]} has no per-file pins')
        root = origin(t['src']); boe = bo.get(t['src'], {})
        if boe.get('files') not in (None, t['files']):
            raise SystemExit(f'REFUSED: tree {t["src"]} differs between r10 manifest and bundle-origin')
        for r, h in sorted(t['files'].items()):
            put(root / r, dst(t['dest']) / r, h, 0o644, rows)
    got = {str(p.relative_to(B)): h for h, p in rows}
    for rel, key in (('opt/a1-capture/a1_capture.py', 'captureModule'), ('opt/finality/src/finality_state.py', 'finalityState'),
                     ('opt/finality/src/finality-core.mjs', 'finalityCore')):
        if got.get(rel) != pins[key]:
            raise SystemExit(f'REFUSED: bundled {rel} is not the reviewed {key}')
    tree = ast.parse((B / 'opt/a1-capture/a1_capture.py').read_text())
    gate = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'A1_GATE_PINS')
    for name, want in gate.items():
        if got.get(f'opt/a1gate/{name}') != want:
            raise SystemExit(f'REFUSED: r10 manifest does not install a1gate/{name} = the module\'s A1_GATE_PINS')
    hel = [r for r in got if r.startswith('opt/a1-capture/bin/helios-')]
    if len(hel) != 1:
        raise SystemExit(f'REFUSED: expected exactly one bundled helios, got {hel}')
    (pathlib.Path(out) / 'HELIOS.txt').write_text(f'{hel[0]} {got[hel[0]]}\n')
    (pathlib.Path(out) / 'BUNDLE.sha256').write_text(''.join(f'{h}  {r}\n' for r, h in sorted(got.items())))
    (pathlib.Path(out) / 'BUNDLE-ORIGIN.json').write_text(json.dumps({'stage': m['stage'], 'pins': {k: pins[k] for k in PIN_KEYS}, 'files': len(got)}, indent=1))
    print(json.dumps({'bundle': str(B), 'files': len(got), 'helios': hel[0], 'a1gate': len(gate)}))
if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    main(sys.argv[1])
