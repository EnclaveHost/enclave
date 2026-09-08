#!/usr/bin/env python3
from pathlib import Path
import csv
import hashlib
import importlib.util
import json
import math
import subprocess
import sys
import tempfile

path = (Path(__file__).resolve().parent.parent/'shielded/anchor/avf/host').joinpath('gpu-util-window.py')
spec = importlib.util.spec_from_file_location('window_summary', path)
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)
gpus = ['GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c', 'GPU-042eb279-e6e6-9866-5823-015b8d26946a']
count = 0


def row(t, gpu=gpus[0], util=0, power=None):
    return dict(uuid=gpu, index=gpus.index(gpu), recv_mono=float(t), recv_utc=1700000000.0+t,
                util_gpu=util, util_mem=0, mem_used_mib=100, mem_total_mib=32768,
                power_w=power, sm_mhz=1200, temp_c=35)


def analyze(rows, selected=gpus[:1], **kw):
    return window.analyze(rows, selected, kw.pop('start', 0), kw.pop('end', 10),
                          kw.pop('max_gap', 1.5), capture_clean=kw.pop('clean', True), **kw)


def check(label, good):
    global count
    if not good: raise AssertionError(label)
    count += 1


full = [row(t, gpu, 0 if gpu == gpus[0] else 100, None if gpu == gpus[0] else 80)
        for t in range(11) for gpu in gpus]
s = analyze(full, gpus)
check('two GPUs independently bracketed', s['status'] == 'VALID_OBSERVATIONS')
check('zero readings retained as measured zeros', s['gpus'][gpus[0]]['fraction_readings_zero'] == 1)
check('busy readings retained', s['gpus'][gpus[1]]['mean_reported_util_pct'] == 100)
check('unknown power stays null', s['gpus'][gpus[0]]['mean_reported_power_w'] is None)
check('known power independent', s['gpus'][gpus[1]]['mean_reported_power_w'] == 80)

s = analyze([row(5), row(6)])
check('short fragment is not full-window coverage', s['status'] == 'INCOMPLETE' and math.isclose(s['gpus'][gpus[0]]['observation_coverage_fraction'], .1))
s = analyze([row(t) for t in (0, 1, 2, 8, 9, 10)])
check('middle gap excludes unobserved time', s['status'] == 'INCOMPLETE' and math.isclose(s['gpus'][gpus[0]]['observation_coverage_fraction'], .4))
check('middle gap explicitly reported', s['gpus'][gpus[0]]['largest_observation_gap_s'] == 6)
s = analyze([row(t) for t in range(11)], gpus)
check('missing expected card invalidates summary', s['status'] == 'INCOMPLETE' and s['gpus'][gpus[1]]['samples_in_window'] == 0)
check('failed capture invalidates good rows', analyze(full, gpus, clean=False)['status'] == 'INCOMPLETE')
check('unknown capture invalidates good rows', analyze(full, gpus, clean=None)['status'] == 'INCOMPLETE')
check('one reading cannot establish coverage', analyze([row(5)])['status'] == 'INCOMPLETE')
check('no readings inside short window', analyze([row(0), row(1)], start=.1, end=.9)['status'] == 'INCOMPLETE')
s = analyze([row(t) for t in range(11)], start=.5, end=9.5)
check('brackets outside measured window are accepted', s['status'] == 'VALID_OBSERVATIONS' and s['gpus'][gpus[0]]['samples_in_window'] == 9)

for label, rows, kw in (
    ('duplicate timestamp', [row(0), row(0)], {}),
    ('reversed timestamp', [row(2), row(1)], {}),
    ('nonfinite time', [row(float('nan'))], {}),
    ('invalid utilization', [row(0, util=101)], {}),
    ('zero window', [], dict(end=0)),
    ('negative gap', [], dict(max_gap=-1)),
    ('nonfinite bound', [], dict(end=float('inf'))),
    ('changed device index', [row(0), dict(row(1), index=9)], {}),
):
    refused = False
    try: analyze(rows, **kw)
    except ValueError: refused = True
    check(label, refused)

with tempfile.TemporaryDirectory(prefix='gpu-window-fixture-') as directory:
    csv_path = Path(directory)/'trace.csv'
    capture_path = Path(directory)/'capture.json'
    headers = ['recv_utc', 'recv_mono', 'smi_timestamp', 'index', 'uuid', 'util_gpu', 'util_mem',
               'mem_used_mib', 'mem_total_mib', 'power_w', 'sm_mhz', 'temp_c']
    def write_csv(rows):
        with csv_path.open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            for r in rows: writer.writerow(dict(r, smi_timestamp='fixture'))
    write_csv(full)
    loaded = window.load_rows(csv_path, gpus)
    check('real CSV parser preserves missing power', loaded[0]['power_w'] is None and len(loaded) == 22)
    args = [sys.executable, str(path), str(csv_path), '--gpus', ','.join(gpus), '--start', '0', '--end', '10',
            '--max-gap', '1.5', '--capture-summary', str(capture_path)]
    binding = dict(csv_bytes=csv_path.stat().st_size, csv_sha256=hashlib.sha256(csv_path.read_bytes()).hexdigest())
    capture_path.write_text(json.dumps(dict(status='PASS', bad_rows=0, **binding)))
    p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    check('CLI clean capture and complete data', p.returncode == 0 and json.loads(p.stdout)['status'] == 'VALID_OBSERVATIONS')
    capture_path.write_text(json.dumps(dict(status='FAIL', bad_rows=0, **binding)))
    p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    check('CLI capture failure cannot be hidden by data', p.returncode == 2)
    capture_path.write_text('{"status":"FAIL","status":"PASS","bad_rows":0}')
    p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    check('duplicate capture status rejected', p.returncode == 3)
    capture_path.write_text(json.dumps(dict(status='PASS', bad_rows=0)))
    p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    check('unbound success sidecar rejected', p.returncode == 3)
    capture_path.write_text(json.dumps(dict(status='PASS', bad_rows=0, **binding)))
    write_csv([dict(r, util_gpu=5 if r['util_gpu'] == 0 else r['util_gpu']) for r in full])
    assert csv_path.stat().st_size == binding['csv_bytes']
    p = subprocess.run(args, capture_output=True, text=True, timeout=5)
    check('stale success sidecar rejected for same-length changed CSV', p.returncode == 3)
    write_csv([dict(row(0), temp_c=-5)])
    check('negative Celsius is valid', window.load_rows(csv_path, gpus)[0]['temp_c'] == -5)
    for label, field, value in (('NaN utilization', 'util_gpu', 'nan'), ('infinite power', 'power_w', 'inf'),
                                ('NaN power', 'power_w', 'nan'), ('hotter than allowed', 'temp_c', 201),
                                ('negative memory', 'mem_used_mib', -1), ('overcommitted memory', 'mem_used_mib', 40000)):
        write_csv([dict(row(0), **{field: value})])
        refused = False
        try: window.load_rows(csv_path, gpus)
        except ValueError: refused = True
        check(label, refused)
print(f'{count} GPU observation-window cases PASS')
