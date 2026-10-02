#!/usr/bin/env python3
"""Compare retained verification storage in two built Shield runtimes.

Synthetic repeated registrations share one immutable weight matrix. Real
registration and verification kernels run; no model, socket exchange or GPU
worker is contacted. Results are not end-to-end inference or fleet estimates.
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
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline-runtime', required=True, type=Path)
    p.add_argument('--candidate-runtime', required=True, type=Path)
    p.add_argument('--repetitions', type=int, default=7)
    p.add_argument('--cpu', type=int, required=True)
    p.add_argument('--dealt', action='store_true', help='measure dealt-pad registration; no pad files are opened')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    if args.repetitions < 1 or args.cpu not in os.sched_getaffinity(0):
        p.error('positive repetitions and an allowed CPU are required')
    repo = Path(__file__).resolve().parents[2]
    versions = dict(baseline=args.baseline_runtime.resolve(), candidate=args.candidate_runtime.resolve())
    env = {k: v for k, v in os.environ.items() if not k.startswith(('SHIELDED_', 'LD_'))}
    env.update(OMP_NUM_THREADS='1', OMP_DYNAMIC='FALSE')
    if args.dealt:
        # Synthetic fixture configuration only. Registration creates checks;
        # this probe never starts the link or imports pads from these paths.
        env.update(SHIELDED_PAD_SOURCE='/fixture-pads', SHIELDED_PAD_LEDGER='/fixture-ledger',
                   SHIELDED_PAD_SEED='00' * 32, SHIELDED_PAD_SEED_ID='11' * 16,
                   SHIELDED_PAD_SK='22' * 32, SHIELDED_PAD_CHECK='1')
    rows = []
    with tempfile.TemporaryDirectory(prefix='verification-storage-') as temp:
        binary = Path(temp) / 'probe'
        base = versions['baseline']
        subprocess.run(['cc', '-O2', '-std=c11', '-I' + str(repo / 'wasm/ggml-shielded'),
            str(Path(__file__).with_suffix('.c')), '-L' + str(base / 'backends'), '-L' + str(base),
            '-l:libggml-shielded.so', '-l:libggml.so.0', '-l:libggml-base.so.0',
            '-Wl,-rpath-link,' + str(base), '-o', str(binary)],
            check=True, timeout=60)
        for K, N, nodes in [(5120, 48, 64), (5120, 17408, 1), (5120, 17408, 32), (17408, 5120, 32)]:
            samples = dict(baseline=[], candidate=[])
            for repeat in range(args.repetitions):
                order = list(versions.items())
                if repeat % 2:
                    order.reverse()
                for name, rt in order:
                    result = subprocess.run(['bwrap', '--unshare-all', '--ro-bind', str(rt), '/rt',
                        '--ro-bind', str(binary), '/probe', '--proc', '/proc', '--dev', '/dev',
                        '/rt/ld-linux-x86-64.so.2', '--library-path', '/rt:/rt/backends', '/probe',
                        str(K), str(N), str(nodes)], env=env, capture_output=True, text=True,
                        timeout=120, check=True, preexec_fn=lambda: os.sched_setaffinity(0, {args.cpu}))
                    value = json.loads(result.stdout)
                    assert value['exact_products_verified'] and value['dealt'] == args.dealt
                    samples[name].append(value)
            row = dict(K=K, N=N, nodes=nodes, samples=samples,
                       expected_released_bytes=nodes * (K + N) * 2 * 8 if args.dealt else 0)
            for name, values in samples.items():
                row[name] = {k: statistics.median(v[k] for v in values) for k in values[0]
                             if k not in ['K', 'N', 'nodes', 'rows', 'dealt', 'exact_products_verified']}
            for field in ['admission_us', 'warm_verify_us_per_node']:
                row[field + '_change_pct'] = 100 * (row['candidate'][field] / row['baseline'][field] - 1)
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != 'samples'}), flush=True)
    args.output.write_text(json.dumps(dict(scope=__doc__, cpu=args.cpu, dealt=args.dealt, repetitions=args.repetitions,
        method='Alternating fresh isolated processes pinned to one CPU. Real registration uses the normal parallel preparation policy; helper threads inherit the same CPU. Warm verification uses three warmups, one estimate and 15 blocks of about 2ms each (at most 1000 passes/block). No malloc_trim is called.',
        caveat='mallinfo2 retained bytes include allocator bookkeeping and helper-thread storage; RSS includes allocator and runtime effects. Repeated nodes reuse one synthetic weight matrix; counts and timings do not model a whole application.',
        library_sha256={name: hashlib.sha256((rt / 'backends/libggml-shielded.so').read_bytes()).hexdigest()
                        for name, rt in versions.items()}, summary=rows), indent=2) + '\n')


if __name__ == '__main__':
    main()
