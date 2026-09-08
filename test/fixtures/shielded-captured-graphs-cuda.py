#!/usr/bin/env python3
"""Explicit opt-in CUDA correctness fixture. Starts only its own loopback scratch
worker on the UUID supplied by the caller. Uses small synthetic public operands,
not a phone/model benchmark. Does not connect to an existing worker or upload pads.

Usage: python3 shielded-captured-graphs-cuda.py WORKER GPU_UUID OUTPUT_DIRECTORY
"""
from pathlib import Path
import json
import math
import os
import re
import socket
import struct
import subprocess
import sys
import time

binary, gpu, out = sys.argv[1:]
if not re.fullmatch(r'GPU-[0-9a-f-]{36}', gpu):
    raise ValueError('explicit GPU UUID required')
out = Path(out)
out.mkdir(mode=0o700)
K, N, GROUPS, MAX_M = 32, 16, 262, 8
weights = [[[((g*3+j*5+k*7) % 15)-7 for k in range(K)] for j in range(N)] for g in range(GROUPS)]
weight_bytes = bytes(v & 255 for matrix in weights for row in matrix for v in row)


class Link:
    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.calls = self.cells = 0

    def read(self, n):
        result = bytearray()
        while len(result) < n:
            piece = self.sock.recv(n-len(result))
            if not piece:
                raise RuntimeError('worker EOF')
            result.extend(piece)
        return bytes(result)

    def call(self, command, body):
        self.sock.sendall(struct.pack('<BQ', command, len(body))+body)
        status, size = struct.unpack('<BQ', self.read(9))
        if size > 1 << 20:
            raise RuntimeError('oversized fixture response')
        data = self.read(size)
        if status:
            raise RuntimeError(data.decode('utf-8', 'replace'))
        return data

    def alloc(self, size, role):
        return struct.unpack('<Q', self.call(1, struct.pack('<QI', size, len(role))+role.encode()))[0]

    def install(self):
        hello = json.loads(self.call(0, struct.pack('<I', 1)))
        if hello['version'][:2] != [1, 4]:
            raise RuntimeError('unexpected worker version')
        wb = self.alloc(len(weight_bytes), 'weights')
        ab = self.alloc(4096, 'activations')
        self.call(8, struct.pack('<QQQ', wb, 0, len(weight_bytes))+weight_bytes)
        spec = dict(nodes=[dict(id=f'cache-test-{g}', op='FIELD_GEMM', K=K, N=N, max_m=MAX_M,
                                w=dict(bid=wb, offset=g*K*N), x=dict(bid=ab, offset=0),
                                y=dict(bid=ab, offset=1024)) for g in range(GROUPS)],
                    outputs=[dict(bid=ab, offset=1024, nbytes=MAX_M*N*4)])
        reply = json.loads(self.call(10, json.dumps(spec).encode()))
        if reply['nodes'] != GROUPS:
            raise RuntimeError('graph install mismatch')

    def gemm(self, groups, m, salt, packed=True):
        # These small signed values have the same representative in each of
        # the three byte-prime planes. Products stay well inside the CRT range.
        xs = [[((salt+r*3+k*2) % 11)-5 for k in range(K)] for r in range(m)]
        planes = bytes(x & 255 for row in xs for x in row)*3
        body = struct.pack('<II', len(groups), m)+struct.pack('<'+'I'*len(groups), *groups)+planes
        response = self.call(13 if packed else 12, body)
        width = 3 if packed else 4
        expected = [sum(xs[r][k]*weights[g][j][k] for k in range(K))
                    for g in groups for r in range(m) for j in range(N)]
        if len(response) != len(expected)*width:
            raise RuntimeError('response size mismatch')
        actual = [int.from_bytes(response[i:i+width], 'little', signed=True)
                  for i in range(0, len(response), width)]
        if actual != expected:
            raise RuntimeError(f'field result mismatch: groups={groups}, rows={m}, salt={salt}')
        self.calls += 1
        self.cells += len(expected)


