"""Working-set probe for the chain clients: how much of the guest's memory do they need?

python3 -I /opt/enclave-rpc/memprobe.py   (the image's enclave-rpc-memprobe.service)

The guest is given its memory by the lease's catalog version, and every byte of it the guest has touched stays
pinned on the host: an SEV-SNP guest has no balloon. The clients fill whatever their limit allows with page cache,
so their memory.current says what they were allowed, not what they need, and nothing outside the sealed guest can
tell the two apart. This asks the kernel.

For MEASURE_SEC after it starts, once every INTERVAL: if the clients' slice has stalled on memory for less than
QUIET percent of the last 10 and the last 60 seconds (memory.pressure, `some`), it asks the kernel to take back STEP
of what the slice holds (memory.reclaim: the coldest pages go first, and with no swap in the guest only file pages
can go). Once the slice is down to what the clients keep touching, a taken page is read back, the read shows up as
pressure, and the probe holds until it has passed. The size it holds at is the working set; the guest's free
memory then is what a smaller catalog `memMb` could drop.

It sets no limit and stops no process. The reclaim runs in this unit, so its own cost is not charged to the
clients' pressure; what they pay is the re-read of a page that turned out warm, at most STEP per INTERVAL, and
nothing while they are under pressure from anything else. After MEASURE_SEC it stops asking and the page cache
grows back. STATE is read by the front's /memory (local name only).

Measured in production (image r14, 2026-11-13, ops/rpc-snp-prod-r7/release-r14/README.md): it does not find the
working set while Base follows the chain. Base turns its page cache over at about 62 MB a second, thirty times
STEP per INTERVAL, so the slice stays on its MemoryHigh, and the reclaim at that limit is itself the pressure that
holds the probe. `held` rising with the slice level is then the limit, not the working set. What /memory does
give is the anonymous memory and the re-read rate (workingset_refault_file against pgsteal).
"""
import json
import os
from pathlib import Path
import sys
import time

CGROUPS = Path('/sys/fs/cgroup')
SLICE = 'enclave-rpc-clients.slice'
STATE = Path('/run/enclave-rpc-memprobe/state.json')
INTERVAL = 60
QUIET = 0.1
STEP = 0.002
MEASURE_SEC = 48 * 3600
SAMPLE_SEC = 1800
KEEP = 96


def slice_dir(root, name):
    """systemd nests a slice under every dash-separated prefix of its name: a-b-c.slice is a.slice/a-b.slice/a-b-c.slice."""
    parts = name[:-len('.slice')].split('-')
    return root.joinpath(*('-'.join(parts[:i+1]) + '.slice' for i in range(len(parts))))


def pressure(text):
    """memory.pressure -> {'some': {'avg10': .., 'avg60': .., 'avg300': .., 'total': ..}, 'full': {...}}"""
    out = {}
    for line in text.splitlines():
        kind, _, rest = line.partition(' ')
        out[kind] = {k: float(v) for k, v in (f.split('=', 1) for f in rest.split())}
    return out


def stat(text, keys=('anon', 'file')):
    rows = dict(line.split(' ', 1) for line in text.splitlines() if ' ' in line)
    return [int(rows.get(k, 0)) for k in keys]


class Probe:
    def __init__(self, group, now):
        self.group = group
        self.next_sample = 0
        self.state = {'schema': 'enclave-rpc-memprobe/1', 'cgroup': str(group), 'startedAt': int(now), 'updatedAt': int(now),
                      'measureSec': MEASURE_SEC, 'intervalSec': INTERVAL, 'quietPercent': QUIET, 'step': STEP,
                      'phase': 'waiting', 'ticks': 0, 'asked': 0, 'askedBytes': 0, 'short': 0, 'held': 0,
                      'lastError': None, 'holds': [], 'samples': []}

    def tick(self, now):
        """One look at the slice; returns the state to publish. Reclaims at most once."""
        s = self.state
        s['updatedAt'] = int(now)
        if s['phase'] in ('done', 'unsupported'):
            return s
        if not (self.group/'memory.current').exists():
            return s                                      # the clients have not started (or stopped): nothing to measure
        if not ((self.group/'memory.reclaim').exists() and (self.group/'memory.pressure').exists()):
            s['phase'] = 'unsupported'                    # a kernel without PSI or proactive reclaim: report, change nothing
            return s
        if s['phase'] == 'waiting':
            s['phase'], s['measuringSince'] = 'measuring', int(now)
        try:
            current = int((self.group/'memory.current').read_text())
            some = pressure((self.group/'memory.pressure').read_text())['some']
            anon, file = stat((self.group/'memory.stat').read_text())
        except (OSError, KeyError, ValueError) as e:
            s['lastError'] = '%s: %s' % (type(e).__name__, e)
            return s
        s['ticks'] += 1
        if now >= self.next_sample:
            self.next_sample = now + SAMPLE_SEC
            s['samples'] = (s['samples'] + [[int(now), current, anon, file, some['avg60']]])[-KEEP:]
        if now - s['measuringSince'] >= MEASURE_SEC:
            s['phase'] = 'done'
            return s
        if some['avg10'] >= QUIET or some['avg60'] >= QUIET:
            s['held'] += 1
            s['holds'] = (s['holds'] + [[int(now), current, anon, some['avg10'], some['avg60']]])[-KEEP:]
            return s
        ask = int(current * STEP)
        if ask < (1 << 20):
            return s
        s['asked'] += 1
        s['askedBytes'] += ask
        try:
            (self.group/'memory.reclaim').write_text(str(ask))
        except OSError as e:
            # EAGAIN: the kernel took less than was asked, because what is left is in use or cannot go
            s['short'] += 1
            s['lastError'] = '%s: %s' % (type(e).__name__, e)
        return s


def publish(state, path=None):
    path = path or STATE
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, separators=(',', ':')))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    probe = Probe(slice_dir(CGROUPS, SLICE), time.time())
    phase = None
    while True:
        state = probe.tick(time.time())
        publish(state)
        if state['phase'] != phase:
            phase = state['phase']
            print(json.dumps({'event': 'memprobe', 'phase': phase, 'asked': state['asked'], 'held': state['held'],
                              'askedBytes': state['askedBytes'], 'lastError': state['lastError']}), flush=True)
        time.sleep(INTERVAL)


if __name__ == '__main__':
    sys.exit(main())
