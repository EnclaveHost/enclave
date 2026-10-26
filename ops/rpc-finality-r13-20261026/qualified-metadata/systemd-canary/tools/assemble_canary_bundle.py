#!/usr/bin/env python3
"""bootstrap-systemd-canary-stage (workstation): build the upload (bundle.tar + BUNDLE.sha256 + FINAL-PINS.json) from the QUALIFIED
r13-final stage. Refuses while FINAL-PINS.json has null pins (r13-final not yet qualified), or if the stage's files differ from its
SHA256SUMS or from the pins.  assemble_canary_bundle.py OUTDIR"""
import hashlib, io, json, pathlib, sys, tarfile

S = pathlib.Path(__file__).resolve().parents[1]; P = S.parents[1]    # r2 is nested: <project>/bootstrap-systemd-canary-stage/r2
FILES = ('bootstrap/holder_gate.py', 'wrapper/chain_service.py', 'src/finality_state.py',
         'units/enclave-base-holder.service.d/60-release-mode.conf', 'units/enclave-base-finality-reproof.service')
h = lambda b: hashlib.sha256(b).hexdigest()


def main(out):
    pins = json.loads((S / 'FINAL-PINS.json').read_text())
    if not pins.get('stage') or not pins.get('stageSha256sums') or set(pins['files']) != set(FILES) or not all(pins['files'].values()):
        raise SystemExit('FINAL-PINS.json is not filled: r13-final is not qualified yet (no bundle is made)')
    st = P / pins['stage']; sums = (st / 'SHA256SUMS').read_bytes()
    if h(sums) != pins['stageSha256sums']:
        raise SystemExit('the stage SHA256SUMS is not the pinned one')
    listed = {l.split(None, 1)[1].lstrip('*').removeprefix('./'): l.split()[0] for l in sums.decode().splitlines()}
    blobs = {}
    for rel in FILES:
        b = (st / rel).read_bytes()
        if not (h(b) == listed.get(rel) == pins['files'][rel]):
            raise SystemExit(f'{rel}: stage bytes / SHA256SUMS / pin disagree')
        blobs[rel] = b
    cu = (S / 'guest/canary_units.py').read_bytes()
    if h(cu) != pins['canaryUnits']:
        raise SystemExit('guest/canary_units.py is not the pinned (reviewed) canary code')
    blobs['canary/canary_units.py'] = cu
    o = pathlib.Path(out); o.mkdir(parents=True, exist_ok=False); buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        for rel, b in sorted(blobs.items()):
            i = tarfile.TarInfo(rel); i.size = len(b); i.mode = 0o644; t.addfile(i, io.BytesIO(b))
    (o / 'bundle.tar').write_bytes(buf.getvalue())
    (o / 'BUNDLE.sha256').write_text(''.join(f'{h(b)}  {rel}\n' for rel, b in sorted(blobs.items())))
    (o / 'FINAL-PINS.json').write_bytes((S / 'FINAL-PINS.json').read_bytes())
    print(json.dumps({'out': str(o), 'files': len(blobs)}))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]) if len(sys.argv) == 2 else print(__doc__))
