#!/usr/bin/env python3
"""Summarize a completed GPU trace over an explicit measured window.

Observation coverage describes gaps between received readings. It is not proof
of uninterrupted kernel execution, nor a measure of a particular process's GPU
usage. Percentages below summarize the driver's reported values; the share of
zero readings must not be described as the exact fraction of wall time idle.

Use recv_mono with window markers from the SAME GPU host. recv_utc requires the
caller to establish clock alignment when markers come from another host.
"""
import argparse
import csv
import io
import hashlib
import json
import math
import os
import re
import sys

UUID = re.compile(r'GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
REQUIRED = {'recv_utc', 'recv_mono', 'index', 'uuid', 'util_gpu', 'util_mem',
            'mem_used_mib', 'mem_total_mib', 'power_w', 'sm_mhz', 'temp_c'}
MAX_BYTES = 64 << 20
MAX_ROWS = 500000


def number(value, name, lo=0, hi=None):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{name}: not a number') from None
    if isinstance(value, bool) or not math.isfinite(result) or result < lo or (hi is not None and result > hi):
        raise ValueError(f'{name}: nonfinite or out of range')
    return result


def optional_number(value, name, lo=0, hi=None):
    if value is None or str(value).strip().lower() in ('', '[n/a]', 'n/a', 'null'):
        return None
    return number(value, name, lo, hi)


def validate_gpus(gpus):
    if not gpus or len(gpus) > 64 or len(set(gpus)) != len(gpus) or any(not isinstance(g, str) or not UUID.fullmatch(g) for g in gpus):
        raise ValueError('supply 1..64 distinct full GPU UUIDs')


def load_rows(path, gpus, capture=None):
    validate_gpus(gpus)
    selected = set(gpus)
    rows = []
    csv.field_size_limit(4096)
    with open(path, 'rb') as f:
        if os.fstat(f.fileno()).st_size > MAX_BYTES:
            raise ValueError('trace exceeds 64 MiB')
        raw = f.read(MAX_BYTES+1)
    if len(raw) > MAX_BYTES:
        raise ValueError('trace grew past 64 MiB')
    if capture is not None:
        # Bind the success record to the exact bytes being summarized. Otherwise
        # a failed rerun could inherit an older successful sidecar at this path.
        if (type(capture.get('csv_bytes')) is not int or capture['csv_bytes'] != len(raw)
                or capture.get('csv_sha256') != hashlib.sha256(raw).hexdigest()):
            raise ValueError('capture summary does not bind these exact CSV bytes')
    with io.TextIOWrapper(io.BytesIO(raw), newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames) or not REQUIRED <= set(reader.fieldnames):
            raise ValueError('missing or duplicate CSV header fields')
        for ordinal, row in enumerate(reader, 1):
            if ordinal > MAX_ROWS:
                raise ValueError('trace exceeds 500000 rows')
            if None in row or any(row.get(k) is None for k in REQUIRED):
                raise ValueError(f'row {ordinal}: wrong column count')
            if row['uuid'] not in selected:
                continue
            index = number(row['index'], 'index', hi=65535)
            if index != int(index):
                raise ValueError('GPU index is not an integer')
            total = number(row['mem_total_mib'], 'memory total')
            if total <= 0:
                raise ValueError('memory total is not positive')
            rows.append(dict(uuid=row['uuid'], index=int(index),
                             recv_mono=number(row['recv_mono'], 'recv_mono'),
                             recv_utc=number(row['recv_utc'], 'recv_utc'),
                             util_gpu=number(row['util_gpu'], 'GPU utilization', hi=100),
                             util_mem=number(row['util_mem'], 'memory utilization', hi=100),
                             mem_used_mib=number(row['mem_used_mib'], 'memory used', hi=total),
                             mem_total_mib=total, power_w=optional_number(row['power_w'], 'power', hi=5000),
                             sm_mhz=optional_number(row['sm_mhz'], 'SM clock', hi=20000),
                             temp_c=optional_number(row['temp_c'], 'temperature', lo=-50, hi=200)))
    return rows


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered)-1)*fraction
    lo = int(position)
    hi = min(lo+1, len(ordered)-1)
    return ordered[lo]+(ordered[hi]-ordered[lo])*(position-lo)


