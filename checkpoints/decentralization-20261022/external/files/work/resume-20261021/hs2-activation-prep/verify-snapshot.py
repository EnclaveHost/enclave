# READ-ONLY: sha256 of every manifest-listed object in the local retained snapshot (both .bin and .car), streamed.
import hashlib, json, os, sys, pathlib, datetime
W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
M = W / 'hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows/data/bootstrap-manifest.json'
S = W / 'adapter-retained'
assert hashlib.sha256(M.read_bytes()).hexdigest() == '62c4ed1b40f2731be1d6124f81b0dd65c13a4b1626afaa47910e8801ee8d73ca'
def fsha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()
v = json.loads(M.read_text())['verifiedObjects']; bad = []; n = 0; total = 0
for e in v:
    for ext, want in (('bin', e['sha256']), ('car', e['carSha256'])):
        p = S / f"{e['cid']}.{ext}"
        if not p.exists() or fsha(p) != want: bad.append(p.name)
        else: n += 1; total += p.stat().st_size
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'manifestSha256': '62c4ed1b…', 'filesVerified': n, 'filesExpected': 2 * len(v), 'bytes': total, 'bad': bad[:20], 'ok': not bad and n == 2 * len(v)}
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(o, indent=1) + '\n'); print(json.dumps(o)); sys.exit(0 if o['ok'] else 1)
