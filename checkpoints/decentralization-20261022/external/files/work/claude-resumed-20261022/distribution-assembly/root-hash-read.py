#!/usr/bin/env python3
"""ROOT-ONLY, HASH-ONLY read of the 89 required release paths under C:\\Program Files\\Enclave on minipc (ROOT-REQUEST Q1).
Prepared by Claude; never run by it. DEFAULT = PLAN ONLY (no network): prints the batches and their encoded sizes.
  root-hash-read.py --execute --root-reviewed <planSha>   -> live-hashes.json ({release path: sha256 | 'absent'}), never overwritten
Each batch is ONLY `FileSha` (Get-FileHash) of fixed paths: no content, no config, no secret, no write, no process/task call.
Transport: work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e (its HEAD defines FileSha)."""
import argparse, base64, hashlib, importlib.util, json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent; W = next(p for p in HERE.parents if p.name == 'work')
TRANSPORT = W / 'nucbox-tls-20261021/root-activate-reviewed.py'; TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
REQ = W / 'claude-resumed-20261022/distribution-closeout/required-release-files.v2.flat.json'
REQ_SHA = 'dcd7a81f13f6c5245fcdbca182f2e5e30451d9dd3c6973e7611353304151376f'
PF = 'C:\\Program Files\\Enclave\\'; OUT = HERE / 'live-hashes.json'; LIMIT = 7900
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def load():
    if sha(TRANSPORT) != TRANSPORT_SHA: raise SystemExit('transport is not c50aac8e')
    if sha(REQ) != REQ_SHA: raise SystemExit('required list is not dcd7a81f')
    s = importlib.util.spec_from_file_location('t', TRANSPORT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    return m, sorted(json.loads(REQ.read_text()))
def text(paths):
    assert all("'" not in p for p in paths)
    body = ';'.join(f"$h['{p}']=FileSha '{PF}{p.replace('/', chr(92))}'" for p in paths)
    return '$h=[ordered]@{};' + body + ';$h|ConvertTo-Json -Compress'
def batches(m, paths):
    out, cur = [], []
    for p in paths:
        t = text(cur + [p])
        if len(base64.b64encode((m.HEAD.replace('SECS', '120') + t).encode('utf-16-le'))) >= LIMIT: out.append(cur); cur = [p]
        else: cur.append(p)
    return out + ([cur] if cur else [])
def plan_sha(bs): return hashlib.sha256(json.dumps([text(b) for b in bs]).encode()).hexdigest()

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument('--execute', action='store_true'); a.add_argument('--root-reviewed'); o = a.parse_args(argv)
    m, paths = load(); bs = batches(m, paths)
    sizes = [len(base64.b64encode((m.HEAD.replace('SECS', '120') + text(b)).encode('utf-16-le'))) for b in bs]
    if not o.execute:
        print(json.dumps({'mode': 'PLAN ONLY (no network)', 'paths': len(paths), 'batches': [len(b) for b in bs], 'encodedSizes': sizes, 'planSha': plan_sha(bs),
                          'texts': [text(b) for b in bs], 'execute': f'python3 {pathlib.Path(__file__).name} --execute --root-reviewed {plan_sha(bs)}'}, indent=1)); return 0
    if o.root_reviewed != plan_sha(bs): print(json.dumps({'refused': 'missing or wrong --root-reviewed'})); return 2
    if OUT.exists(): print(json.dumps({'refused': f'{OUT.name} exists (never overwritten)'})); return 2
    res = {}
    for b in bs:
        r = m.ps(text(b), 120)
        if not isinstance(r, dict) or 'error' in r or set(r) != set(b): print(json.dumps({'failed': r})); return 1
        res.update(r)
    with OUT.open('x') as f: json.dump(dict(sorted(res.items())), f, indent=1)
    print(json.dumps({'written': str(OUT), 'paths': len(res), 'absent': [p for p, v in res.items() if v == 'absent']})); return 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
