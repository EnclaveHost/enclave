#!/usr/bin/env python3
"""release-gate.py - ROOT's offline gate for ONE staged signed Windows release, before anything is published or a policy is
installed. Local only: reads the staged channel directory; never builds, signs, publishes, installs or contacts a host.

  release-gate.py --channel-dir D --policy P --on-disk LIVE.json [--installed-manifest M] [--required R]
D: latest.signed.json, enclave-host-<v>.zip, EnclaveSetup-<v>.exe, manifest-<v>.json (as publish-windows-host.sh stages them)
P: the release-policy.json the host will pin (make-policy.py); LIVE: root's FRESH read {release path: sha256} of minipc

PASS (exit 0) requires ALL of:
  G1 the policy parses under the LIVE verifier f690c29b and pins no workspace TEST key;
  G2 the envelope verifies under that policy with the host's own rule (verifyEnvelope + threshold);
  G3 every artifact in D has the statement's exact name, size and sha256; the manifest's version is the statement's;
  G4 the version is newer than the installed 2026.10.12.47 (manifest 5b966e81), so the updater would take it;
  G5 the zip carries EXACTLY: update-host.ps1 36f9e0d6 (installed, rollback-guarded), install-host.ps1 1d1580c8 (r5,
     role-preserving, native-proven) and control/windows/node/release-channel.mjs f690c29b (the verifier), and the
     manifest lists the same hashes;
  G6 check-release.py e4487bd8 (installed manifest, this manifest, required-release-files.v2, LIVE overlay) exits 0.
It NEVER reports provider independence: mirrors are classified as written; none known today is independent.
Exit: 0 pass; 1 a gate failed; 2 usage/refused input.
"""
import argparse, hashlib, io, json, pathlib, subprocess, sys, zipfile
from channel_common import W, classify_mirror, node_policy, node_verify, sha, test_key_specs

