#!/usr/bin/env python3
"""assemble.py OUTDIR (workstation; PREPARED, NOT run). Reuses the frozen cold-proof canary assembler BYTE-IDENTICALLY (imported from
cold-proof-timeout-stage/r3/canary/tools/assemble_canary_bundle.py, sha-pinned; its `S` is pointed at THIS stage so it reads THIS
stage's COMPOSED-STAGE-PINS.json; nothing copied). Then adds the ONE extra input the original-game recheck needs: the composed
manifest's file whose sha256 is the pinned initial receipt b9a90847, at CONSUMER-CONTRACT.json `initialReceiptInstallPath`, taken
from the composed stage or its bundle-origin, appended to BUNDLE.sha256. Refuses if the contract is unfilled or the composition does
not install that receipt at that path (the production recheck would have no input)."""
import hashlib, importlib.util, json, pathlib, sys
S = pathlib.Path(__file__).resolve().parent.parent; W = S.parent
BASE = W / 'cold-proof-timeout-stage/r3/canary/tools/assemble_canary_bundle.py'
BASE_SHA = '61ba3daf39768232572f34cf9266723ab04cc3264c3dd565c60f841d795c3dae'
INITIAL = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'
sha = lambda b: hashlib.sha256(b).hexdigest()
def main(out):
    out = pathlib.Path(out); ct = json.loads((S / 'CONSUMER-CONTRACT.json').read_text())
    pend = [k for k in ('consumer', 'initialReceiptSupply', 'initialReceiptInstallPath', 'captureKwargs') if ct.get(k) is None]
    if pend:
        raise SystemExit(f'REFUSED: CONSUMER-CONTRACT.json pending {pend} (filled from da0\'s FROZEN first-bootstrap consumer)')
    dest = ct['initialReceiptInstallPath']
    if not isinstance(dest, str) or not dest.startswith('/opt/enclave-rpc/') or '..' in dest:
        raise SystemExit('REFUSED: initialReceiptInstallPath must be an /opt/enclave-rpc/ install destination')
    b = BASE.read_bytes()
    if sha(b) != BASE_SHA:
        raise SystemExit('REFUSED: the reused cold-proof canary assembler is not the frozen 61ba3daf')
    spec = importlib.util.spec_from_file_location('cold_assembler', BASE); A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
    A.S = S                                                                 # read THIS stage's COMPOSED-STAGE-PINS.json
    A.main(str(out))
    pins = json.loads((S / 'COMPOSED-STAGE-PINS.json').read_text()); R = W / pins['stage']
    m = json.loads((R / 'install/MANIFEST.json').read_bytes()); bo = json.loads((R / 'bundle-origin.json').read_bytes())['entries']
    hit = [e for e in m['files'] if e['dest'] == dest]
    if len(hit) != 1 or hit[0]['sha256'] != INITIAL:
        raise SystemExit(f'REFUSED: the composed manifest does not install the pinned initial receipt b9a90847 at {dest}')
    e = hit[0]; src = pathlib.Path(bo[e['src']]['origin']) if e['src'].startswith('bundle/') else R / e['src']
    rb = src.read_bytes()
    if sha(rb) != INITIAL:
        raise SystemExit(f'REFUSED: {src} is not b9a90847')
    rel = 'opt/' + dest[len('/opt/enclave-rpc/'):]; t = out / 'bundle' / rel
    if t.exists():
        if sha(t.read_bytes()) != INITIAL: raise SystemExit(f'REFUSED: {rel} already bundled with other bytes')
    else:
        t.parent.mkdir(parents=True, exist_ok=True); t.write_bytes(rb)
        with open(out / 'BUNDLE.sha256', 'a') as f: f.write(f'{INITIAL}  {rel}\n')
    (out / 'CONSUMER-CONTRACT.json').write_bytes((S / 'CONSUMER-CONTRACT.json').read_bytes())
    print(json.dumps({'initialReceipt': rel, 'contract': ct['consumer']}))
if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    main(sys.argv[1])