def analyze(rows, gpus, start, end, max_gap, clock='recv_mono', capture_clean=False):
    validate_gpus(gpus)
    start, end = number(start, 'window start'), number(end, 'window end')
    max_gap = number(max_gap, 'maximum observation gap')
    if end <= start or max_gap <= 0 or clock not in ('recv_mono', 'recv_utc'):
        raise ValueError('invalid window, maximum gap or clock')
    by_gpu = {gpu: [] for gpu in gpus}
    for row in rows:
        if row['uuid'] in by_gpu:
            by_gpu[row['uuid']].append(row)
    summary = dict(status='VALID_OBSERVATIONS', capture_clean=capture_clean is True,
                   clock=clock, window_start=start, window_end=end, window_seconds=end-start,
                   max_allowed_observation_gap_s=max_gap, gpus={}, reasons=[])
    if capture_clean is not True:
        summary['reasons'].append('capture process/write status is failed or unknown')
    for gpu, samples in by_gpu.items():
        previous = None
        for row in samples:
            number(row[clock], clock)
            number(row['util_gpu'], 'GPU utilization', hi=100)
            if previous is not None:
                if row[clock] <= previous[clock]:
                    raise ValueError(f'{gpu}: duplicate or reversed sample time')
                if row['index'] != previous['index'] or row['mem_total_mib'] != previous['mem_total_mib']:
                    raise ValueError(f'{gpu}: device identity/total memory changed')
            previous = row
        inside = [row for row in samples if start <= row[clock] <= end]
        covered = 0.0
        gaps = []
        # Consecutive observation intervals do not overlap. Count only the
        # portions within the requested window, and reject a long gap in full.
        for left, right in zip(samples, samples[1:]):
            lo, hi = max(start, left[clock]), min(end, right[clock])
            if hi <= lo:
                continue
            gap = right[clock]-left[clock]
            gaps.append(gap)
            if gap <= max_gap:
                covered += hi-lo
        bracketed = bool(samples and samples[0][clock] <= start and samples[-1][clock] >= end)
        fraction = min(1.0, max(0.0, covered/(end-start)))
        usable = bracketed and len(inside) >= 2 and math.isclose(fraction, 1.0, abs_tol=1e-9)
        u = [row['util_gpu'] for row in inside]
        power = [row['power_w'] for row in inside if row['power_w'] is not None]
        summary['gpus'][gpu] = dict(status='VALID_OBSERVATIONS' if usable else 'INCOMPLETE',
            samples_in_window=len(inside), window_bracketed=bracketed,
            observation_coverage_fraction=fraction, largest_observation_gap_s=max(gaps, default=None),
            mean_reported_util_pct=sum(u)/len(u) if u else None,
            p50_reported_util_pct=percentile(u, .5), p90_reported_util_pct=percentile(u, .9),
            max_reported_util_pct=max(u, default=None),
            fraction_readings_zero=sum(v == 0 for v in u)/len(u) if u else None,
            fraction_readings_ge90=sum(v >= 90 for v in u)/len(u) if u else None,
            memory_used_mib_max=max((row['mem_used_mib'] for row in inside), default=None),
            power_reading_count=len(power), mean_reported_power_w=sum(power)/len(power) if power else None)
        if not usable:
            summary['reasons'].append(f'{gpu}: missing bracketing, readings or continuous observation coverage')
    if summary['reasons']:
        summary['status'] = 'INCOMPLETE'
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv')
    parser.add_argument('--gpus', required=True, help='comma-separated full UUIDs')
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--max-gap', type=float, required=True)
    parser.add_argument('--clock', choices=('recv_mono', 'recv_utc'), default='recv_mono')
    parser.add_argument('--capture-summary', required=True, help='sampler JSON with status=PASS, bad_rows=0, csv_bytes and csv_sha256')
    args = parser.parse_args()
    try:
        gpus = args.gpus.split(',')
        with open(args.capture_summary, encoding='utf-8') as f:
            raw = f.read(65537)
        if len(raw) > 65536:
            raise ValueError('capture summary too large')
        def unique_keys(pairs):
            value = {}
            for key, item in pairs:
                if key in value: raise ValueError('duplicate capture summary key: '+key)
                value[key] = item
            return value
        capture = json.loads(raw, object_pairs_hook=unique_keys)
        if not isinstance(capture, dict):
            raise ValueError('capture summary is not an object')
        clean = isinstance(capture, dict) and capture.get('status') == 'PASS' and type(capture.get('bad_rows')) is int and capture['bad_rows'] == 0
        summary = analyze(load_rows(args.csv, gpus, capture), gpus, args.start, args.end, args.max_gap, args.clock, clean)
        print(json.dumps(summary, indent=2, allow_nan=False))
        return 0 if summary['status'] == 'VALID_OBSERVATIONS' else 2
    except (OSError, ValueError, csv.Error) as e:
        print(json.dumps(dict(status='INVALID', reason=str(e))), file=sys.stderr)
        return 3


if __name__ == '__main__':
    sys.exit(main())
