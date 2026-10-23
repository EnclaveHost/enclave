#!/usr/bin/env python3
"""input-closure.py REPO COMMIT OUT.json   (read-only: Git objects + the read-only production base image)

The image inputs a build of COMMIT would install, computed by the COMMIT's own overlay tool (metal/overlay-control-image.py):
relay mode (app_files + guest_files: the mode of the running ed918e4b) and --control direct (plus platform_api_files and
mcp_files), each against fec43a6a's 55 relay inputs (linux-runtime-release/public/INPUT-MANIFEST.json, image 3043f6ff). The
supervisor closure's npm packages must be exported by the production base (dist-sdshield-2857356cd), and no installed input may
carry a DigitalOcean /platform-policy mirror literal. Nothing is built or measured here: the final image needs B's runtime too."""
import gzip, hashlib, importlib.util, json, subprocess, sys, tempfile
from pathlib import Path
BASE = Path('/home/steven/enclave-prod/dist-sdshield-2857356cd')
FEC = Path('/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-runtime-release/public/INPUT-MANIFEST.json')
DO = [b'134.199.235.187', b'134.209.248.172', b'165.245.191.129', b'146.190.246.39']
sha = lambda b: hashlib.sha256(b).hexdigest()

def main(repo, commit, out):
    repo = Path(repo).resolve()
    commit = subprocess.check_output(['git', 'rev-parse', commit + '^{commit}'], cwd=repo, text=True).strip()
    tool = subprocess.check_output(['git', 'show', f'{commit}:metal/overlay-control-image.py'], cwd=repo)
    with tempfile.TemporaryDirectory() as t:
        tp = Path(t) / 'overlay.py'; tp.write_bytes(tool)
        spec = importlib.util.spec_from_file_location('o', tp); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    app, packages = o.app_files(commit, repo)
    relay = {**{'app/' + p: p for p in app}, **{'opt/metal/' + p: 'metal/guest/' + p for p in o.guest_files(commit, repo)}}
    direct = dict(relay); problems = {}
    try:
        pa, pa_rec = o.platform_api_files(commit, repo)
        for k, v in pa.items(): o.place(direct, k, v, 'platform API file')
        mcp, mcp_rec = o.mcp_files(commit, repo, direct); direct.update(mcp)
    except Exception as e:
        problems['direct'] = str(e)[:400]; pa_rec = mcp_rec = None
    blobs = {k: o.committed(commit, repo, v) for k, v in direct.items()}
    rin = {k: {'source': relay[k], 'sha256': sha(blobs[k])} for k in sorted(relay)}
    din = {k: {'source': direct[k], 'sha256': sha(blobs[k])} for k in sorted(direct)}
    wanted = {'app/node_modules/' + n + '/package.json' for n in packages}; pk = {}
    with gzip.open(BASE / 'initramfs.cpio.gz', 'rb') as f:
        for key, name, fields, header in o.entries(f):
            left, buf = fields[6], b''
            while left:
                c = o.exact(f, min(left, 1 << 20)); left -= len(c)
                if key in wanted: buf += c
            o.exact(f, -fields[6] % 4)
            if key in wanted: pk[key] = buf
    try: pkg = o.check_packages(packages, lambda n: pk.get('app/node_modules/' + n + '/package.json')); pkg_ok = True
    except ValueError as e: pkg, pkg_ok = str(e), False
    fec = json.loads(FEC.read_text())['inputs']
    delta = {'changed': {k: {'fec': fec[k]['sha256'], 'now': rin[k]['sha256'], 'source': rin[k]['source']} for k in rin if k in fec and fec[k]['sha256'] != rin[k]['sha256']},
             'added': {k: rin[k] for k in rin if k not in fec}, 'removed': sorted(set(fec) - set(rin))}
    do_hits = sorted(k for k, b in blobs.items() if any(d in b for d in DO))
    res = {'commit': commit, 'overlayTool': sha(tool), 'relay': {'count': len(rin), 'inputs': rin}, 'direct': {'count': len(din), 'inputs': din,
           'platformApiBundle': pa_rec, 'mcpBundle': mcp_rec}, 'problems': problems, 'npmPackagesFromBase': pkg, 'npmPackagesOk': pkg_ok,
           'vsFec43a6aRelay': delta, 'doMirrorLiterals': do_hits}
    json.dump(res, open(out, 'w'), indent=1, sort_keys=True)
    print(json.dumps({'commit': commit, 'relay': len(rin), 'direct': len(din), 'problems': problems, 'npmPackagesOk': pkg_ok, 'npm': pkg,
                      'changed': {k: f"{v['fec'][:8]} -> {v['now'][:8]}" for k, v in delta['changed'].items()},
                      'added': list(delta['added']), 'removed': delta['removed'], 'doMirrorLiterals': do_hits}, indent=1))
    sys.exit(0 if pkg_ok and not do_hits else 6)

if __name__ == '__main__': main(*sys.argv[1:])
