#!/usr/bin/env python3
"""READ-ONLY diagnostic for the running `base snapshot download` (reth 7134be3 downloader). Root runs it INSIDE the guest.

  python3 -I download_diag.py --pid PID --datadir /srv/enclave-base-holder/data [--iface IFACE] [--disk DEV] [--seconds 30]

It sends nothing on the network, writes nothing, and signals nothing. It takes two samples `--seconds` apart (max 120) of:
  - ss -tinH (established TCP, this PID only): connection count, per-socket bytes_received delta, rtt, cwnd, delivery_rate;
  - /proc/PID/io rchar/wchar (syscall-level read/write volume);
  - /proc/net/dev rx bytes on IFACE (whole-link receive rate);
  - <datadir>/.download-cache/*.part allocated bytes (st_blocks) and apparent size;
  - /proc/diskstats io_ticks for DEV (busy fraction).
It prints one JSON report. The hints are heuristics for root's decision, NOT a measurement of the remote.
CORRECTION (after root's 19:14 run): socket stats are NOT request stats. The pinned client links h2 (HTTP/2), so one
TCP socket can carry many concurrent range requests, and guest sockets end at QEMU user networking. Per-socket
'pieceTimeoutMargin' is therefore an UPPER bound only. Use download_diag2.py `pieces` for request-level evidence.
"""
import argparse, json, os, re, subprocess, sys, time

PIECE = 64 * 1024 * 1024        # reth SEGMENTED_DOWNLOAD_LARGE_PIECE_SIZE (archives >= 2 GiB)
PIECE_TIMEOUT_S = 120           # reth SEGMENTED_DOWNLOAD_REQUEST_TIMEOUT_SECS (total per request)


def sockets(pid, ss_text):
    """Parse `ss -tinpH state established` output: {(local,peer): {...}} for sockets owned by pid."""
    out, cur = {}, None
    for line in ss_text.splitlines():
        if line and not line[0].isspace():
            parts = line.split()
            cur = None
            if f'pid={pid},' in line and len(parts) >= 4:
                cur = (parts[2], parts[3])
                out[cur] = {}
        elif cur is not None:
            m = re.search(r'bytes_received:(\d+)', line)
            if m:
                out[cur]['bytes_received'] = int(m.group(1))
            for k in ('rtt', 'cwnd', 'delivery_rate'):
                m = re.search(rf'\b{k}:([0-9.]+)(\S*)', line)
                if m:
                    out[cur][k] = m.group(1) + m.group(2)
    return out


def proc_io(proc, pid):
    d = {}
    with open(f'{proc}/{pid}/io') as f:
        for line in f:
            k, v = line.split(':')
            d[k.strip()] = int(v)
    return d


def net_rx(proc, iface):
    if not iface:
        return None
    with open(f'{proc}/net/dev') as f:
        for line in f:
            if line.strip().startswith(iface + ':'):
                return int(line.split(':', 1)[1].split()[0])
    return None


def disk_ticks(proc, dev):
    if not dev:
        return None
    with open(f'{proc}/diskstats') as f:
        for line in f:
            p = line.split()
            if len(p) > 12 and p[2] == dev:
                return int(p[12])
    return None


def parts(datadir):
    c = os.path.join(datadir, '.download-cache')
    out = {}
    if os.path.isdir(c):
        for n in sorted(os.listdir(c)):
            if n.endswith('.part'):
                st = os.stat(os.path.join(c, n))
                out[n] = {'apparent': st.st_size, 'allocated': st.st_blocks * 512}
    return out


def sample(a, run_ss):
    return {'t': time.monotonic(), 'ss': sockets(a.pid, run_ss()), 'io': proc_io(a.proc, a.pid),
            'rx': net_rx(a.proc, a.iface), 'disk': disk_ticks(a.proc, a.disk), 'parts': parts(a.datadir)}