INSTALLED_MANIFEST = W / 'g4-release-train-20261021/evidence/manifest-2026.10.12.47.json'
INSTALLED_SHA = '5b966e81da14d013dc8b940bbe0efa9d4b6c79cbcc24693013c91e491d6e6c26'
INSTALLED_VERSION = '2026.10.12.47'
CHECK_RELEASE = W / 'g4-release-train-20261021/check-release.py'
CHECK_RELEASE_SHA = 'e4487bd8af24600bd15f735dfe8fcaa4d48c5336774db84e8b3520780824bbcf'
REQUIRED = pathlib.Path(__file__).resolve().parent / 'required-release-files.v2.flat.json'
ZIP_PINS = {'update-host.ps1': '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112',
            'install-host.ps1': '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721',
            'control/windows/node/release-channel.mjs': 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942'}

def vgt(a, b):   # .NET [version] ordering, as update-host's Ver() compares
    a = [int(x) for x in a.split('.')]; b = [int(x) for x in b.split('.')]; n = max(len(a), len(b))
    return a + [-1] * (n - len(a)) > b + [-1] * (n - len(b))

def main(argv):
    ap = argparse.ArgumentParser(); ap.add_argument('--channel-dir', required=True); ap.add_argument('--policy', required=True)
    ap.add_argument('--on-disk', required=True); ap.add_argument('--installed-manifest', default=str(INSTALLED_MANIFEST)); ap.add_argument('--required', default=str(REQUIRED))
    o = ap.parse_args(argv); D = pathlib.Path(o.channel_dir); g = {}; out = {'gates': g}
    if sha(o.installed_manifest) != INSTALLED_SHA: print(json.dumps({'refused': f'installed manifest is not {INSTALLED_SHA[:8]}'})); return 2
    if sha(CHECK_RELEASE) != CHECK_RELEASE_SHA: print(json.dumps({'refused': 'check-release.py is not e4487bd8'})); return 2
    # G1
    try:
        pol = node_policy(o.policy); tk = [k for k in pol['keys'] if k in test_key_specs()]
        g['G1 policy'] = {'ok': not tk, 'channel': pol['channel'], 'keyIds': pol['keyIds'], 'threshold': pol['threshold'], **({'testKeys': len(tk)} if tk else {})}
        out['mirrorProviders'] = {m: classify_mirror(m) for m in pol['mirrors']}
    except ValueError as e: g['G1 policy'] = {'ok': False, 'error': str(e)}; pol = None
    # G2
    st = None
    if pol:
        try:
            v = node_verify(o.policy, D / 'latest.signed.json'); st = v['statement']
            g['G2 signature'] = {'ok': True, 'signers': v['signers'], 'threshold': v['threshold'], 'statementSha256': v['statementSha256'], 'version': st['version']}
        except (ValueError, FileNotFoundError) as e: g['G2 signature'] = {'ok': False, 'error': str(e)}
    # G3
    man = None
    if st:
        bad = []
        for n, h, b in (('file', 'sha256', 'bytes'), ('setup', 'setupSha256', 'setupBytes'), ('manifest', 'manifestSha256', 'manifestBytes')):
            f = D / st[n]
            if not f.is_file(): bad.append(f'{st[n]} missing'); continue
            if f.stat().st_size != st[b] or sha(f) != st[h]: bad.append(f'{st[n]} is not the signed size/sha256')
        if not bad:
            man = json.loads((D / st['manifest']).read_text(encoding='utf-8-sig'))
            if str(man.get('version')) != st['version']: bad.append('manifest version is not the statement version')
        g['G3 artifacts'] = {'ok': not bad, **({'problems': bad} if bad else {})}
    # G4
    if st: g['G4 newer'] = {'ok': vgt(st['version'], INSTALLED_VERSION), 'version': st['version'], 'installed': INSTALLED_VERSION}
    # G5
    if st and g['G3 artifacts']['ok']:
        z, mf, bad = {}, {e['path']: e['sha256'] for e in man.get('files', [])}, []
        with zipfile.ZipFile(D / st['file']) as zf:
            names = {n.replace('\\', '/'): n for n in zf.namelist()}
            for p, h in ZIP_PINS.items():
                got = hashlib.sha256(zf.read(names[p])).hexdigest() if p in names else 'absent'; z[p] = got
                if got != h: bad.append(f'zip {p} is {got[:8]}, not {h[:8]}')
                if p in mf and mf[p] != h: bad.append(f'manifest lists {p} as {mf[p][:8]}, not {h[:8]}')
        g['G5 chain'] = {'ok': not bad, 'zip': {k: v[:8] for k, v in z.items()}, **({'problems': bad} if bad else {})}
    # G6
    if st and g['G3 artifacts']['ok']:
        p = subprocess.run([sys.executable, '-B', str(CHECK_RELEASE), '--installed', o.installed_manifest, '--new', str(D / st['manifest']),
                            '--required', o.required, '--on-disk', o.on_disk], capture_output=True, text=True, timeout=600)
        try: cr = json.loads(p.stdout)
        except Exception: cr = {'stdout': p.stdout[-800:], 'stderr': p.stderr[-400:]}
        g['G6 required files'] = {'ok': p.returncode == 0, 'rc': p.returncode, 'result': cr}
    want = ['G1 policy', 'G2 signature', 'G3 artifacts', 'G4 newer', 'G5 chain', 'G6 required files']
    out['pass'] = all(g.get(k, {}).get('ok') for k in want); out['missing'] = [k for k in want if k not in g]
    out['providerIndependence'] = False
    out['legacyPointer'] = (D / 'latest.json').exists()
    out['notes'] = ['integrity is the owner signature; availability still depends on the listed mirrors',
                    'a latest.json in D is the UNSIGNED legacy pointer for hosts without a policy (transition only)']
    print(json.dumps(out, indent=1)); return 0 if out['pass'] else 1

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
