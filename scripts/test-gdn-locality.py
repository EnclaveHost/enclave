#!/usr/bin/env python3
"""Compare all recurrent outputs and rollback slots with both optimizations off/on."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=Path, required=True)
p.add_argument('--library-dir', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parents[1]
lib = a.library_dir.resolve()
env = {**os.environ, 'LD_LIBRARY_PATH': str(lib)}
with tempfile.TemporaryDirectory(prefix='gdn-locality-') as tmp:
    work = Path(tmp)
    exe = work / 'gdn-equiv'
    subprocess.run(shlex.split(os.environ.get('CXX', 'c++')) + [
        '-O2', '-std=c++17', '-DGGML_MAX_NAME=128',
        '-I' + str(a.source.resolve() / 'ggml/include'),
        str(repo / 'wasm/llamacpp-conv-inplace/gdn-equiv.cpp'),
        '-L' + str(lib), '-lggml-cpu', '-lggml-base', '-fopenmp',
        '-Wl,-rpath,' + str(lib), '-o', str(exe)], check=True)
    result = {}
    expected = None
    for label, row, snapshot in [('off', '0', '0'), ('row', '1', '0'),
                                 ('snapshot', '0', '1'), ('both', '1', '1')]:
        dump = work / 'state.bin'
        run = subprocess.run([str(exe), str(dump)], check=True, capture_output=True,
                             text=True, timeout=180, env={**env,
                             'ENCLAVE_GGML_GDN_ROW_LOCALITY': row,
                             'ENCLAVE_GGML_GDN_NTSNAP': snapshot})
        (a.output / (label + '.txt')).write_text(run.stdout + run.stderr)
        if 'cases=72 bytes=448983256' not in run.stdout:
            raise RuntimeError('Incomplete equivalence fixture: ' + label)
        with dump.open('rb') as f:
            h = hashlib.sha256()
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
            digest = h.hexdigest()
        if expected is None:
            expected = digest
        if digest != expected:
            raise RuntimeError('Recurrent output/state mismatch: ' + label)
        result[label] = {'sha256': digest, 'bytes': dump.stat().st_size, 'cases': 72}
    (a.output / 'equivalence.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS: all four configurations have identical outputs, state, snapshots and canaries.')
