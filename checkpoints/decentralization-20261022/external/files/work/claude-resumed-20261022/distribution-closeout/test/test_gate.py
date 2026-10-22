#!/usr/bin/env python3
"""Focused tests of make-policy.py and release-gate.py (LOCAL ONLY; Linux python + node; NOT Windows evidence).
A THROWAWAY P-256 key is generated in a temp dir for these tests only (as test/windows-release-channel.test.mjs does) and
deleted with it; it is not, and never becomes, a release authority. The synthetic release is built with the live verifier's
own statement/sign CLI, from the real pinned installer/updater/verifier bytes and the real installed 2026.10.12.47 manifest."""
import copy, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, zipfile

H = pathlib.Path(__file__).resolve().parent; P = H.parent; W = next(p for p in P.parents if p.name == 'work')
VER = W / 'g4-release-integration-20261021/tree/windows/node/release-channel.mjs'
UPD = W / 'claude-resumed-20261022/updater-first-hop-r4/src/update-host.first-hop.ps1'
INS = W / 'claude-resumed-20261022/dns-package-review/installer-review/src/install-host.r5.ps1'
LEGACY_UPD = W / 'g4-release-train-20261021/main-src/update-host.ps1'
INSTALLED = W / 'g4-release-train-20261021/evidence/manifest-2026.10.12.47.json'
REQ = json.loads((P / 'required-release-files.v2.flat.json').read_text())
sha = lambda b: hashlib.sha256(b).hexdigest()
results = []
def case(name, ok, info=''): results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name, '' if ok else str(info)[:900], flush=True)
def run(*a, **k): return subprocess.run([str(x) for x in a], capture_output=True, text=True, timeout=600, **k)

