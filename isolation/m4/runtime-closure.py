#!/usr/bin/env python3
"""Complete a trusted build library's dependencies without replacing runtime pins.

Check the resulting runtime in a filesystem containing ONLY its libraries, so
the developer machine cannot silently supply missing transitive dependencies.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess

def needed(path):
    text = subprocess.check_output(['readelf', '-d', str(path)], text=True)
    return re.findall(r'\(NEEDED\).*\[([^\]]+)\]', text)

def complete(runtime, library):
    pending = [library]
    visited = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        for name in needed(path):
            if '/' in name:
                raise RuntimeError('non-soname dependency: ' + name)
            target = runtime / name
            if not target.is_file():
                # This is a local, trusted compiler output, never a tenant ELF.
                source = Path(subprocess.check_output(
                    ['cc', '-print-file-name=' + name], text=True).strip())
                if not source.is_absolute() or not source.is_file():
                    raise RuntimeError('unresolved dependency: ' + name)
                shutil.copyfile(source.resolve(), target)
            pending.append(target)

def check(runtime):
    for path in runtime.rglob('*'):
        if not path.is_file():
            continue
        with path.open('rb') as f:
            if f.read(4) != b'\x7fELF':
                continue
        for name in needed(path):
            if not (runtime / name).is_file() and not (runtime / 'backends' / name).is_file():
                raise RuntimeError(str(path) + ': missing ' + name)
    env = {k: v for k, v in os.environ.items() if not k.startswith('LD_')}
    subprocess.run(['bwrap', '--unshare-all', '--ro-bind', str(runtime), '/rt',
        '--proc', '/proc', '--dev', '/dev', '/rt/ld-linux-x86-64.so.2',
        '--library-path', '/rt:/rt/backends', '--list', '/rt/wasmtime'],
        env=env, check=True)

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('runtime', type=Path)
    p.add_argument('--complete-library')
    a = p.parse_args()
    runtime = a.runtime.resolve()
    if a.complete_library:
        complete(runtime, runtime / a.complete_library)
    check(runtime)
