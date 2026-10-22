#!/usr/bin/env python3
"""Focused tests of assemble.py on a SYNTHETIC mini base (the real .47 base zip is a root-supplied input). LOCAL ONLY.
Checks: deterministic zip across two runs; manifest == zip manifest.json, .47 format keys, BOM; overlays exact, base bytes
exact; refusals (tampered base member, unlisted base member, a BASE row that is not in the base); the UNSIGNED statement over
the actual artifacts via the live verifier; check-release.py passes the required overlay; the real CLI refuses with the
MISSING INPUT message while the root inputs are absent."""
import hashlib, importlib.util, json, pathlib, shutil, subprocess, sys, tempfile, zipfile

H = pathlib.Path(__file__).resolve().parent; A = H.parent; W = next(p for p in A.parents if p.name == 'work')
sp = importlib.util.spec_from_file_location('asm', A / 'assemble.py'); asm = importlib.util.module_from_spec(sp); sp.loader.exec_module(asm)
sha = lambda b: hashlib.sha256(b).hexdigest(); results = []
def case(n, ok, info=''): results.append((n, bool(ok))); print(('PASS ' if ok else 'FAIL ') + n, '' if ok else str(info)[:600], flush=True)
T = pathlib.Path(tempfile.mkdtemp(prefix='asm-', dir=str(A)))   # on disk in this scope (not RAM /tmp)
try:
    base = {'control/windows/node/agent.mjs': b'old agent', 'bin/shield-host.exe': b'MZ native, never rebuilt' * 100, 'runtime/node/node.exe': b'MZ node' * 1000,
            'update-host.ps1': b'# legacy updater', 'install-host.ps1': b'# legacy installer'}
    man = {'product': 'Enclave host for Windows', 'version': '2026.10.12.47', 'control': 'fb6561c0',
           'files': [{'path': p, 'sha256': sha(b), 'bytes': len(b)} for p, b in sorted(base.items())]}
    mf = T / 'manifest-base.json'; mf.write_bytes(('﻿' + json.dumps(man)).encode())
    def basezip(name, extra=None, tamper=None):
        z = T / name
        with zipfile.ZipFile(z, 'w') as zf:
            for p, b in base.items(): zf.writestr(p, b + (b'X' if p == tamper else b''))
            zf.writestr('manifest.json', mf.read_bytes())
            if extra: zf.writestr(extra, b'?')
        return z
    bz = basezip('base.zip')
    ovsrc = {'control/windows/node/agent.mjs': b'new applied agent', 'update-host.ps1': (W / 'claude-resumed-20261022/updater-first-hop-r4/src/update-host.first-hop.ps1').read_bytes(),
             'control/network/wallet-admission.mjs': b'a new file'}
    overlay = {}
    for p, b in ovsrc.items():
        f = T / ('ov-' + p.replace('/', '_')); f.write_bytes(b); overlay[p] = (sha(b), f)
    base_rows = {'bin/shield-host.exe': sha(base['bin/shield-host.exe'])}
    setup = T / 'setup.exe'; setup.write_bytes(b'MZ .47 setup bytes')
    p1 = asm.assemble(bz, mf, overlay, base_rows, setup, T / 'out1'); p2 = asm.assemble(bz, mf, overlay, base_rows, setup, T / 'out2')
    z1, z2 = (T / f'out{i}/enclave-host-2026.10.22.1.zip' for i in (1, 2))
    case('deterministic: two assemblies give a byte-identical zip', sha(z1.read_bytes()) == sha(z2.read_bytes()), (p1['artifacts'], p2['artifacts']))
    with zipfile.ZipFile(z1) as zf:
        names = zf.namelist(); inner = zf.read('manifest.json'); dates = {i.date_time for i in zf.infolist()}
        content = {n: zf.read(n) for n in names if n != 'manifest.json'}
    pub = (T / 'out1/manifest-2026.10.22.1.json').read_bytes(); mj = json.loads(pub.decode('utf-8-sig'))
    case('manifest-<v>.json == the zip manifest.json, BOM, .47 keys, version 2026.10.22.1', inner == pub and pub.startswith(b'\xef\xbb\xbf') and list(mj) == ['product', 'version', 'control', 'files'] and mj['version'] == '2026.10.22.1')
    case('overlays exact, base natives exact, nothing else changed', all(content[p] == b for p, b in ovsrc.items()) and content['bin/shield-host.exe'] == base['bin/shield-host.exe']
         and content['runtime/node/node.exe'] == base['runtime/node/node.exe'] and content['install-host.ps1'] == base['install-host.ps1']
         and sorted(names) == sorted(set(base) | set(ovsrc) | {'manifest.json'}) and len(names) == len(set(names)), names)
    case('manifest entries == the zip bytes (sha/bytes)', all(e['sha256'] == sha(content[e['path']]) and e['bytes'] == len(content[e['path']]) for e in mj['files']) and len(mj['files']) == len(content))
    case('one fixed date on every entry', dates == {asm.STAMP}, dates)
    def refused(fn):
        try: fn(); return False
        except SystemExit as e: return str(e).startswith('REFUSED')
    case('refuses a tampered base member', refused(lambda: asm.assemble(basezip('t.zip', tamper='runtime/node/node.exe'), mf, overlay, base_rows, setup, T / 'o3')))
    case('refuses a base member the manifest does not list', refused(lambda: asm.assemble(basezip('x.zip', extra='bin/planted.exe'), mf, overlay, base_rows, setup, T / 'o4')))
    case('refuses a BASE row that is not in the base', refused(lambda: asm.assemble(bz, mf, overlay, {'bin/shield-host.exe': '0' * 64}, setup, T / 'o5')))
    st = asm.statement(T / 'out1'); sums = dict(reversed(l.split('  ')) for l in (T / 'out1/SHA256SUMS').read_text().splitlines())
    case('UNSIGNED statement over the actual artifacts (live verifier CLI)', st['version'] == '2026.10.22.1' and st['sha256'] == sums[st['file']] and st['setupSha256'] == sums[st['setup']]
         and st['manifestSha256'] == sums[st['manifest']] and not (T / 'out1/latest.signed.json').exists(), st)
    req = T / 'req.json'; req.write_text(json.dumps({'control/windows/node/agent.mjs': overlay['control/windows/node/agent.mjs'][0], 'update-host.ps1': overlay['update-host.ps1'][0]}))
    r = subprocess.run([sys.executable, '-B', str(W / 'g4-release-train-20261021/check-release.py'), '--installed', str(mf), '--new', str(T / 'out1/manifest-2026.10.22.1.json'), '--required', str(req)], capture_output=True, text=True)
    case('check-release.py: the assembled manifest carries the required files (exit 0)', r.returncode == 0, r.stdout[-500:] + r.stderr[-300:])
    e = T / 'empty-inputs'; e.mkdir()
    r = subprocess.run([sys.executable, '-B', str(A / 'assemble.py'), '--inputs', str(e), '--out', str(T / 'real-out')], capture_output=True, text=True)
    case('real CLI with no root inputs: REFUSED MISSING INPUT, nothing written', r.returncode != 0 and 'MISSING INPUT' in (r.stdout + r.stderr) and not (T / 'real-out').exists(), r.stdout + r.stderr)
finally:
    shutil.rmtree(T, ignore_errors=True)
print(json.dumps({'pass': sum(o for _, o in results), 'fail': sum(not o for _, o in results), 'tempRemoved': not T.exists()}))
sys.exit(0 if all(o for _, o in results) else 1)
