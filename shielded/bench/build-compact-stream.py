#!/usr/bin/env python3
"""Build paired resident/streamed compact math benchmark; no deployment."""
import argparse
from pathlib import Path
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('output', type=Path)
p.add_argument('--onednn-root', type=Path, required=True)
p.add_argument('--ggml-src', type=Path, default=Path.home() / 'Projects/llama.cpp')
p.add_argument('--ggml-lib', type=Path, default=Path.home() / 'Projects/llamacpp-lib')
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parents[2]
src = root / 'wasm/ggml-shielded'
flags = ['-O2', '-ffp-contract=off', '-ffunction-sections', '-fdata-sections']
simd = ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni']
objects = []
for name in ['shielded-simd', 'shielded-field', 'tweetnacl']:
    obj = a.output / (name + '.o')
    objects.append(str(obj))
    subprocess.run(['cc', *flags, *simd, '-DSH_SIMD_AVX512', '-c', str(src / (name + '.c')), '-o', str(obj)], check=True)
compact = a.output / 'compact.o'
objects.append(str(compact))
subprocess.run(['c++', *flags, '-O3', *simd, '-std=c++17', '-I' + str(a.onednn_root / 'usr/include'),
                '-c', str(src / 'shielded-compact.cpp'), '-o', str(compact)], check=True)
subprocess.run(['c++', *flags, *simd, '-std=c++17', '-I' + str(a.ggml_src / 'ggml/include'),
                str(root / 'shielded/bench/compact-stream.cpp'), *objects,
                '-L' + str(a.onednn_root / 'usr/lib'), '-ldnnl', '-lgomp',
                '-Wl,-rpath,' + str(a.onednn_root / 'usr/lib'), '-L' + str(a.ggml_lib),
                '-lggml', '-lggml-base', '-lcrypto', '-pthread', '-lm', '-Wl,--gc-sections',
                '-Wl,-rpath,' + str(a.ggml_lib), '-o', str(a.output / 'bench')], check=True)
print(a.output / 'bench')
