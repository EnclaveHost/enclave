#!/usr/bin/env python3
"""Refresh the tracked GGML backend in an Enclave-patched Wasmtime source tree.

Use the same Wasmtime revision and other patches as the existing Shield build.
This deliberately replaces the two complete added source files from the current
repository patch, rather than retaining an older benchmark backend silently.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

p = argparse.ArgumentParser(description=__doc__)
for name in ['source', 'runtime', 'out']:
    p.add_argument('--' + name, type=Path, required=True)
a = p.parse_args()
r = Path(__file__).resolve().parents[2]
s, rt, out = a.source.resolve(), a.runtime.resolve(), a.out.resolve()
if out.exists():
    p.error('output already exists')
out.mkdir()
patch = r / 'wasm/wasmtime-nn-ggml.patch'
parts = patch.read_text().split('diff --git ')
sources = {}
http_patch = r / 'wasm/wasmtime-http-pool.patch'
# Idempotent, but never silently accept a different or partly patched client.
check = subprocess.run(['git', 'apply', '--reverse', '--check', str(http_patch)],
                       cwd=s, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if check.returncode != 0:
    subprocess.run(['git', 'apply', '--check', str(http_patch)], cwd=s, check=True)
    subprocess.run(['git', 'apply', str(http_patch)], cwd=s, check=True)
for rel in ['crates/wasi-http/src/default_send_request.rs',
            'crates/wasi-http/src/outgoing_pool.rs']:
    sources[rel] = hashlib.sha256((s / rel).read_bytes()).hexdigest()
for name in ['ggml.rs', 'prefix_claims.rs']:
    rel = 'crates/wasi-nn/src/backend/' + name
    part = next(x for x in parts if x.startswith('a/' + rel + ' b/' + rel + '\n'))
    assert '--- /dev/null' in part, 'expected a complete added source file'
    text = '\n'.join(line[1:] for line in part.splitlines()
                     if line.startswith('+') and not line.startswith('+++')) + '\n'
    target = s / rel
    if target.exists():
        shutil.copy2(target, out / (name + '.before'))
    target.write_text(text)
    sources[rel] = hashlib.sha256(text.encode()).hexdigest()
mod = s / 'crates/wasi-nn/src/backend/mod.rs'
text = mod.read_text()
if 'mod prefix_claims;' not in text:
    assert text.count('pub mod ggml;') == 1
    mod.write_text(text.replace('pub mod ggml;',
        'pub mod ggml;\n#[cfg(feature = "ggml")]\nmod prefix_claims;'))
# Production closures keep versioned .so names; the linker also needs aliases.
libs = out / 'link-libs'
libs.mkdir()
for lib in rt.glob('*.so*'):
    (libs / lib.name).symlink_to(lib)
for name in ['libllama', 'libggml', 'libggml-base', 'libmtmd']:
    if not (libs / (name + '.so')).exists():
        (libs / (name + '.so')).symlink_to(rt / (name + '.so.0'))
features = ('run,serve,compile,wat,parallel-compilation,cache,cranelift,'
            'component-model,component-model-async,threads,wasi-http,wasi-nn,'
            'wasmtime-wasi-nn/ggml,pooling-allocator')
cmd = ['cargo', 'build', '--release', '--locked', '-j', '4',
       '--no-default-features', '--features', features]
with (out / 'build.txt').open('w') as log:
    subprocess.run(cmd, cwd=s, env={**os.environ, 'ELL_LIB_LOCATION': str(libs)},
                   stdout=log, stderr=subprocess.STDOUT, check=True)
binary = out / 'wasmtime'
shutil.copy2(s / 'target/release/wasmtime', binary)
(out / 'provenance.json').write_text(json.dumps({
    'source': str(s), 'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
    'httpPoolPatchSha256': hashlib.sha256(http_patch.read_bytes()).hexdigest(),
    'sources': sources, 'command': cmd,
    'wasmtimeSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
}, indent=2) + '\n')
print(binary)
