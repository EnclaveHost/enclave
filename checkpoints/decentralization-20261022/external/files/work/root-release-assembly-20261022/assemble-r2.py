#!/usr/bin/env python3
"""assemble.py - the UNSIGNED Windows release 2026.10.22.1 = the installed 2026.10.12.47 release with EXACTLY the proven live
overlay (root's applied control package, the live keep set, installer r5, updater 36f9e0d6). Local only; never publishes,
signs, installs or contacts a host. Builds no binary: every native file is the .47 base's own bytes.

  assemble.py --inputs DIR --out DIR [--on-disk LIVE.json]
DIR (root-supplied, public artifacts): enclave-host-2026.10.12.47.zip (e010ea5b..., 771688006 B) and
EnclaveSetup-2026.10.12.47.exe (f9779425...), exactly the files the published latest.json (e3e6cea7) names.
Refuses: any input not its pinned sha/size; any .47 manifest entry missing from the base zip or not its sha/size; any
overlay byte not its pin. Writes into OUT: enclave-host-2026.10.22.1.zip, manifest-2026.10.22.1.json (== the zip's
manifest.json), EnclaveSetup-2026.10.22.1.exe (the .47 setup bytes), SHA256SUMS, release-2026.10.22.1.statement.json
(UNSIGNED; release-channel.mjs statement) and ASSEMBLY.json (provenance). The zip is deterministic: sorted names, one fixed
date, DEFLATE level 9, no extra attributes.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, sys, zipfile, zlib

HERE = pathlib.Path(__file__).resolve().parent.parent / 'claude-resumed-20261022/distribution-assembly'; W = next(p for p in HERE.parents if p.name == 'work')
VERSION = '2026.10.22.1'
BASE = {'version': '2026.10.12.47', 'zip': ('enclave-host-2026.10.12.47.zip', 'e010ea5b76ca0628e5b2663ef74d3ee3caa17039589112e61b6477592a5f939d', 771688006),
        'setup': ('EnclaveSetup-2026.10.12.47.exe', 'f9779425f1f59e626be411122c87364f5d281893a66711fda8452c2dfef9381c', None),
        'manifest': (W / 'g4-release-train-20261021/evidence/manifest-2026.10.12.47.json', '5b966e81da14d013dc8b940bbe0efa9d4b6c79cbcc24693013c91e491d6e6c26'),
        'latest': (W / 'g4-release-train-20261021/evidence/latest.json', 'e3e6cea7af55cbc57ee5e0d573ebf0808226a7eb69a99a2dd727f58676b487e7')}
INVENTORY = HERE / 'inventory.json'
VERIFIER = W / 'g4-release-integration-20261021/tree/windows/node/release-channel.mjs'
VERIFIER_SHA = 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942'
STAMP = (2026, 1, 1, 0, 0, 0)          # build-bundle.ps1's fixed date
CHUNK = 1 << 20

def sha_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(CHUNK), b''): h.update(b)
    return h.hexdigest()
def need(c, msg):
    if not c: raise SystemExit('REFUSED: ' + msg)

def load_overlay(inventory, w=W):
    """{path: (sha256, absolute source)} for every OVERLAY row, each re-hashed"""
    ov = {}
    for p, r in inventory['rows'].items():
        if r['class'] == 'MISSING': raise SystemExit(f'REFUSED: inventory has MISSING {p}')
        if r['class'] != 'OVERLAY': continue
        src = w / r['source']; need(sha_file(src) == r['sha256'], f'overlay {p} source {r["source"]} is not {r["sha256"][:8]}')
        ov[p] = (r['sha256'], src)
    return ov

def assemble(base_zip, base_manifest, overlay, base_rows, setup, out, version=VERSION, control_label=None):
    """base_rows: {path: sha256} that must be BASE (identical in the base manifest). -> provenance dict"""
    out.mkdir(parents=True, exist_ok=False)
    m = json.loads(pathlib.Path(base_manifest).read_text(encoding='utf-8-sig'))
    bfiles = {e['path']: e for e in m['files']}
    for p, h in base_rows.items(): need(p in bfiles and bfiles[p]['sha256'] == h, f'{p} is not the base file it is pinned as')
    files = {}
    with zipfile.ZipFile(base_zip) as zb:
        members = {}
        for i in zb.infolist():
            name = i.filename.replace('\\', '/')
            if name.endswith('/'):
                need(i.file_size == 0, f'directory entry contains data: {name}')
                continue
            need(name not in members, f'duplicate normalized member: {name}')
            members[name] = i
        extra = sorted(set(members) - set(bfiles) - {'manifest.json'})
        need(not extra, f'base zip has files its manifest does not list: {extra[:5]}')
        zpath = out / f'enclave-host-{version}.zip'
        with zipfile.ZipFile(zpath, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zo:
            for p in sorted(set(bfiles) | set(overlay)):
                zi = zipfile.ZipInfo(p, date_time=STAMP); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = 0; zi.create_system = 0; zi.compress_level = 9
                h = hashlib.sha256(); n = 0
                if p in overlay:
                    src_open = lambda: open(overlay[p][1], 'rb')
                else:
                    need(p in members, f'base zip lacks {p}'); src_open = lambda: zb.open(members[p])
                with src_open() as fi, zo.open(zi, 'w', force_zip64=True) as fo:
                    for b in iter(lambda: fi.read(CHUNK), b''): h.update(b); n += len(b); fo.write(b)
                d = h.hexdigest()
                if p in overlay: need(d == overlay[p][0], f'overlay {p} changed while assembling')
                else: need(d == bfiles[p]['sha256'] and n == bfiles[p]['bytes'], f'base {p} is not its manifest sha/size')
                files[p] = {'path': p, 'sha256': d, 'bytes': n}
            man = {'product': m['product'], 'version': version, 'control': control_label or (str(m.get('control')) + '+live-overlay'), 'files': [files[p] for p in sorted(files)]}
            mbytes = ('﻿' + json.dumps(man, indent=1) + '\n').encode('utf-8')        # .47's manifest carries a UTF-8 BOM too
            zi = zipfile.ZipInfo('manifest.json', date_time=STAMP); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = 0; zi.create_system = 0; zi.compress_level = 9
            zo.writestr(zi, mbytes)
    (out / f'manifest-{version}.json').write_bytes(mbytes)
    shutil.copyfile(setup, out / f'EnclaveSetup-{version}.exe')
    sums = {n: sha_file(out / n) for n in (f'enclave-host-{version}.zip', f'EnclaveSetup-{version}.exe', f'manifest-{version}.json')}
    (out / 'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n, h in sums.items()))
    return {'version': version, 'files': len(files), 'overlaid': sorted(overlay), 'artifacts': {n: {'sha256': h, 'bytes': (out / n).stat().st_size} for n, h in sums.items()},
            'zlib': zlib.ZLIB_VERSION, 'python': sys.version.split()[0]}

def statement(out, version=VERSION, channel='stable'):
    """the UNSIGNED statement over the actual artifacts, built by the live verifier's own CLI (never signed here)"""
    need(sha_file(VERIFIER) == VERIFIER_SHA, 'verifier is not the live f690c29b')
    st = out / f'release-{version}.statement.json'
    r = subprocess.run(['node', str(VERIFIER), 'statement', '--channel', channel, '--version', version, '--zip', str(out / f'enclave-host-{version}.zip'),
                        '--setup', str(out / f'EnclaveSetup-{version}.exe'), '--manifest', str(out / f'manifest-{version}.json'), '--out', str(st)],
                       capture_output=True, text=True, timeout=600)
    need(r.returncode == 0, f'statement: {r.stderr.strip()}')
    return json.loads(st.read_text())

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument('--inputs', required=True); a.add_argument('--out', required=True); a.add_argument('--on-disk')
    o = a.parse_args(argv); I = pathlib.Path(o.inputs); out = pathlib.Path(o.out)
    for k in ('manifest', 'latest'): need(sha_file(BASE[k][0]) == BASE[k][1], f'{BASE[k][0]} is not {BASE[k][1][:8]}')
    lj = json.loads(BASE['latest'][0].read_text())
    need((lj['sha256'], lj['bytes'], lj['setupSha256'], lj['manifestSha256']) == (BASE['zip'][1], BASE['zip'][2], BASE['setup'][1], BASE['manifest'][1]), 'pins differ from the published latest.json')
    zp, sp = I / BASE['zip'][0], I / BASE['setup'][0]
    need(zp.is_file(), f'MISSING INPUT {zp} (ROOT-REQUEST.txt Q2)'); need(sp.is_file(), f'MISSING INPUT {sp} (ROOT-REQUEST.txt Q2)')
    need(zp.stat().st_size == BASE['zip'][2] and sha_file(zp) == BASE['zip'][1], 'base zip is not the published e010ea5b')
    need(sha_file(sp) == BASE['setup'][1], 'setup is not the published f9779425')
    inv = json.loads(INVENTORY.read_text())
    ov = load_overlay(inv); base_rows = {p: r['sha256'] for p, r in inv['rows'].items() if r['class'] == 'BASE'}
    prov = assemble(zp, BASE['manifest'][0], ov, base_rows, sp, out)
    prov['statement'] = statement(out); prov['signed'] = False
    prov['inputs'] = {'baseZip': BASE['zip'][1], 'baseSetup': BASE['setup'][1], 'baseManifest': BASE['manifest'][1], 'inventory': sha_file(INVENTORY)}
    (out / 'ASSEMBLY.json').write_text(json.dumps(prov, indent=1) + '\n')
    print(json.dumps({k: prov[k] for k in ('version', 'files', 'artifacts', 'signed')}, indent=1)); return 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
