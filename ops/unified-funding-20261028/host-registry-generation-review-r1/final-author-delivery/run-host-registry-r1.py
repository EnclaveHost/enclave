#!/usr/bin/env python3
# PROPOSED bounded root harness (Claude prepared, NOT run). Root reviews, pins this script's and run-host-registry-r1.sh's SHA-256
# below, then runs it in the foreground. One CPU, no network (unshare -Urn), no swap use tolerated, inner RSS cap 1408 MiB,
# MemAvailable floor 27648 MiB, wall timeout 1500 s (outer job must stay <= 1700 s). Any guard breach kills the whole session.
from pathlib import Path
import hashlib, json, os, signal, subprocess, sys, time
HERE = Path(__file__).resolve().parent; STAGE = HERE.parent
SCRIPT = HERE / 'run-host-registry-r1.sh'
SCRIPT_SHA256 = 'ROOT-FILLS-AFTER-REVIEW'            # sha256 of run-host-registry-r1.sh as reviewed
RSS_MIB, FLOOR_MIB, TIMEOUT_S = 1408, 27648, 1500
def mib(field):
    for line in open('/proc/meminfo'):
        if line.startswith(field + ':'): return int(line.split()[1]) // 1024
    raise SystemExit(f'no {field}')
def session_rss(sid):
    total = 0
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if os.getsid(int(p.name)) != sid: continue
            for line in open(p / 'status'):
                if line.startswith('VmRSS:'): total += int(line.split()[1]) // 1024
        except (OSError, ProcessLookupError): pass
    return total
if hashlib.sha256(SCRIPT.read_bytes()).hexdigest() != SCRIPT_SHA256: raise SystemExit('reviewed runner drift')
pins = json.loads((STAGE / 'input-pins.json').read_text())
for path, digest in pins.items():
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest: raise SystemExit('qualified input drift: ' + path)
if mib('SwapTotal') - mib('SwapFree') > 0: raise SystemExit('swap in use: refusing')
if mib('MemAvailable') < FLOOR_MIB + RSS_MIB: raise SystemExit('available memory below floor + inner cap')
os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})
log = (HERE / 'run-r1.log').open('x')
p = subprocess.Popen(['unshare', '-Urn', 'bash', str(SCRIPT)], stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
t0, peak, why = time.time(), 0, None
while p.poll() is None:
    rss = session_rss(p.pid); peak = max(peak, rss)
    if rss > RSS_MIB: why = f'inner RSS {rss} MiB > {RSS_MIB}'
    elif mib('MemAvailable') < FLOOR_MIB: why = 'MemAvailable below floor'
    elif mib('SwapTotal') - mib('SwapFree') > 0: why = 'swap used'
    elif time.time() - t0 > TIMEOUT_S: why = 'timeout'
    if why:
        os.killpg(p.pid, signal.SIGTERM); time.sleep(5)
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        break
    time.sleep(0.5)
rc = p.wait()
drift = [x for x, d in pins.items() if hashlib.sha256(Path(x).read_bytes()).hexdigest() != d]
(HERE / 'run-r1.json').write_text(json.dumps({'rc': rc, 'guard': why, 'peakRssMiB': peak, 'seconds': round(time.time() - t0, 1), 'inputDrift': drift}) + '\n')
sys.exit(rc if why is None and not drift else 1)
