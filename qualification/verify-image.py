#!/usr/bin/env python3
"""Offline, streaming artifact validation. Does not boot or extract the image."""
import gzip, hashlib, importlib.util, json, stat, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('overlay', ROOT/'metal/overlay-control-image.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)
pins = json.loads((ROOT/'qualification/input-pins.json').read_text())

def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def inventory(path):
    result = {}
    with gzip.open(path, 'rb') as f:
        for key, name, fields, header in overlay.entries(f):
            h = hashlib.sha256()
            overlay.body(f, fields[6], digest=h)
            value = {'sha256': h.hexdigest(), 'metadata': fields[1:11]}
            if key in result and result[key] != value:
                raise ValueError('conflicting image entry: '+key)
            result[key] = value
    return result

def verify_base(base):
    for name, expected in pins['files'].items():
        assert (base/name).is_file() and not (base/name).is_symlink(), name
        assert sha(base/name) == expected['sha256'], 'input hash mismatch: '+name
        assert (base/name).stat().st_size == expected['bytes'], name

def verify_candidate(base, out, commit):
    verify_base(base)
    assert sha(base/'vmlinuz') == sha(out/'vmlinuz')
    assert sha(base/'cmdline') == sha(out/'cmdline')
    before, after = inventory(base/'initramfs.cpio.gz'), inventory(out/'initramfs.cpio.gz')
    changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    expected = ['app/network/lease-expiry-reconcile.mjs', 'app/supervisor.js', 'opt/metal/manifest.json']
    assert changed == expected, 'unexpected image changes: '+repr(changed)
    sourcepins = json.loads((ROOT/'qualification/source-pins.json').read_text())
    for path, pin in [('app/supervisor.js','patchedSupervisorSha256'),
                      ('app/network/lease-expiry-reconcile.mjs','helperSha256')]:
        assert after[path]['sha256'] == sourcepins[pin], path
        assert stat.S_ISREG(after[path]['metadata'][0]), path
    manifest = json.loads((out/'manifest.json').read_text())
    assert manifest['controlOverlay']['commit'] == commit
    assert manifest['controlOverlay']['baseInitramfsSha256'] == pins['files']['initramfs.cpio.gz']['sha256']
    assert manifest['initramfs']['sha256'] == sha(out/'initramfs.cpio.gz')
    return {'status':'verified-offline-not-booted', 'sourceCommit':commit,
            'changedImagePaths':changed,
            'files':{n:{'sha256':sha(out/n),'bytes':(out/n).stat().st_size}
                     for n in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json']}}

if __name__ == '__main__':
    if len(sys.argv) == 2:
        verify_base(Path(sys.argv[1]))
    elif len(sys.argv) == 5:
        result = verify_candidate(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
        Path(sys.argv[4]).write_text(json.dumps(result, indent=2)+'\n')
    else:
        raise SystemExit('verify-image.py BASE [OUT COMMIT REPORT]')
