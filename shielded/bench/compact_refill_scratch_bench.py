#!/usr/bin/env python3
"""Compare compact admission/refill memory and latency in two built runtimes.

Synthetic private weights, exact output checks, one CPU thread and isolated
network namespaces. No model or GPU worker is used. Measurements cover C++
allocation volume, admission peak RSS, first-refill RSS growth and warmed
refill latency. They do not establish end-to-end inference or fleet savings.
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
    p.add_argument('--cpu', type=int, help='pin each probe to one allowed logical CPU for repeatable timing')
    p.add_argument('--packing', action='store_true', help='exercise raw, nearly raw and compressible packing at representative widths')
    p.add_argument('--output', required=True, type=Path)
    args = p.parse_args()
    if args.repetitions < 1:
        p.error('repetitions must be positive')
    if args.cpu is not None and args.cpu not in os.sched_getaffinity(0):
        p.error('CPU must be in the current affinity mask')
    repo = Path(__file__).resolve().parents[2]
    versions = {'baseline': args.baseline_runtime.resolve(), 'candidate': args.candidate_runtime.resolve()}
    env = {k: v for k, v in os.environ.items() if not k.startswith(('SHIELDED_', 'LD_'))}
    env.update(OMP_NUM_THREADS='1', OMP_DYNAMIC='FALSE')
    shapes = [(5120, n, b, 4) for n in [16, 32, 48] for b in [4, 16, 32, 64]]
    shapes += [(5120, 48, 16, 8), (65536, 1, 16, 4),
               (5120, 384, 16, 4), (5120, 384, 31, 4)]
    shapes += [(k, n, b, 4) for k, n in [(17408, 5120), (5120, 17408)] for b in [4, 32]]
    if args.packing:
        shapes = [(k, n, 4, bits) for k, n in [(5120, 16), (5120, 48), (5120, 384), (5120, 385),
            (17408, 384), (17408, 5120), (5120, 17408)] for bits in [4, 8, 9]]
        shapes += [(65536, 384, 4, bits) for bits in [4, 8]]
        shapes += [(5120, 384, 32, bits) for bits in [4, 8]]
    with tempfile.TemporaryDirectory(prefix='compact-refill-scratch-') as temp:
        binary = Path(temp) / 'probe'
        baseline = versions['baseline']
        subprocess.run(['c++', '-O2', '-std=c++17', '-I' + str(repo / 'wasm/ggml-shielded'),
            str(Path(__file__).with_suffix('.cpp')), '-L' + str(baseline),
            '-L' + str(baseline / 'backends'), '-l:libggml-shielded.so',
            '-l:libggml.so.0', '-l:libggml-base.so.0', '-Wl,-rpath-link,' + str(baseline),
            '-o', str(binary)], check=True, timeout=60)
        rows = []
        for K, N, batch, bits in shapes:
            samples = {'baseline': [], 'candidate': []}
            expected = None
            for repeat in range(args.repetitions):
                order = list(versions.items())
                if repeat % 2:
                    order.reverse()
                for name, rt in order:
                    result = subprocess.run(['bwrap', '--unshare-all', '--ro-bind', str(rt), '/rt',
                        '--ro-bind', str(binary), '/probe', '--proc', '/proc', '--dev', '/dev',
                        '/rt/ld-linux-x86-64.so.2', '--library-path', '/rt:/rt/backends',
                        '/probe', str(K), str(N), str(batch), str(bits)], env=env, text=True,
                        capture_output=True, check=True, timeout=90,
                        preexec_fn=(lambda: os.sched_setaffinity(0, {args.cpu})) if args.cpu is not None else None)
                    value = json.loads(result.stdout)
                    if expected is not None:
                        assert value['output_hash'] == expected, (K, N, batch, bits, name)
                    expected = value['output_hash']
                    samples[name].append(value)
            row = dict(K=K, N=N, batch=batch, bits=bits, samples=samples)
            for name, values in samples.items():
                row[name] = {k: statistics.median(v[k] for v in values)
                    for k in values[0] if k not in ['K', 'N', 'batch', 'bits', 'output_hash']}
                row[name]['admission_and_first_refill_us'] = statistics.median(
                    v['create_us'] + v['first_refill_us'] for v in values)
            row['output_hash'] = expected
            row['store_bytes_change_pct'] = 100 * (row['candidate']['store_bytes'] / row['baseline']['store_bytes'] - 1)
            for field in ['create_us', 'first_refill_us', 'warm_refill_us', 'admission_and_first_refill_us']:
                row[field + '_change_pct'] = 100 * (row['candidate'][field] / row['baseline'][field] - 1)
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != 'samples'}), flush=True)
        report = dict(scope=__doc__, repetitions=args.repetitions,
            cpu=args.cpu,
            method='Alternating fresh processes. Compare admission and first refill, then three warmups, one timing estimate, and median per-refill time over 15 blocks sized to about 1 ms each (at most 1000 refills/block). malloc_trim(0) before first refill removes freed admission storage equally from both versions.',
            dimensions='K5120/N16,32,48 mirror narrow SSM projections/splits; larger controls use repository 27B FFN dimensions. K65536/N1 is an admitted-range stress case. No production placement or frequency claim.',
            packing_suite=args.packing,
            packing_dimensions='Packing mode uses narrow, full/partial-tile and 27B FFN dimensions plus K65536/N384 as an admitted-range stress case. Pattern4 is compressible, pattern8 is raw, pattern9 has one four-bit frame per 64 frames.',
            memory_caveat='C++ allocation volume is not peak live memory. /proc RSS and getrusage peak RSS are process measurements; loader, allocator and oneDNN effects remain. Retained per-worker scratch only shrinks on worker exit, so an earlier large matrix can hide small-matrix savings.',
            library_sha256={name: hashlib.sha256((rt / 'backends/libggml-shielded.so').read_bytes()).hexdigest()
                            for name, rt in versions.items()}, summary=rows)
        args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
