#!/usr/bin/env python3
"""Compare compact-weight read allocations and latency in two built runtimes.

Pass --baseline-runtime and --candidate-runtime directories containing the
guest loader, libraries, and backends/libggml-shielded.so. Requires Linux,
bubblewrap, a C++ compiler, and AVX512 VNNI. Runs synthetic private weights in
isolated network namespaces; no GPU worker or model is contacted. The fixture
checks exact output and boundary guards. Creation and caller-owned output
buffers are excluded from the measured reads. This is not model throughput.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-runtime', required=True, type=Path)
    parser.add_argument('--candidate-runtime', required=True, type=Path)
    parser.add_argument('--repetitions', type=int, default=7)
    parser.add_argument('--widths', type=int, nargs='+', default=[64, 5120, 17408, 65536])
    args = parser.parse_args()
    if args.repetitions < 1 or any(k < 1 or k > 65536 for k in args.widths):
        parser.error('repetitions must be positive and widths must be in [1, 65536]')
    repo = Path(__file__).resolve().parents[2]
    versions = {'baseline': args.baseline_runtime.resolve(), 'improved': args.candidate_runtime.resolve()}
    env = {k: v for k, v in os.environ.items() if not k.startswith(('SHIELDED_', 'LD_'))}
    env.update(OMP_NUM_THREADS='1', OMP_DYNAMIC='FALSE')
    with tempfile.TemporaryDirectory(prefix='shield-compact-read-') as temp:
        binary = Path(temp) / 'read-bench'
        baseline = versions['baseline']
        subprocess.run(['c++', '-O2', '-std=c++17', '-I' + str(repo / 'wasm/ggml-shielded'),
            str(Path(__file__).with_suffix('.cpp')), '-L' + str(baseline),
            '-L' + str(baseline / 'backends'), '-l:libggml-shielded.so',
            '-l:libggml.so.0', '-l:libggml-base.so.0', '-Wl,-rpath-link,' + str(baseline),
            '-o', str(binary)], check=True, timeout=60)
        rows = []
        for width in args.widths:
            for partial in [0, 1]:
                for bits in [4, 8]:
                    samples = {'baseline': [], 'improved': []}
                    for repeat in range(args.repetitions):
                        order = list(versions.items())
                        if repeat % 2:
                            order.reverse()
                        for name, rt in order:
                            result = subprocess.run(['bwrap', '--unshare-all', '--ro-bind', str(rt), '/rt',
                                '--ro-bind', str(binary), '/probe', '--proc', '/proc', '--dev', '/dev',
                                '/rt/ld-linux-x86-64.so.2', '--library-path', '/rt:/rt/backends',
                                '/probe', str(width), str(partial), str(bits)], env=env, text=True,
                                capture_output=True, check=True, timeout=30)
                            samples[name].append(json.loads(result.stdout))
                    row = dict(K=width, N=385, partial=bool(partial), bits=bits, samples=samples)
                    for name, values in samples.items():
                        row[name] = {k: statistics.median(v[k] for v in values)
                                     for k in ['iterations', 'allocations', 'allocated_bytes',
                                               'largest_allocation_bytes', 'us_per_read']}
                    row['latency_change_pct'] = 100 * (row['improved']['us_per_read'] / row['baseline']['us_per_read'] - 1)
                    rows.append(row)
        print(json.dumps(dict(scope=__doc__, repetitions=args.repetitions,
            order='Alternating fresh processes after the build; three warmup reads before 30 measured reads',
            library_sha256={name: hashlib.sha256((rt / 'backends/libggml-shielded.so').read_bytes()).hexdigest()
                            for name, rt in versions.items()}, summary=rows), indent=2))


if __name__ == '__main__':
    main()
