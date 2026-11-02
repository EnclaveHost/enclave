#!/usr/bin/env python3
"""Assemble the Base coverage activation set for an RPC guest image and check it offline.

python3 -I acceptance.py OUT_DIR --verdict V --origin O --snapshot-manifest S \
    --installed-manifest M --chain-config C --reviewer R --gate-runner G --review-notes N [--blob-patch P]

OUT_DIR receives receipt.json, verdict.json, origin.json, snapshot-manifest.json (the
files rpc/snp/build_image.py installs under /etc/enclave-rpc/coverage) and
base-bootstrap.json (the chain.json baseBootstrap section pinning their bytes).
A verdict that patched blob slots (the gate's --blob-patch) needs that patch file: it is
required, must match the verdict's blobPatch.sha256, and is copied as blob-patch.json,
which build_image.py installs for the guest's beacon patch.
M and C are the image's /opt/enclave-rpc/manifest.json and /etc/enclave-rpc/chain.json.
The set is then validated by the guest's own coverage_activation (--chain-service, default rpc/guest/chain_service.py),
so a binding the guest would refuse is refused here, before an image is built.
"""
import argparse
import ast
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
CHAIN_SERVICE = HERE.parent/'guest'/'chain_service.py'


def guest_functions(path=CHAIN_SERVICE):
    """chain_service.py's definitions without its import-time reads of the installed guest."""
    tree = ast.parse(Path(path).read_text())
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef)):
            keep.append(node)
        elif isinstance(node, ast.Assign) and 'read_text' not in ast.unparse(node.value) \
                and 'os.environ' not in ast.unparse(node.value):
            keep.append(node)
    ns = {'__name__': 'chain_service_offline'}
    exec(compile(ast.Module(keep, []), str(path), 'exec'), ns)
    return ns


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    for k in ('verdict', 'origin', 'snapshot-manifest', 'installed-manifest', 'chain-config', 'reviewer', 'gate-runner',
              'review-notes'):
        ap.add_argument('--'+k, required=True)
    ap.add_argument('--blob-patch', help="the gate's --blob-patch file, when the verdict patched slots")
    ap.add_argument('--chain-service', default=str(CHAIN_SERVICE),
                    help="the image's own /opt/enclave-rpc/chain_service.py, so its rules are the ones checked")
    a = ap.parse_args(argv)
    g = guest_functions(a.chain_service)
    out = Path(a.out)
    out.mkdir(mode=0o755)
    for src, name in ((a.verdict, 'verdict.json'), (a.origin, 'origin.json'), (a.snapshot_manifest, 'snapshot-manifest.json')):
        shutil.copyfile(src, out/name)
    verdict = json.loads((out/'verdict.json').read_text())
    want_patch = (verdict.get('blobPatch') or {}).get('sha256')
    if bool(want_patch) != bool(a.blob_patch):
        raise SystemExit('the verdict %s a blob patch; --blob-patch %s' % (('records', 'is required') if want_patch
                                                                          else ('records no', 'must be omitted')))
    if a.blob_patch:
        if sha(a.blob_patch) != want_patch:
            raise SystemExit('--blob-patch is not the file the verdict was computed with')
        shutil.copyfile(a.blob_patch, out/'blob-patch.json')
    installed = json.loads(Path(a.installed_manifest).read_text())
    cfg = json.loads(Path(a.chain_config).read_text())
    prop = verdict.get('proposedBaseBootstrap') or {}
    receipt = {
        'format': g['RECEIPT_FORMAT'], 'decision': 'accepted',
        'review': {'reviewer': a.reviewer, 'gateRunner': a.gate_runner,
                   'reviewedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
                   'notes': a.review_notes},
        'verdictSha256': sha(out/'verdict.json'), 'originSha256': sha(out/'origin.json'),
        'snapshotManifestSha256': sha(out/'snapshot-manifest.json'),
        'snapshotManifestUrl': (installed.get('snapshotManifests') or {}).get('base'),
        'bootstrapManifestSha256': sha(a.installed_manifest),
        'chainConfigSha256': g['config_identity'](cfg),
        'kzgcheckSha256': g['KZGCHECK_SHA256'],
        'baseBinarySha256': (installed.get('binaries') or {}).get('base'),
        'baseBootstrap': {'l1Block': prop.get('l1Block'), 'blobSlot': prop.get('blobSlot')},
    }
    (out/'receipt.json').write_text(json.dumps(receipt, indent=1)+'\n')
    bootstrap = {'coverageVerified': True,
                 'coverageAcceptance': {'receiptSha256': sha(out/'receipt.json'), 'verdictSha256': receipt['verdictSha256'],
                                        'originSha256': receipt['originSha256'],
                                        'snapshotManifestSha256': receipt['snapshotManifestSha256']},
                 'l1Block': prop.get('l1Block'), 'blobSlot': prop.get('blobSlot')}
    (out/'base-bootstrap.json').write_text(json.dumps(bootstrap, indent=1)+'\n')
    # The guest's own check, against these bytes (owner = whoever runs this; root in the image).
    import os
    bound = g['coverage_activation'](dict(cfg, baseBootstrap=bootstrap), a.installed_manifest, receipt['baseBinarySha256'],
                                     directory=out, owner=os.getuid())
    print(json.dumps({'accepted': True, 'bound': bound}, indent=1))


if __name__ == '__main__':
    sys.exit(main())
