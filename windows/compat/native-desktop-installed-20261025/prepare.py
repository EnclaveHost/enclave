#!/usr/bin/env python3
"""Prepare a pinned offline node overlay; never activate or restart anything."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, subprocess, tempfile, os

def digest(b):
    return hashlib.sha256(b).hexdigest()

def checked_path(root, name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or any(x in ('', '.', '..') for x in p.parts) or str(p) != name:
        raise ValueError('invalid manifest path')
    target = root / name
    target.resolve().relative_to(root.resolve())
    return target

def prepare(installed, source, output):
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / 'manifest.json').read_text())
    patch = (here / 'node.patch').read_bytes()
    if digest(patch) != manifest['patchSha256']:
        raise ValueError('patch pin mismatch')
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')
    originals, additions = {}, {}
    for item in manifest['modified']:
        p = checked_path(installed, item['path'])
        if p.is_symlink() or not p.is_file():
            raise ValueError('installed input must be a regular file: ' + item['path'])
        b = p.read_bytes()
        if digest(b) != item['beforeSha256']:
            raise ValueError('installed source pin mismatch: ' + item['path'])
        originals[item['path']] = b
    for item in manifest['added']:
        target = checked_path(installed, item['path'])
        if target.exists() or target.is_symlink():
            raise ValueError('new module already exists: ' + item['path'])
        b = checked_path(source, item['path']).read_bytes()
        if len(b) != item['bytes'] or digest(b) != item['sha256']:
            raise ValueError('new module pin mismatch: ' + item['path'])
        additions[item['path']] = b
    if len(originals) != len(manifest['modified']) or len(additions) != len(manifest['added']) or originals.keys() & additions.keys():
        raise ValueError('duplicate overlay path')
    # All input pins are verified before creating an output. Patches and syntax
    # checks run in a temporary directory, with no contact with installed code.
    with tempfile.TemporaryDirectory(prefix='.native-node-overlay-', dir=output.parent) as temp:
        stage = Path(temp) / 'control'
        stage.mkdir()
        for name, b in originals.items():
            p = checked_path(stage, name)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b)
        patch_path = Path(temp) / 'node.patch'
        patch_path.write_bytes(patch)
        subprocess.run(['git', 'apply', '--check', str(patch_path)], cwd=stage, check=True)
        subprocess.run(['git', 'apply', str(patch_path)], cwd=stage, check=True)
        for item in manifest['modified']:
            b = checked_path(stage, item['path']).read_bytes()
            if len(b) != item['afterBytes'] or digest(b) != item['afterSha256']:
                raise ValueError('patched output pin mismatch: ' + item['path'])
        for name, b in additions.items():
            p = checked_path(stage, name)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b)
        for name in sorted(originals.keys() | additions.keys()):
            subprocess.run(['node', '--check', str(checked_path(stage, name))], check=True, capture_output=True)
        actual = {str(p.relative_to(stage)) for p in stage.rglob('*') if p.is_file()}
        if actual != originals.keys() | additions.keys():
            raise ValueError('unexpected output path')
        # Reserve the destination without replacing another preparation.
        output.mkdir()
        os.rename(stage, output / 'control')
        (output / 'prepared.json').write_text(json.dumps({
            'schema': manifest['schema'], 'modified': manifest['modified'],
            'added': manifest['added'], 'productionActivated': False,
            'scope': manifest['scope'],
        }, indent=2) + '\n')
    return {'modified': len(originals), 'added': len(additions), 'output': str(output), 'productionActivated': False}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installed', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.installed.resolve(), args.source.resolve(), args.output.absolute())))
