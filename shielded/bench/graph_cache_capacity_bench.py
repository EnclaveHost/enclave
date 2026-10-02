#!/usr/bin/env python3
"""Measure a scratch CUDA worker's graph-cache capacity and retained host RSS.

Uses tiny public operands and exact product checks over synthetic row-width
traces. This is a loopback exchange benchmark, not model inference or fleet
traffic. Only the explicitly supplied GPU UUID is used; no live worker is
contacted. Cache capacity is an existing environment option, not a code change.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import statistics
import struct
import subprocess
import time


def rss(pid):
    fields = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines())
    return {key: int(fields[key].split()[0]) for key in ['VmRSS', 'VmHWM']}


def requests(fixture, rows):
    result = []
    for m in rows:
        for group in range(fixture.GROUPS):
            # Each cache hit must use the current activation, not a prior reply.
            variants = []
            for salt in range(4):
                xs = [[((salt + group + r*3 + k*2) % 11)-5 for k in range(fixture.K)] for r in range(m)]
                planes = bytes(x & 255 for row in xs for x in row)*3
                body = struct.pack('<III', 1, m, group) + planes
                expected = b''.join(sum(xs[r][k]*fixture.weights[group][j][k] for k in range(fixture.K))
                    .to_bytes(3, 'little', signed=True) for r in range(m) for j in range(fixture.N))
                variants.append((body, expected))
            result.append(((m, group), variants))
    return result


def summarize(samples):
    result = []
    for keys, limit in sorted({(s['keys'], s['limit']) for s in samples}):
        selected = [s for s in samples if s['keys'] == keys and s['limit'] == limit]
        result.append(dict(keys=keys, limit=limit, processes=len(selected),
            warm_wire_mean_us=statistics.median(statistics.mean(r['wire_mean_us'] for r in s['rounds'][1:]) for s in selected),
            warm_wire_median_us=statistics.median(statistics.median(r['wire_median_us'] for r in s['rounds'][1:]) for s in selected),
            retained_rss_above_staged_kib=statistics.median(s['rounds'][-1]['memory']['VmRSS']-s['staged']['VmRSS'] for s in selected),
            capture_ms=statistics.median(s['capture_ms'] for s in selected),
            counters_per_process=[s['stats'] for s in selected]))
    return result


def run(args, fixture, trace, rows, limit, repeat):
    with socket.socket() as candidate:
        candidate.bind(('127.0.0.1', 0))
        port = candidate.getsockname()[1]
    log_path = args.output.parent / f'graph-capacity-{len(rows)}rows-{limit}-{repeat}.log'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SHIELDED_')}
    env.update(CUDA_VISIBLE_DEVICES=args.gpu, SHIELDED_GRAPH_CACHE_ENTRIES=str(limit),
               SHIELDED_WORKER_PACK='epilogue')
    cache = set()
    expected_stats = dict(hits=0, misses=0, capacity_flushes=0)
    def observe(key):
        if key in cache:
            expected_stats['hits'] += 1
        else:
            expected_stats['misses'] += 1
            if len(cache) == limit:
                cache.clear()
                expected_stats['capacity_flushes'] += 1
            cache.add(key)
    link = None
    with log_path.open('wb') as log:
        worker = subprocess.Popen([str(args.worker), '--host', '127.0.0.1', '--port', str(port),
            '--vram-gb', '0.5'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 45
            while f'listening on 127.0.0.1:{port} ' not in log_path.read_text(errors='replace'):
                if worker.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(f'scratch worker failed readiness: {log_path}')
                time.sleep(.05)
            ready = rss(worker.pid)
            link = fixture.Link(port)
            link.install()
            installed = rss(worker.pid)
            # Establish the largest staging pointers before measuring any trace.
            link.gemm([0], fixture.MAX_M, 0)
            observe((fixture.MAX_M, 0))
            staged = rss(worker.pid)
            rounds = []
            checked_values = fixture.MAX_M * fixture.N
            for round_index in range(args.rounds):
                times = []
                start = time.perf_counter_ns()
                for key, variants in trace:
                    body, expected = variants[round_index % len(variants)]
                    before = time.perf_counter_ns()
                    actual = link.call(13, body)
                    times.append((time.perf_counter_ns() - before) / 1000)
                    if actual != expected:
                        raise RuntimeError(f'wrong product at rows/group {key}, round {round_index}')
                    checked_values += len(expected) // 3
                    observe(key)
                rounds.append(dict(index=round_index, wire_mean_us=statistics.mean(times),
                    wire_median_us=statistics.median(times), wire_p95_us=sorted(times)[int(.95*len(times))],
                    wall_ms=(time.perf_counter_ns()-start)/1e6, memory=rss(worker.pid)))
            link.sock.close()
            link = None
            deadline = time.monotonic() + 10
            pattern = r'graph cache: limit=(\d+) high_water=(\d+) hits=(\d+) misses=(\d+) capacity_flushes=(\d+) invalidations=(\d+) capture=([0-9.]+) ms'
            while True:
                text = log_path.read_text(errors='replace')
                match = re.search(pattern, text)
                if match:
                    break
                if worker.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(f'missing graph cache summary: {log_path}')
                time.sleep(.05)
            got_limit, high, hits, misses, flushes, invalidations = map(int, match.groups()[:6])
            stats = dict(hits=hits, misses=misses, capacity_flushes=flushes)
            if got_limit != limit or stats != expected_stats or high > limit or invalidations != 0:
                raise RuntimeError(f'unexpected graph-cache counters: {match.group(0)}, expected {expected_stats}')
            if 'VIOLATION' in text or 'CUDA error' in text:
                raise RuntimeError(f'worker failure: {log_path}')
            return dict(rows=rows, keys=len(trace), limit=limit, repeat=repeat, ready=ready,
                installed=installed, staged=staged, rounds=rounds, stats=stats,
                high_water=high, invalidations=invalidations, capture_ms=float(match[7]),
                checked_values=checked_values, exact=True, log=str(log_path))
        finally:
            if link is not None:
                link.sock.close()
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', type=Path, required=True)
    parser.add_argument('--gpu', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--rounds', type=int, default=4)
    args = parser.parse_args()
    if not re.fullmatch(r'GPU-[0-9a-f-]{36}', args.gpu) or args.repetitions < 1 or not 2 <= args.rounds <= 32:
        parser.error('explicit GPU UUID, positive repetitions and 2..32 rounds required')
    args.worker = args.worker.resolve()
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('graph_fixture', repo / 'test/fixtures/shielded-captured-graphs-cuda.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    samples = []
    for rows in [[1, 2], [1, 2, 4, 5, 8]]:
        trace = requests(fixture, rows)
        for repeat in range(args.repetitions):
            for limit in ([1024, 2048] if repeat % 2 == 0 else [2048, 1024]):
                sample = run(args, fixture, trace, rows, limit, repeat)
                samples.append(sample)
                print(json.dumps(sample), flush=True)
    result = dict(scope=__doc__, gpu=args.gpu, worker_sha256=hashlib.sha256(args.worker.read_bytes()).hexdigest(),
        method='Fresh scratch workers with alternating capacity order; four changing activation variants checked exactly. Precomputed requests; wire timing excludes expected-result generation. RSS measured at fixed round boundaries; HWM covers the process lifetime. Summary is the median across process-level warm-round means/medians; round zero is excluded from warm timing.',
        caveat='Synthetic small matrices on a shared desktop GPU. RSS includes CUDA/allocator memory, not just graph metadata; no CUDA graph byte-accounting API is used. No model or live fleet traffic measured. No production setting changed.',
        summary=summarize(samples), samples=samples)
    args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