def report(s0, s1, concurrency):
    dt = s1['t'] - s0['t']
    conns = []
    for k, v in s1['ss'].items():
        if 'bytes_received' in v and k in s0['ss'] and 'bytes_received' in s0['ss'][k]:
            rate = (v['bytes_received'] - s0['ss'][k]['bytes_received']) / dt
            conns.append({'peer': k[1], 'rateBps': round(rate), 'rtt': v.get('rtt'), 'cwnd': v.get('cwnd'),
                          'delivery_rate': v.get('delivery_rate')})
    rates = sorted(c['rateBps'] for c in conns)
    agg = sum(rates)
    per = (agg / len(rates)) if rates else 0
    r = {
        'seconds': round(dt, 1),
        'connections': {'established': len(s1['ss']), 'persistedBothSamples': len(conns), 'concurrencyFlag': concurrency,
                        'aggregateRxBps': round(agg), 'perConnMeanBps': round(per),
                        'perConnMinBps': rates[0] if rates else None, 'perConnMaxBps': rates[-1] if rates else None},
        'processIo': {k + 'Bps': round((s1['io'][k] - s0['io'][k]) / dt) for k in ('rchar', 'wchar')},
        'linkRxBps': round((s1['rx'] - s0['rx']) / dt) if s0['rx'] is not None and s1['rx'] is not None else None,
        'diskBusyFraction': round((s1['disk'] - s0['disk']) / (dt * 1000), 3) if s0['disk'] is not None and s1['disk'] is not None else None,
        'parts': {n: dict(v, allocatedDeltaBps=round((v['allocated'] - s0['parts'].get(n, v)['allocated']) / dt))
                  for n, v in s1['parts'].items()},
        'connectionsDetail': conns,
    }
    hints = []
    if per > 0:
        piece_s = PIECE / per
        r['pieceSecondsAtMeanRate'] = round(piece_s, 1)
        r['pieceTimeoutMargin'] = round(PIECE_TIMEOUT_S / piece_s, 2)
        r['pieceTimeoutMarginNote'] = ('per SOCKET, assuming one request per socket: an upper bound; with HTTP/2 '
                                       'N streams share it, so divide by the number of concurrent pieces')
        if PIECE_TIMEOUT_S / piece_s < 2:
            hints.append('TIMEOUT MARGIN < 2x: slower per-connection throughput (e.g. from more concurrency on a saturated '
                         'link) can make 64 MiB pieces exceed the 120 s total timeout; 3 failures delete the .part and '
                         'restart the WHOLE archive from scratch.')
    if r['diskBusyFraction'] is not None and r['diskBusyFraction'] > 0.8:
        hints.append('disk busy > 80%: storage, not network, limits; more connections will not help')
    if len(conns) < concurrency:
        hints.append(f'{len(conns)} TCP socket(s) for --download-concurrency {concurrency}: socket count is NOT a request '
                     'count (HTTP/2 multiplexes streams on one socket); this says nothing about request limiting')
    elif rates and rates[-1] <= 1.5 * rates[0]:
        hints.append('uniform per-socket rates: if each socket carries one request, consistent with a per-connection cap; '
                     'otherwise inconclusive. Never change concurrency on socket stats alone')
    r['hints'] = hints
    return r


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, required=True)
    ap.add_argument('--datadir', required=True)
    ap.add_argument('--iface')
    ap.add_argument('--disk')
    ap.add_argument('--seconds', type=float, default=30)
    ap.add_argument('--concurrency', type=int, default=16)
    ap.add_argument('--proc', default='/proc')
    ap.add_argument('--ss-file', nargs=2, help=argparse.SUPPRESS)     # tests: two captured ss outputs
    a = ap.parse_args(argv)
    if not 1 <= a.seconds <= 120:
        ap.error('--seconds must be 1..120')
    if a.ss_file:
        texts = iter([open(p).read() for p in a.ss_file])
        run_ss = lambda: next(texts)
    else:
        run_ss = lambda: subprocess.run(['ss', '-tinpH', 'state', 'established'], capture_output=True, text=True,
                                        timeout=20, check=True).stdout
    s0 = sample(a, run_ss)
    time.sleep(a.seconds)
    s1 = sample(a, run_ss)
    print(json.dumps(report(s0, s1, a.concurrency), indent=1, sort_keys=True))


if __name__ == '__main__':
    main()