def run(limit, packing):
    # The bind-and-release chooses a candidate only. Readiness below requires
    # our worker's successful bind; a race/occupied port fails without probing it.
    with socket.socket() as candidate:
        candidate.bind(('127.0.0.1', 0))
        port = candidate.getsockname()[1]
    log_path = out/f'{limit}-{packing}.log'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SHIELDED_')}
    env.update(CUDA_VISIBLE_DEVICES=gpu, SHIELDED_GRAPH_CACHE_ENTRIES=str(limit), SHIELDED_WORKER_PACK=packing)
    link = None
    with log_path.open('wb') as log:
        p = subprocess.Popen([binary, '--host', '127.0.0.1', '--port', str(port), '--vram-gb', '0.5'],
                             env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic()+45
            while True:
                text = log_path.read_text(errors='replace')
                if p.poll() is not None:
                    raise RuntimeError(f'worker startup exited {p.returncode}; see {log_path}')
                if f'listening on 127.0.0.1:{port} ' in text:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('scratch worker readiness deadline')
                time.sleep(.05)
            link = Link(port)
            link.install()
            for repeat in range(2):
                for g in range(GROUPS):
                    link.gemm([g], 4, repeat*7+g)
            # Grow pinned/device staging, then exercise order-sensitive fused
            # keys, warm replay and the separate unpacked protocol key.
            for groups, salt in (([0, 1], 1), ([1, 0], 2), ([0, 1], 3)):
                link.gemm(groups, 8, salt)
            link.gemm([3], 1, 4, packed=False)
            calls, cells = link.calls, link.cells
            link.sock.close()
            link = None
            deadline = time.monotonic()+10
            while True:
                text = log_path.read_text(errors='replace')
                match = re.search(r'graph cache: limit=(\d+) high_water=(\d+) hits=(\d+) misses=(\d+) capacity_flushes=(\d+) invalidations=(\d+)', text)
                if match:
                    break
                if p.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('missing graph cache summary')
                time.sleep(.05)
            got_limit, high, hits, misses, flushes, invalidations = map(int, match.groups())
            if (got_limit != limit or hits+misses != calls or invalidations < 1 or high > limit):
                raise RuntimeError(f'bad cache counters {match.group(0)}')
            if limit == 256 and (hits != 1 or misses != 527 or flushes != 2):
                raise RuntimeError('256-entry boundary did not exercise the expected evictions')
            if limit == 2048 and (hits != 263 or misses != 265 or flushes != 0):
                raise RuntimeError('larger cache did not retain the complete pass')
            if 'VIOLATION' in text or 'CUDA error' in text:
                raise RuntimeError(f'worker failure: see {log_path}')
            if os.environ.get('SH_TEST_WORKER_PROFILE') == '1':
                if 'exchange profile: host elapsed only; diagnostic build; invalid_intervals=0' not in text:
                    raise RuntimeError('missing or invalid per-connection diagnostic profile')
                phases = re.findall(r'exchange phase=([a-z_]+) samples=(\d+) total_us=([0-9.]+) max_us=([0-9.]+)', text)
                expected_phases = {'lock_wait', 'staging', 'graph_lookup_capture', 'graph_launch_call',
                                   'stream_sync', 'host_pack', 'tcp_reply_write'}
                if len(phases) != len(expected_phases) or {p[0] for p in phases} != expected_phases:
                    raise RuntimeError('incomplete or duplicate phase breakdown')
                for phase, sample_count, total, maximum in phases:
                    total, maximum = float(total), float(maximum)
                    if (int(sample_count) != calls or not math.isfinite(total) or not math.isfinite(maximum)
                            or not 0 <= maximum <= total+.001):
                        raise RuntimeError(f'bad per-connection phase counters: {phase}')
            result = dict(limit=limit, packing=packing, calls=calls, checked_values=cells,
                          hits=hits, misses=misses, capacity_flushes=flushes, invalidations=invalidations,
                          gpu=gpu, status='PASS')
            print(json.dumps(result), flush=True)
            return result
        finally:
            if link is not None:
                link.sock.close()
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)


results = []
for packing in ('epilogue', 'kernel', 'cpu'):
    for limit in (256, 2048):
        results.append(run(limit, packing))
(out/'result.json').write_text(json.dumps(results, indent=2)+'\n')
