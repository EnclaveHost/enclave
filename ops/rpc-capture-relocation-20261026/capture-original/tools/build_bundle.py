#!/usr/bin/python3 -IB
"""Deterministically build the relocatable historical-capture bundle from sha-pinned sources (read-only inputs).

  build_bundle.py --out NEW_DIR [--patches-out DIR]

Inputs (each verified by sha256 before use; nothing is fetched, nothing outside --out/--patches-out is written):
  historical-origin-segments-stage/r4/src/{anchored_origin.py, segments.py, anchored_acceptance.py, bind_anchor.mjs}
      (r4 SHA256SUMS verified; r5/src is byte-identical for all four)
  source/ops/rpc-backend-bootstrap/2026-10-25/coverage/{origin_extract.py 6b63b901, coverage_gate.py b4f6d639}
  base-finality-proof-stage/r12-final/vendor/anchor-bootstrap.mjs 90a8afba (no imports)
  source/node_modules/@noble/hashes (1.8.0): sha3.js 313da357 + its static require() closure under node/CJS conditions + package.json
  source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/a1-evidence.json b9a90847 (the authoritative A1 receipt)
  coverage-stage/kzgcheck/target/release/kzgcheck 00b3eeb9 (c-kzg 2.1.8 + alloy 2.4.1, as pinned by the gate's own tests)
The ONLY code changes are the two path patches below (PINS/GATE resolved from the bundle root instead of a workstation path); every
pinned sha256 value, format, rule, exact-N logic and freshness bound is untouched."""
import argparse, difflib, hashlib, json, os, re, shutil, stat, sys

W = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'
STAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R4 = f'{W}/historical-origin-segments-stage/r4'
R4_SUMS = '57d9772024e33507797688210c8d1eb972ae57c0487bfdee0c8e99f6ab4cfe6b'
COV = f'{W}/source/ops/rpc-backend-bootstrap/2026-10-25/coverage'
NOBLE = f'{W}/source/node_modules/@noble/hashes'
SRC = {   # bundle path: (source path, sha256)
    'lib/anchored_origin.py': (f'{R4}/src/anchored_origin.py', 'ed1a547d4d8aea112cae66479c64cd9e556b531063ef361c9b156c6d2948ddfa'),
    'lib/segments.py': (f'{R4}/src/segments.py', '8764f5cc55cc42307eadbe71695bb986ca5fa86c07db671553d50d0635c51aa1'),
    'lib/anchored_acceptance.py': (f'{R4}/src/anchored_acceptance.py', 'cb68413866d0534822bdfc37702e253acfe04abad30d98e34b2231595518138d'),
    'lib/bind_anchor.mjs': (f'{R4}/src/bind_anchor.mjs', 'f729420ca16127ae6b19745cc9d500df0b9ae4c97ec90e0656bfeceb9ccd43d8'),
    'vendor/coverage/origin_extract.py': (f'{COV}/origin_extract.py', '6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c'),
    'vendor/coverage/coverage_gate.py': (f'{COV}/coverage_gate.py', 'b4f6d639c3f9b12f73938d5993ce0897fe56dcbec1ada3123c4ad80d0ff3854b'),
    'vendor/coverage/kzgcheck': (f'{W}/coverage-stage/kzgcheck/target/release/kzgcheck', '00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb'),
    'vendor/anchor-bootstrap.mjs': (f'{W}/base-finality-proof-stage/r12-final/vendor/anchor-bootstrap.mjs',
                                    '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'),
    'receipt/a1-evidence.json': (f'{W}/source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/a1-evidence.json',
                                 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'),
    'bin/historical-capture': (f'{STAGE}/src/historical-capture', None),     # this stage's own entrypoint (pinned by stage SHA256SUMS)
    'bin/guest-capture.sh': (f'{STAGE}/src/guest-capture.sh', None),         # root's guest runner (pinned by stage SHA256SUMS)
}
NOBLE_ROOT_SHA3 = '313da3570150e80b02c3631508ba99099438d2daff641b9cadb2198e0f1d18ec'
EXEC = {'bin/historical-capture', 'bin/guest-capture.sh', 'vendor/coverage/kzgcheck'}
AO_OLD_W = "W = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025'\n"
AO_NEW_W = ("ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))   # relocatable bundle root: <ROOT>/lib/anchored_origin.py\n"
            "W = ROOT\n")
PATCHES = {
    'lib/anchored_origin.py': [
        (AO_OLD_W, AO_NEW_W),
        ("f'{W}/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/origin_extract.py'", "f'{ROOT}/vendor/coverage/origin_extract.py'"),
        ("f'{W}/base-finality-proof-stage/r12-final/vendor/anchor-bootstrap.mjs'", "f'{ROOT}/vendor/anchor-bootstrap.mjs'"),
        ("f'{W}/source/node_modules/@noble/hashes/sha3.js'", "f'{ROOT}/vendor/node_modules/@noble/hashes/sha3.js'"),
        ("f'{W}/source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/a1-evidence.json'", "f'{ROOT}/receipt/a1-evidence.json'"),
    ],
    'lib/segments.py': [
        ("GATE = (f'{AO.W}/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/coverage_gate.py',",
         "GATE = (f'{AO.ROOT}/vendor/coverage/coverage_gate.py',"),
    ],
}
EXTERNAL = {
    'base': {'sha256': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f', 'guestPath': '/opt/enclave-rpc/bin/base',
             'evidence': 'guest /opt/enclave-rpc/manifest.json binaries.base (production-cutover-inventory-stage/evidence/guest-units-config.txt)'},
    'node': {'sha256': None, 'guestPath': '/usr/bin/node', 'evidence': 'operator-supplied --node; guest node 18 per r16 install/MISSING.md; '
             'NOT pinned by sha here (unknown on the guest): record `node --version` and its sha256 in the run receipt'},
    'python': {'minimum': '3.11', 'evidence': 'hashlib.file_digest; guest Python 3.12 per r16 install/MISSING.md'},
}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_pinned(path, want):
    b = open(path, 'rb').read()
    if want is not None and sha(b) != want:
        raise SystemExit(f'{path} is not the pinned {want[:12]} (got {sha(b)[:12]})')
    return b


def noble_closure():
    """sha3.js plus every file it require()s, transitively, under Node's CJS conditions (node, require, default)."""
    pkg = json.load(open(f'{NOBLE}/package.json'))
    assert pkg['name'] == '@noble/hashes' and pkg['version'] == '1.8.0', 'noble package is not @noble/hashes 1.8.0'
    todo, seen = ['sha3.js'], set()
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        src = open(f'{NOBLE}/{rel}', encoding='utf-8').read()
        if re.search(r'^\s*(import|export)\s.*from\s|import\(', src, re.M):
            raise SystemExit(f'noble {rel}: ESM import in a CJS closure file')
        for spec in re.findall(r'require\("([^"]+)"\)', src):
            if spec.startswith('node:'):
                continue
            if spec.startswith('./'):
                todo.append(os.path.normpath(os.path.join(os.path.dirname(rel), spec)))
            elif spec.startswith('@noble/hashes/'):
                e = pkg['exports']['./' + spec[len('@noble/hashes/'):]]
                for cond in ('node', 'require', 'default'):
                    if isinstance(e, dict) and cond in e:
                        e = e[cond]
                if isinstance(e, dict):
                    e = e.get('default')
                todo.append(os.path.normpath(e))
            else:
                raise SystemExit(f'noble {rel}: unexpected dependency {spec!r}')
    return sorted(seen) + ['package.json', 'LICENSE']


def build(out, patches_out=None):
    if os.path.exists(out):
        raise SystemExit(f'--out {out} exists')
    sums = open(f'{R4}/SHA256SUMS', 'rb').read()
    if sha(sums) != R4_SUMS:
        raise SystemExit('r4 SHA256SUMS is not the reviewed 57d97720')
    files, prov, diffs = {}, {}, {}
    for rel, (path, want) in SRC.items():
        b = read_pinned(path, want)
        p = {'source': os.path.relpath(path, W), 'sourceSha256': sha(b)}
        if rel in PATCHES:
            t = b.decode()
            for old, new in PATCHES[rel]:
                if t.count(old) != 1:
                    raise SystemExit(f'{rel}: patch anchor not found exactly once: {old[:60]!r}')
                t = t.replace(old, new)
            nb = t.encode()
            diffs[rel] = ''.join(difflib.unified_diff(b.decode().splitlines(True), t.splitlines(True),
                                                      f'a/{os.path.basename(rel)}', f'b/{os.path.basename(rel)}'))
            p['patch'] = f'patches/{os.path.basename(rel)}.patch'; b = nb
        files[rel], prov[rel] = b, p
    for rel in noble_closure():
        b = open(f'{NOBLE}/{rel}', 'rb').read()
        if rel == 'sha3.js' and sha(b) != NOBLE_ROOT_SHA3:
            raise SystemExit('noble sha3.js is not the pinned 313da357')
        files[f'vendor/node_modules/@noble/hashes/{rel}'] = b
        prov[f'vendor/node_modules/@noble/hashes/{rel}'] = {'source': os.path.relpath(f'{NOBLE}/{rel}', W), 'sourceSha256': sha(b)}
    for rel in ('lib/anchored_origin.py', 'lib/segments.py', 'lib/anchored_acceptance.py', 'lib/bind_anchor.mjs', 'bin/historical-capture', 'bin/guest-capture.sh',
                'vendor/coverage/origin_extract.py', 'vendor/coverage/coverage_gate.py'):
        if b'/home/' in files[rel]:
            raise SystemExit(f'{rel} still names a /home path')
    rec = json.loads(files['receipt/a1-evidence.json'])
    m = {'format': 'enclave-historical-capture-bundle/v1',
         'purpose': 'exact-N read-only anchored origin extraction + segmented L1 receipt/beacon/KZG coverage (no activation, no chain.json write)',
         'anchor': {'N': int(rec['N']), 'outputRoot': rec['outputRoot'], 'game': rec['game'], 'receiptSha256': SRC['receipt/a1-evidence.json'][1],
                    'verdict': rec['verdict']},
         'pins': {'originExtract': SRC['vendor/coverage/origin_extract.py'][1], 'coverageGate': SRC['vendor/coverage/coverage_gate.py'][1],
                  'anchorBootstrap': SRC['vendor/anchor-bootstrap.mjs'][1], 'nobleSha3': NOBLE_ROOT_SHA3, 'kzgcheck': SRC['vendor/coverage/kzgcheck'][1],
                  'bindAnchorScript': SRC['lib/bind_anchor.mjs'][1], 'gateHardMaxBlocks': 30000, 'maxEvidenceAgeSec': 43200, 'seqWindow': 3600},
         'externalPins': EXTERNAL,
         'files': {rel: {'sha256': sha(b), 'mode': '0755' if rel in EXEC else '0644', **prov[rel]} for rel, b in sorted(files.items())}}
    os.makedirs(out)
    for rel, b in files.items():
        p = os.path.join(out, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'xb') as f:
            f.write(b)
        os.chmod(p, 0o755 if rel in EXEC else 0o644)
    with open(os.path.join(out, 'MANIFEST.json'), 'x') as f:
        json.dump(m, f, indent=1, sort_keys=True); f.write('\n')
    os.chmod(os.path.join(out, 'MANIFEST.json'), 0o644)
    if patches_out:
        os.makedirs(patches_out, exist_ok=True)
        for rel, d in diffs.items():
            with open(os.path.join(patches_out, os.path.basename(rel) + '.patch'), 'w') as f:
                f.write(d)
    return sha(open(os.path.join(out, 'MANIFEST.json'), 'rb').read()), len(files)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--patches-out')
    a = ap.parse_args()
    bid, n = build(a.out, a.patches_out)
    print(json.dumps({'bundleId': bid, 'files': n, 'out': a.out}))
