#!/usr/bin/env python3
"""Prepare/apply/restore the two native runner hooks; never controls a service."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_code_transaction', HERE / 'transaction.py')
tx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tx)
DATA = PureWindowsPath(r'C:\ProgramData\Enclave')
RUNNERS = ('run-node.cmd', 'run-shield.cmd')
BASE_CONFIGS = ('node-config.cmd', 'node-config.local.cmd', 'shield-config.cmd')
SHA = re.compile(r'^[0-9a-f]{64}$')


def release_directory(release):
    if not SHA.fullmatch(release.get('imageSha256', '')):
        raise ValueError('invalid release image identity')
    relative = 'native-desktop/releases/' + release['imageSha256']
    expected = DATA.joinpath(*relative.split('/'))
    if release.get('target') != str(expected):
        raise ValueError('release must use its dedicated permanent directory')
    return relative


def hook(release, newline=b'\r\n'):
    relative = release_directory(release)
    target = str(DATA.joinpath(*relative.split('/'), 'native-desktop-env.cmd'))
    return ('call "' + target + '"').encode('ascii') + newline + b'if errorlevel 1 exit /b 1' + newline


def add_hook(original, name, release):
    if name not in RUNNERS or b'\0' in original:
        raise ValueError('invalid runner')
    original.decode('ascii')
    if b'native-desktop-env.cmd' in original.lower():
        raise ValueError('native hook is already present')
    role = 'node' if name == 'run-node.cmd' else 'shield'
    call = ('call "' + str(DATA / (role + '-config.cmd')) + '"').encode('ascii')
    lines = original.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if line.rstrip(b'\r\n') == call]
    if len(matches) != 1:
        raise ValueError('runner must call its original base config exactly once')
    i = matches[0]
    line = lines[i]
    ending = b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else None
    if ending is None or sum(x.rstrip(b'\r\n') == b':loop' for x in lines) != 1:
        raise ValueError('unsupported runner layout')
    if not any(x.rstrip(b'\r\n') == b':loop' for x in lines[i+1:]):
        raise ValueError('base config must precede the service loop')
    return b''.join(lines[:i+1]) + hook(release, ending) + b''.join(lines[i+1:])


def validate_manifest(m):
    if m.get('schema') != 'native-runner-config/1' or m.get('added') != []:
        raise ValueError('unsupported runner manifest')
    if [x['path'] for x in m['modified']] != list(RUNNERS):
        raise ValueError('only the two service runners may change')
    relative = release_directory(m['release'])
    required = {x['path']: x for x in m['requiredUnchanged']}
    expected = set(BASE_CONFIGS) | {relative + '/' + n for n in ['desktop-config.json', 'desktop-release.json', 'native-desktop-env.cmd']}
    if set(required) != expected or len(required) != len(m['requiredUnchanged']):
        raise ValueError('unexpected required configuration paths')
    for item in required.values():
        if not SHA.fullmatch(item.get('sha256', '')) or type(item.get('bytes')) is not int or item['bytes'] <= 0:
            raise ValueError('invalid required configuration pin')
    for n in ['desktop-config.json', 'desktop-release.json']:
        pin = m['release']['configurationPins'][n]
        item = required[relative + '/' + n]
        if item['sha256'] != pin['sha256'] or item['bytes'] != pin['bytes']:
            raise ValueError('configuration pin differs from release')
    if required[relative + '/native-desktop-env.cmd']['sha256'] != m['release']['environmentSha256']:
        raise ValueError('environment pin differs from release')
    tx.entries(m)
    return m


def prepare(capture, config_pins, release, environment_bytes, output):
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')
    relative = release_directory(release)
    if tx.sha(environment_bytes) != release['environmentSha256']:
        raise ValueError('environment bytes differ from release')
    records = {r['name']: r for r in capture['runners']}
    if set(records) != set(RUNNERS) or len(capture['runners']) != 2:
        raise ValueError('exactly two captured runners required')
    originals, changed = {}, {}
    for name in RUNNERS:
        r = records[name]
        b = base64.b64decode(r['bytes'], validate=True)
        if tx.sha(b) != r['sha256']:
            raise ValueError('captured runner hash mismatch')
        originals[name] = b
        changed[name] = add_hook(b, name, release)
    required = list(config_pins['files'])
    for name, pin in release['configurationPins'].items():
        required.append(dict(path=relative + '/' + name, **pin))
    required.append(dict(path=relative + '/native-desktop-env.cmd', sha256=release['environmentSha256'], bytes=len(environment_bytes)))
    m = dict(schema='native-runner-config/1', release=release,
             modified=[dict(path=n, beforeSha256=tx.sha(originals[n]), afterSha256=tx.sha(changed[n]), afterBytes=len(changed[n])) for n in RUNNERS],
             added=[], requiredUnchanged=required, productionActivated=False)
    validate_manifest(m)
    output.mkdir()
    (output / 'payload').mkdir()
    for name, b in changed.items():
        (output / 'payload' / name).write_bytes(b)
    (output / 'manifest.json').write_text(json.dumps(m, indent=2) + '\n')
    return m


def validate_payload(payload, m):
    # Independently prove that the payload changes ONLY the two inserted lines.
    # Reconstruct the captured original and require its whole-file pin.
    validate_manifest(m)
    for e in m['modified']:
        data = tx.path_in(payload, e['path']).read_bytes()
        if tx.sha(data) != e['afterSha256'] or len(data) != e['afterBytes']:
            raise ValueError('runner payload pin differs')
        candidates = [h for h in [hook(m['release'], b'\r\n'), hook(m['release'], b'\n')] if data.count(h) == 1]
        if len(candidates) != 1:
            raise ValueError('runner must contain exactly one native hook')
        old = data.replace(candidates[0], b'', 1)
        if tx.sha(old) != e['beforeSha256'] or add_hook(old, e['path'], m['release']) != data:
            raise ValueError('runner payload changes more than the native hook')


def stopped(root):
    if os.name != 'nt' or root.resolve() != Path(str(DATA)).resolve():
        raise RuntimeError('runner apply/rollback requires the installed ProgramData root')
    control = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Enclave/control'
    tx.windows_stopped(control)


def apply(root, payload, manifest_bytes, journal, *, guard=stopped):
    m = validate_manifest(json.loads(manifest_bytes))
    validate_payload(payload, m)
    return tx.apply(root, payload, manifest_bytes, journal, guard=guard)


def rollback(root, journal, *, guard=stopped):
    validate_manifest(json.loads((journal / 'manifest.json').read_text()))
    return tx.rollback(root, journal, guard=guard)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'inspect', 'apply', 'rollback'])
    p.add_argument('--capture', type=Path); p.add_argument('--config-pins', type=Path)
    p.add_argument('--release', type=Path); p.add_argument('--environment', type=Path); p.add_argument('--output', type=Path)
    p.add_argument('--installed', type=Path); p.add_argument('--manifest', type=Path)
    p.add_argument('--payload', type=Path); p.add_argument('--journal', type=Path)
    a = p.parse_args()
    if a.action == 'prepare':
        if not all([a.capture, a.config_pins, a.release, a.environment, a.output]): p.error('prepare requires capture, config-pins, release, environment and output')
        result = prepare(json.loads(a.capture.read_text()), json.loads(a.config_pins.read_text()), json.loads(a.release.read_text()), a.environment.read_bytes(), a.output)
    else:
        if not a.installed: p.error('--installed is required')
        if a.action == 'rollback':
            if not a.journal: p.error('--journal is required')
            result = rollback(a.installed, a.journal)
        else:
            if not a.manifest: p.error('--manifest is required')
            raw = a.manifest.read_bytes(); m = validate_manifest(json.loads(raw))
            if a.action == 'inspect': result = tx.inspect(a.installed, m)
            else:
                if not all([a.payload, a.journal]): p.error('--payload and --journal are required')
                result = apply(a.installed, a.payload, raw, a.journal)
    print(json.dumps(result))

if __name__ == '__main__':
    main()
