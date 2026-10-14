#!/usr/bin/env python3
"""Place a paused Shield guest's vCPU threads using the host's actual L3/core topology.
This host scheduling policy changes availability/performance, not the SNP trust boundary.
"""
import argparse, json, os, socket, time
from pathlib import Path

def cpu_list(s):
    out = set()
    for part in s.strip().split(','):
        a, sep, b = part.partition('-')
        out.update(range(int(a), int(b) + 1) if sep else [int(a)])
    return out

def topology(allowed, root=Path('/sys/devices/system/cpu')):
    rows = []
    for cpu in sorted(allowed):
        p = root / f'cpu{cpu}'
        core = tuple(sorted(cpu_list((p/'topology/thread_siblings_list').read_text())))
        caches = [d for d in (p/'cache').glob('index*') if (d/'level').read_text().strip() == '3']
        if not caches: raise ValueError(f'CPU {cpu} has no L3 topology')
        llc = tuple(sorted(cpu_list((caches[0]/'shared_cpu_list').read_text())))
        rows.append((cpu, core, llc))
    return rows

def plan(rows, vcpus):
    # vCPU 0 and 2..6 compute; vCPU 1 handles the second card. All seven get
    # distinct physical cores sharing one L3. Refill gets other physical cores
    # first, then their SMT siblings, never a compute/helper sibling.
    if vcpus < 8: raise ValueError('Shield placement needs at least eight vCPUs')
    groups = {}
    for cpu, core, llc in rows:
        groups.setdefault(llc, {}).setdefault(core, []).append(cpu)
    candidates = [(llc, cores) for llc, cores in groups.items() if len(cores) >= 7]
    for llc, cores in sorted(candidates):
        critical_cores = sorted(cores)[:7]
        critical = [min(cores[c]) for c in critical_cores]
        other = {}
        for cpu, core, _ in rows:
            if core not in critical_cores: other.setdefault(core, []).append(cpu)
        primary = [min(v) for _, v in sorted(other.items())]
        siblings = [c for _, v in sorted(other.items()) for c in sorted(v)[1:]]
        rest = primary + siblings
        if len(rest) >= vcpus - 7:
            return critical + rest[:vcpus-7]
    raise ValueError('not enough allowed physical cores in one L3 plus refill CPUs')

class QMP:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX); self.sock.settimeout(30)
        end = time.monotonic() + 30
        while True:
            try: self.sock.connect(str(path)); break
            except (FileNotFoundError, ConnectionRefusedError):
                if time.monotonic() >= end: raise
                time.sleep(.05)
        self.file = self.sock.makefile('rwb', buffering=0); self.seq = 0
        if 'QMP' not in json.loads(self.file.readline()): raise ValueError('invalid QMP greeting')
        self.call('qmp_capabilities')
    def call(self, execute):
        self.seq += 1
        self.file.write((json.dumps({'execute':execute,'id':self.seq})+'\n').encode())
        while True:
            msg = json.loads(self.file.readline())
            if msg.get('id') != self.seq: continue
            if 'error' in msg: raise ValueError(msg['error'])
            return msg['return']

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--qmp', type=Path, required=True); p.add_argument('--vcpus', type=int, required=True)
    p.add_argument('--out', type=Path, required=True); a = p.parse_args()
    q = QMP(a.qmp)
    if q.call('query-status')['running']: raise ValueError('guest must be paused before placement')
    rows = q.call('query-cpus-fast')
    if sorted(x['cpu-index'] for x in rows) != list(range(a.vcpus)): raise ValueError('unexpected vCPU indices')
    tids = [x['thread-id'] for x in sorted(rows, key=lambda x:x['cpu-index'])]
    if any(type(t) is not int or t <= 0 for t in tids) or len(set(tids)) != a.vcpus: raise ValueError('invalid vCPU thread IDs')
    allowed = set.intersection(*(os.sched_getaffinity(t) for t in tids))
    mapping = plan(topology(allowed), a.vcpus)
    for tid, cpu in zip(tids, mapping):
        os.sched_setaffinity(tid, {cpu})
        if os.sched_getaffinity(tid) != {cpu}: raise ValueError('vCPU affinity did not take effect')
    a.out.write_text(json.dumps({'vcpuToHostCpu':mapping,'threadIds':tids,'source':'host L3/core topology; scheduling only'},indent=2)+'\n')
    q.call('cont')
    if not q.call('query-status')['running']: raise ValueError('guest did not resume')

if __name__ == '__main__': main()
