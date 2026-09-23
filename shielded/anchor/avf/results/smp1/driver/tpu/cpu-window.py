#!/usr/bin/env python3
"""cpu-window.py <samples> <capture.log> [--hz 100] [--app host.enclave.anchor.avf] -- the CPU the app's processes spent inside
each turn's window, with its coverage stated.

<samples> is cpu-sampler.sh's output: "T <uptime s>", the /proc/stat cpu line, and one "P <pid> <ppid> <name> | <stat>" row
per process of the app's uid. <capture.log> is the app's capture, whose "LOCAL turn N window boottime_ms start= first= end="
lines bound each turn on the same clock (CLOCK_BOOTTIME), and whose STATS give decode_tokens.

What is counted, and what earlier figures got wrong (lane-run2's first CPU line, 45b96836):
  * OWNERSHIP by parentage, not by name: the app process, its children, their children (the app -> virtmgr -> crosvm
    chain), read from each stat line's own ppid. The first version matched a process named exactly "crosvm", and this
    VM's is "crosvm_anchorlocal" -- the whole VM was left out.
  * IDENTITY is (pid, start time), so a reused pid is a different process.
  * A process that EXITS inside the window keeps the CPU it had at its last sample; it is not dropped (the first version
    counted only processes present in both of two samples). What it spent after that last sample is unobserved, and the
    window is marked INCOMPLETE with the length of that gap.
  * The window's edges are interpolated between the samples that bracket them; the CPU spent in those two bracketing
    intervals bounds the interpolation error and is reported.
  * INCOMPLETE also when: a stat read failed for an owned process, the window starts before the first sample or ends after
    the last, a process was already running before its first sample inside the window, or a bracketing interval is longer
    than --max-gap. An INCOMPLETE figure is printed as a lower bound and never as a measurement.
Device-wide busy time from /proc/stat over the same window is printed beside it, as context: it includes everything else
running on the phone.
"""
import argparse, re, sys


SCANS = []   # (start, end, ok) of each background discovery scan, from "D <start> <end> ok|FAILED <n>" lines


def parse_samples(path):
    samples = []; cur = None; SCANS.clear()
    for line in open(path, errors='replace'):
        line = line.rstrip('\n')
        if line.startswith('D '):
            f = line.split()
            ok = len(f) >= 5 and f[3] == 'ok' and f[4].isdigit() and int(f[4]) > 1
            SCANS.append((float(f[1]), float(f[2]), ok)); continue
        if line.startswith('T '):
            cur = dict(t=float(line.split()[1]), cpu=None, procs={}, gone=[], ps=None); samples.append(cur)
        elif line.startswith('cpu ') and cur is not None:
            f = [int(x) for x in line.split()[1:]]
            # user nice system idle iowait irq softirq steal [guest guest_nice]: guest time is ALREADY inside user/nice,
            # so it is not added again (summing all ten counted the VM's vCPUs twice: "10.31 cores busy" on 8 cores)
            cur['cpu'] = (sum(f[:8]), f[3] + (f[4] if len(f) > 4 else 0))     # total, idle + iowait
        elif line.startswith('PS ') and cur is not None:
            f = line.split()
            if f[1] == 'ok' and len(f) > 2 and f[2].isdigit() and int(f[2]) > 1: cur['ps'] = 'ok'          # a full table scan
            elif f[1] == 'known' and len(f) > 2 and f[2].isdigit(): cur['ps'] = 'known'                    # the last scan's pids only
            else: cur['ps'] = 'failed'
        elif line.startswith('P ') and cur is not None:
            head, _, stat = line.partition(' | ')
            _, pid, _ppid, name = head.split(None, 3)
            if stat.strip() == 'GONE' or ') ' not in stat:
                cur['gone'].append((int(pid), name)); continue
            comm = stat[stat.index('(') + 1:stat.rindex(')')]
            f = stat[stat.rindex(')') + 2:].split()
            # f[0]=state f[1]=ppid ... utime=f[11] stime=f[12] starttime=f[19]
            cur['procs'][(int(pid), int(f[19]))] = dict(ppid=int(f[1]), name=name, comm=comm, ticks=int(f[11]) + int(f[12]),
                                                        reaped=int(f[13]) + int(f[14]))                  # cutime + cstime
    return samples


