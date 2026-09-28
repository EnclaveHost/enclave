#!/usr/bin/env python3
"""Qualify grouped F16 attention on a hybrid GGUF with shared, recycled KV.

The fixture keeps eight resident sessions, branches them into sixteen, rolls
back speculative tokens and recycles slots. Every logit must be bit-identical
with grouping disabled/enabled. --runtime must contain the candidate CPU DSO.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess

p = argparse.ArgumentParser(description=__doc__)
for name in ('runtime', 'model', 'out'):
    p.add_argument('--' + name, type=Path, required=True)
a = p.parse_args()
rt, out = a.runtime.resolve(), a.out.resolve()
out.mkdir()
repo = Path(__file__).resolve().parents[2]

def run(args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)

run(['g++', '-O2', '-I', repo/'wasm/llama-shim',
     repo/'test/fixtures/kv-active-extent.cpp', '-L', rt, '-lenclave_llama',
     '-Wl,-rpath-link,' + str(rt), '-o', out/'fixture'])
env = dict(os.environ, ENCLAVE_GGML_BACKEND_DIR=str(rt/'backends'),
           GGML_BACKEND_PATH=str(rt/'backends/libggml-cpu.so'),
           ENCLAVE_GGML_N_THREADS='6', ENCLAVE_GGML_N_THREADS_BATCH='6',
           ENCLAVE_GGML_N_UBATCH='64', ENCLAVE_GGML_N_RS_SEQ='1',
           ENCLAVE_GGML_SHARED_CPU_POOL='1', ENCLAVE_GGML_SMALL_GRAPH='0',
           ENCLAVE_GGML_CPU_PROFILE='0', SHIELDED_CPU_COMPUTE='0,2,3,4,5,6')
digests = []
for mode in ('0', '1'):
    data = out/('logits-' + mode + '.bin')
    with (out/('mode-' + mode + '.log')).open('w') as log:
        run([rt/'ld-linux-x86-64.so.2', '--library-path', rt,
             out/'fixture', a.model.resolve(), data],
            env=dict(env, ENCLAVE_GGML_GROUPED_ATTN=mode),
            stdout=log, stderr=subprocess.STDOUT)
    assert data.stat().st_size > 0
    with data.open('rb') as f:
        digests.append(hashlib.file_digest(f, 'sha256').hexdigest())
assert digests[0] == digests[1], digests
print('GROUPED_ATTENTION_PASS; all logits bit-identical; sha256=' + digests[0])
