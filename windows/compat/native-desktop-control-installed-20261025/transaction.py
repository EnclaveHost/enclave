#!/usr/bin/env python3
"""Pinned control-code transaction. Does not stop/start tasks or mutate VM/config state."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(name):
    # Use the same strict portable namespace on Windows and on the offline test host.
    if not isinstance(name, str):
        raise ValueError('invalid relative path')
    p = PurePosixPath(name)
    if (not name or str(p) != name or p.is_absolute()
            or any(x in ('', '.', '..') for x in p.parts)
            or any(c in name for c in '\\:\0')):
        raise ValueError('invalid relative path')
    return p


def path_in(root, name):
    p = relative_path(name)
    root = Path(root).absolute()
    target = root.joinpath(*p.parts)
    # Reject every linked ancestor, including Windows junctions, rather than only the leaf.
    for item in [root, *target.parents, target]:
        if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
            raise ValueError('linked path: ' + name)
    target.resolve().relative_to(root.resolve())
    return target


def read_hash(p):
    if p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()):
        raise ValueError('linked file')
    if not p.exists():
        return None
    if not p.is_file():
        raise ValueError('not a regular file')
    return sha(p.read_bytes())


def entries(manifest):
    result = [dict(path=x['path'], before=x['beforeSha256'], after=x['afterSha256'],
                   size=x['afterBytes']) for x in manifest['modified']]
    result += [dict(path=x['path'], before=None, after=x['sha256'], size=x['bytes'])
               for x in manifest['added']]
    seen = set()
    for item in [*result, *manifest['requiredUnchanged']]:
        name = item['path']
        relative_path(name)
        # NTFS is case-insensitive. Manifest aliases must not address the same file.
        if name.casefold() in seen:
            raise ValueError('duplicate path')
        seen.add(name.casefold())
    for e in result:
        if (e['before'] == e['after'] or not isinstance(e['size'], int) or e['size'] < 0
                or any(h is not None and (len(h) != 64 or any(c not in '0123456789abcdef' for c in h))
                       for h in [e['before'], e['after']])):
            raise ValueError('invalid file pin')
    return result


def unchanged(root, manifest):
    for e in manifest['requiredUnchanged']:
        p = path_in(root, e['path'])
        if read_hash(p) != e['sha256'] or p.stat().st_size != e['bytes']:
            raise ValueError('required source drift: ' + e['path'])


def inspect(root, manifest):
    unchanged(root, manifest)
    result = []
    for e in entries(manifest):
        actual = read_hash(path_in(root, e['path']))
        state = 'before' if actual == e['before'] else 'after' if actual == e['after'] else 'drift'
        result.append(dict(path=e['path'], state=state, sha256=actual))
    return result


def atomic_write(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.native-code-', dir=p.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        if p.exists():
            os.chmod(temporary, p.stat().st_mode & 0o777)
        else:
            os.chmod(temporary, 0o644)
        os.replace(temporary, p)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_state(journal, state):
    atomic_write(journal / 'state.json', (json.dumps(state, indent=2) + '\n').encode())


def windows_stopped(root):
    """CLI always uses the actual installed root and authoritative task/process readback."""
    expected = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Enclave/control'
    if os.name != 'nt' or root.resolve() != expected.resolve():
        raise RuntimeError('live apply/rollback requires the installed Windows control root')
    script = r'''$ErrorActionPreference='Stop'
$tasks=@('Node','Shield','Update')|ForEach-Object{Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $_}
if(@($tasks|Where-Object{$_.State -eq 'Running' -or $_.Settings.Enabled}).Count){throw 'Node, Shield and Update tasks must be disabled and stopped'}
$root=Join-Path $env:ProgramFiles 'Enclave\control'
$targets=@((Join-Path $root 'windows\node\agent.mjs'),(Join-Path $root 'windows\vbslike\manager\main.mjs'),(Join-Path $env:ProgramFiles 'Enclave\update-host.ps1'))
foreach($p in Get-CimInstance Win32_Process){foreach($s in $targets){if($p.CommandLine -and $p.CommandLine.IndexOf($s,[StringComparison]::OrdinalIgnoreCase)-ge 0){throw 'Installed node or manager process still exists'}}}
'quiescent'
'''
    r = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                       capture_output=True, text=True, timeout=20)
    if r.returncode or r.stdout.strip() != 'quiescent':
        # Never print captured command lines or configuration.
        raise RuntimeError('node/manager quiescence check failed; no task was stopped by this tool')


def apply(root, payload, manifest_bytes, journal, *, guard=windows_stopped, write=atomic_write):
    manifest = json.loads(manifest_bytes)
    files = entries(manifest)
    if journal.exists() or journal.is_symlink():
        raise ValueError('journal already exists; inspect or roll back that transaction')
    before = inspect(root, manifest)
    if any(x['state'] != 'before' for x in before):
        raise ValueError('installed baseline differs')
    content = {}
    for e in files:
        b = path_in(payload, e['path']).read_bytes()
        if sha(b) != e['after'] or len(b) != e['size']:
            raise ValueError('payload pin mismatch: ' + e['path'])
        content[e['path']] = b
    guard(root)
    journal.mkdir(mode=0o700, parents=False)
    # Before the first installed write, persist the exact manifest and all old files.
    atomic_write(journal / 'manifest.json', manifest_bytes)
    for e in files:
        if e['before'] is not None:
            b = path_in(root, e['path']).read_bytes()
            if sha(b) != e['before']:
                raise ValueError('source changed while backing up: ' + e['path'])
            atomic_write(path_in(journal / 'before', e['path']), b)
    state = dict(schema='native-control-transaction/1', phase='prepared',
                 manifestSha256=sha(manifest_bytes), completed=[], productionServicesTouched=False)
    save_state(journal, state)
    try:
        for e in files:
            guard(root)
            unchanged(root, manifest)
            target = path_in(root, e['path'])
            if read_hash(target) != e['before']:
                raise ValueError('source changed during apply: ' + e['path'])
            write(target, content[e['path']])
            if read_hash(target) != e['after']:
                raise ValueError('write readback mismatch: ' + e['path'])
            state['completed'].append(e['path'])
            state['phase'] = 'applying'
            save_state(journal, state)
        if any(x['state'] != 'after' for x in inspect(root, manifest)):
            raise ValueError('final overlay readback differs')
        state['phase'] = 'applied'
        save_state(journal, state)
        return state
    except Exception:
        # Recovery classifies all paths by content, not by the last journal entry:
        # a process can die after rename but before persisting its completed list.
        rollback(root, journal, guard=guard)
        raise


def rollback(root, journal, *, guard=windows_stopped):
    raw = (journal / 'manifest.json').read_bytes()
    state = json.loads((journal / 'state.json').read_text())
    if sha(raw) != state['manifestSha256']:
        raise ValueError('journal manifest drift')
    manifest = json.loads(raw)
    files = entries(manifest)
    observed = inspect(root, manifest)
    if any(x['state'] == 'drift' for x in observed):
        raise ValueError('rollback refuses unrelated installed changes')
    originals = {}
    for e in files:
        if e['before'] is not None:
            b = path_in(journal / 'before', e['path']).read_bytes()
            if sha(b) != e['before']:
                raise ValueError('backup pin mismatch: ' + e['path'])
            originals[e['path']] = b
    guard(root)
    for e in reversed(files):
        guard(root)
        target = path_in(root, e['path'])
        actual = read_hash(target)
        if actual == e['before']:
            continue
        if actual != e['after']:
            raise ValueError('file changed during rollback: ' + e['path'])
        if e['before'] is None:
            target.unlink()
        else:
            atomic_write(target, originals[e['path']])
    if any(x['state'] != 'before' for x in inspect(root, manifest)):
        raise ValueError('rollback readback differs')
    state['phase'] = 'rolled-back'
    save_state(journal, state)
    return state


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['inspect', 'apply', 'rollback'])
    p.add_argument('--installed', type=Path, required=True)
    p.add_argument('--manifest', type=Path)
    p.add_argument('--payload', type=Path)
    p.add_argument('--journal', type=Path)
    a = p.parse_args()
    if a.action == 'rollback':
        if not a.journal: p.error('--journal is required')
        result = rollback(a.installed, a.journal)
    elif a.action == 'apply':
        if not all([a.manifest, a.payload, a.journal]): p.error('--manifest, --payload and --journal are required')
        result = apply(a.installed, a.payload, a.manifest.read_bytes(), a.journal)
    else:
        if not a.manifest: p.error('--manifest is required')
        result = inspect(a.installed, json.loads(a.manifest.read_text()))
    print(json.dumps(result))

if __name__ == '__main__':
    main()