def owned(sample, app, roots):
    """identities in this sample that are the app or descend from it (by the stat line's own ppid)"""
    ids = {k for k, v in sample['procs'].items() if v['name'] == app and v['comm'] == app[-15:]}   # the kernel keeps the last 15 characters
    roots |= {k[0] for k in ids}
    pids = {k[0] for k in ids}
    changed = True
    while changed:
        changed = False
        for k, v in sample['procs'].items():
            if k not in ids and v['ppid'] in pids:
                ids.add(k); pids.add(k[0]); changed = True
    return ids


def interp(t, pts):
    """value at time t from (time, value) points sorted by time, linear inside, None outside"""
    if not pts or t < pts[0][0] or t > pts[-1][0]: return None
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def window_cpu(samples, a, b, app, hz, max_gap, scan_gap=3.0):
    notes = []; ts = [s['t'] for s in samples]
    if not samples or a < ts[0] or b > ts[-1]:
        return None, ['the window is not inside the sampled interval']
    for edge, name in ((a, 'start'), (b, 'end')):
        i = max(k for k, t in enumerate(ts) if t <= edge); j = min(k for k, t in enumerate(ts) if t >= edge)
        if ts[j] - ts[i] > max_gap: notes.append(f'the samples around the window {name} are {ts[j] - ts[i]:.2f} s apart (> {max_gap})')
    # Coverage of the process table itself: every sample that bears on the window must say its enumeration succeeded.
    near = [s for s in samples if a - max_gap <= s['t'] <= b + max_gap]
    bad = [s for s in near if s['ps'] not in ('ok', 'known')]
    if bad:
        notes.append(f"the process table was not recorded or not read in {len(bad)} of {len(near)} samples around the window "
                     f"(first at {bad[0]['t']:.2f}: {'no PS line' if bad[0]['ps'] is None else 'PS FAILED'})")
    # a KNOWN sample only re-reads the pids of the last full scan, so a process that appears between scans is seen at
    # the next one; the scans themselves must be frequent enough around and through the window
    scans = sorted([s['t'] for s in samples if s['ps'] == 'ok'] + [t0 for t0, t1, ok in SCANS if ok])
    failed = [t0 for t0, t1, ok in SCANS if not ok and a - scan_gap <= t0 <= b + scan_gap]
    if failed: notes.append(f'{len(failed)} discovery scan(s) around the window failed (first at {failed[0]:.2f})')
    before = [t for t in scans if t <= a]; inside = [t for t in scans if a < t < b]; after = [t for t in scans if t >= b]
    if not before or not after:
        notes.append('no full process-table scan before the window start or after its end')
    else:
        pts = [before[-1]] + inside + [after[0]]
        worst = max(t1 - t0 for t0, t1 in zip(pts, pts[1:]))
        if worst > scan_gap: notes.append(f'full process-table scans were up to {worst:.2f} s apart through the window (> {scan_gap})')
    roots = set(); series = {}; names = {}; reaped = {}
    for s in samples:
        own = owned(s, app, roots)
        for k in own:
            series.setdefault(k, []).append((s['t'], s['procs'][k]['ticks'])); names[k] = s['procs'][k]['name']
            reaped.setdefault(k, []).append((s['t'], s['procs'][k]['reaped']))
        in_window = a <= s['t'] <= b
        for pid, name in s['gone']:
            if in_window and (name == app or any(k[0] == pid for k in series)):
                notes.append(f'a stat read failed for {name} (pid {pid}) at {s["t"]:.2f}')
    # Evidence of the expected identities, not just the absence of contrary evidence: the app itself and a VM process
    # descended from it must have been seen inside the window, and no VM-type process of the uid may be left unowned.
    seen = {k for k, pts in series.items() if any(a <= t <= b for t, _ in pts)}
    if not seen:
        return None, notes + ['no process of the app was observed inside the window (nothing to measure is not zero CPU)']
    if not any(names[k] == app for k in seen):
        notes.append('the app process itself was not observed inside the window')
    if not any(names[k].startswith('crosvm') for k in seen):
        notes.append('no VM process (crosvm) descended from the app was observed inside the window')
    for s in near:
        own_pids = {k[0] for k in series if any(t == s['t'] for t, _ in series[k])}
        for k, v in s['procs'].items():
            if (v['name'].startswith('crosvm') or v['name'].startswith('virtmgr')) and k[0] not in own_pids:
                notes.append(f"{v['name']} (pid {k[0]}, parent {v['ppid']}) belongs to the app's uid but not to its process tree: ownership unresolved")
    total = 0.0; edge_err = 0.0; per = {}
    for k, pts in series.items():
        first_t, last_t = pts[0][0], pts[-1][0]
        if last_t < a or first_t > b: continue
        start_s = k[1] / hz                                           # the process's own start time, seconds since boot
        if first_t > a:
            if start_s < a:     # it existed when the window opened, but no sample saw it there
                notes.append(f'{names[k]} (pid {k[0]}) was running before its first sample at {first_t:.2f}; its CPU before that is unobserved')
                va = pts[0][1]
            else:               # it started inside the window: everything it has spent is inside the window
                va = 0.0
        else:
            va = interp(a, pts)
        if last_t < b:
            nxt = min((t for t in ts if t > last_t), default=None)
            notes.append(f'{names[k]} (pid {k[0]}) exited inside the window; up to {(nxt - last_t) if nxt else 0:.2f} s after its last sample is unobserved')
            vb = pts[-1][1]
        else:
            vb = interp(b, pts)
        d = (vb - va) / hz; total += d; per[names[k]] = per.get(names[k], 0.0) + d
        # a child that lived and died between two scans is invisible to the samples, but its parent's cutime/cstime
        # (children it reaped) grows: then some owned CPU was never observed
        rp = [(t, v) for t, v in reaped[k] if a - max_gap <= t <= b + max_gap]
        if rp and rp[-1][1] > rp[0][1]:
            notes.append(f'{names[k]} (pid {k[0]}) reaped children using {(rp[-1][1] - rp[0][1]) / hz:.2f} core-s around the window; '
                         'a process that lived between scans was not observed')
        for edge in (a, b):   # the CPU in the interval bracketing each edge bounds the interpolation error
            for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
                if t0 <= edge <= t1: edge_err += (v1 - v0) / hz
    dev = [(s['t'], s['cpu']) for s in samples if s['cpu']]
    dt_a, dt_b = interp(a, [(t, c[0]) for t, c in dev]), interp(b, [(t, c[0]) for t, c in dev])
    di_a, di_b = interp(a, [(t, c[1]) for t, c in dev]), interp(b, [(t, c[1]) for t, c in dev])
    device = ((dt_b - dt_a) - (di_b - di_a)) / hz if None not in (dt_a, dt_b, di_a, di_b) else None
    return dict(core_s=total, per=per, edge_err=edge_err, device_core_s=device, seconds=b - a), notes


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('samples'); ap.add_argument('capture')
    ap.add_argument('--hz', type=int, default=100); ap.add_argument('--app', default='host.enclave.anchor.avf')
    ap.add_argument('--max-gap', type=float, default=1.0); ap.add_argument('--scan-gap', type=float, default=3.0)
    A = ap.parse_args()
    samples = parse_samples(A.samples); cap = open(A.capture, errors='replace').read()
    wins = re.findall(r'LOCAL turn (\d+) window boottime_ms start=(\d+) first=(-?\d+) end=(\d+)', cap)
    stats = dict(re.findall(r'LOCAL turn (\d+) STATS \{[^}]*decode_tokens=(\d+)', cap))
    if not wins: print('cpu: UNMEASURED -- the capture has no turn window lines (an APK older than cpu-window.py)'); return 1
    rc = 0
    for n, s0, f0, e0 in wins:
        toks = int(stats.get(n, 0)); a = (int(f0) if int(f0) >= 0 else int(s0)) / 1000.0; b = int(e0) / 1000.0
        r, notes = window_cpu(samples, a, b, A.app, A.hz, A.max_gap, A.scan_gap)
        if r is None:
            print(f'cpu turn {n}: UNMEASURED -- ' + '; '.join(notes)); rc = 1; continue
        state = 'COMPLETE' if not notes else 'INCOMPLETE (a lower bound)'
        per = ', '.join(f'{k} {v:.2f}' for k, v in sorted(r['per'].items(), key=lambda x: -x[1]))
        dev = f"{r['device_core_s'] / r['seconds']:.2f} cores busy device-wide" if r['device_core_s'] is not None else 'device-wide unmeasured'
        ms_tok = f"{1000 * r['core_s'] / toks:.0f} core-ms per decoded token" if toks else 'no decoded tokens'
        print(f"cpu turn {n} decode window {r['seconds']:.2f} s ({toks} tokens): {state}: the app's processes {r['core_s']:.2f} core-s "
              f"= {r['core_s'] / r['seconds']:.2f} cores busy, {ms_tok} (edge interpolation +-{r['edge_err']:.2f} core-s) [{per}] | {dev}")
        for x in notes: print(f'  coverage: {x}')
        if notes: rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main())