T = pathlib.Path(tempfile.mkdtemp(prefix='dist-gate-'))
try:
    def key(name):
        k = T / f'{name}.TEST-ONLY.pem'
        r = run('node', '-e', "const c=require('crypto');const {privateKey}=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'});"
                "require('fs').writeFileSync(process.argv[1],privateKey.export({type:'pkcs8',format:'pem'}))", k)
        assert r.returncode == 0, r.stderr
        return k, json.loads(run('node', VER, 'pubkey', '--key', k).stdout)['key']
    k1, s1 = key('k1'); k2, s2 = key('k2')
    def release(tag, version='2026.10.22.1', upd=UPD, drop_req=None, signer=k1, extra_signers=()):
        D = T / tag; D.mkdir()
        man = json.loads(INSTALLED.read_text(encoding='utf-8-sig')); man['version'] = version
        files = {e['path']: e for e in man['files']}
        pins = {'update-host.ps1': upd.read_bytes(), 'install-host.ps1': INS.read_bytes(), 'control/windows/node/release-channel.mjs': VER.read_bytes()}
        for p, h in REQ.items():
            if p == drop_req: continue
            e = files.setdefault(p, {'path': p, 'sha256': h, 'bytes': 1000}); e['sha256'] = h
        for p, b in pins.items():
            e = files.setdefault(p, {'path': p, 'sha256': sha(b), 'bytes': len(b)}); e['sha256'] = sha(b); e['bytes'] = len(b)
        man['files'] = list(files.values())
        mf = D / f'manifest-{version}.json'; mf.write_text(json.dumps(man))
        zp = D / f'enclave-host-{version}.zip'
        with zipfile.ZipFile(zp, 'w') as z:
            for p, b in pins.items(): z.writestr(p, b)
            z.writestr('manifest.json', mf.read_bytes())
        sp = D / f'EnclaveSetup-{version}.exe'; sp.write_bytes(b'MZ synthetic setup (test only)')
        st = T / f'{tag}.statement.json'
        r = run('node', VER, 'statement', '--channel', 'stable', '--version', version, '--zip', zp, '--setup', sp, '--manifest', mf, '--out', st); assert r.returncode == 0, r.stderr
        r = run('node', VER, 'sign', '--statement', st, '--key', signer, *sum((['--key', k] for k in extra_signers), []), '--out', D / 'latest.signed.json'); assert r.returncode == 0, r.stderr
        return D
    def policy(name, keys, thr=1, mirrors=('https://mirror.example.org/windows/', 'https://get.enclave.host/windows/')):
        out = T / f'{name}.policy.json'
        r = run(sys.executable, '-B', P / 'make-policy.py', *sum((['--key', k] for k in keys), []), '--threshold', thr, *sum((['--mirror', m] for m in mirrors), []), '--out', out)
        return out, r
    live = T / 'live.json'; live.write_text(json.dumps(REQ))
    def gate(D, pol):
        r = run(sys.executable, '-B', P / 'release-gate.py', '--channel-dir', D, '--policy', pol, '--on-disk', live)
        try: j = json.loads(r.stdout)
        except Exception: j = {'stdout': r.stdout[-600:], 'stderr': r.stderr[-600:]}
        return r.returncode, j
    failed = lambda j: [k for k, v in j.get('gates', {}).items() if not v.get('ok')]

    pol1, r = policy('p1', [s1])
    pj = json.loads(r.stdout) if r.returncode == 0 else {}
    case('make-policy: owner public key -> policy via the live check-policy; no independence claimed; DO-fronted mirror labelled',
         r.returncode == 0 and pj['providerIndependence'] is False and 'DigitalOcean' in pj['mirrorProviders']['https://get.enclave.host/windows/'], r.stdout + r.stderr)
    good = release('good')
    rc, j = gate(good, pol1)
    case('P1 signed release with the pinned chain + required files -> PASS (providerIndependence false)', rc == 0 and j['pass'] and j['providerIndependence'] is False, j)
    bad = release('tamper'); zp = next(bad.glob('*.zip')); zp.write_bytes(zp.read_bytes() + b'x')
    rc, j = gate(bad, pol1); case('N1 a byte added to the signed zip -> G3 fails', rc == 1 and failed(j) == ['G3 artifacts'], j)
    rc, j = gate(release('foreign', signer=k2), pol1); case('N2 signed by an UNPINNED key -> G2 fails', rc == 1 and 'G2 signature' in failed(j), j)
    rc, j = gate(release('old', version='2026.10.12.47'), pol1); case('N3 version 2026.10.12.47 (not newer) -> G4 fails', rc == 1 and 'G4 newer' in failed(j), j)
    rc, j = gate(release('legacyupd', upd=LEGACY_UPD), pol1); case('N4 zip ships the legacy e0d9df1c updater -> G5 fails', rc == 1 and 'G5 chain' in failed(j), j)
    rc, j = gate(release('noagent', drop_req='control/windows/node/agent.mjs'), pol1)
    case('N5 manifest lacks the applied agent 76cac355 -> G6 fails', rc == 1 and failed(j) == ['G6 required files'], j)
    tk = sorted(__import__('channel_common', fromlist=['x']).test_key_specs() if str(P) in sys.path else [])
    sys.path.insert(0, str(P)); import channel_common as cc; tks = sorted(cc.test_key_specs())
    _, r = policy('ptest', [tks[0]])
    case('N6 make-policy refuses a workspace TEST key', r.returncode == 2 and 'TEST key' in r.stdout, r.stdout + r.stderr)
    pol2, r = policy('p2', [s1, s2], thr=2)
    rc, j = gate(good, pol2); case('N7 2-of-2 policy, one signature -> G2 fails (host threshold rule)', rc == 1 and 'G2 signature' in failed(j), j)
    rc, j = gate(release('both', extra_signers=(k2,)), pol2); case('P2 2-of-2 policy, both owners signed -> PASS', rc == 0 and j['pass'], j)
    tp = T / 'testkey.policy.json'; tp.write_text(json.dumps({'format': 'enclave-windows-release-policy/v1', 'channel': 'stable', 'keys': [tks[0]], 'threshold': 1, 'mirrors': ['https://mirror.example.org/windows/']}))
    rc, j = gate(good, tp); case('N8 gate refuses a policy pinning a workspace TEST key -> G1 fails', rc == 1 and 'G1 policy' in failed(j), j)
finally:
    shutil.rmtree(T, ignore_errors=True)
print(json.dumps({'pass': sum(o for _, o in results), 'fail': sum(not o for _, o in results), 'tempRemoved': not T.exists()}))
sys.exit(0 if all(o for _, o in results) else 1)
