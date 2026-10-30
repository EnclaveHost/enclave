#!/usr/bin/env python3
"""READ-ONLY diagnosis v2 for `base snapshot download` (reth 7134be3). Root runs it INSIDE the guest. No network,
no writes, no signals, no credentials (nothing reads TLS keys, environment or config secrets).

Supersedes the socket hints of download_diag.py. Sockets are NOT requests: reqwest 0.13.4 (h2 0.4.15 in base's
Cargo.lock; default features via bin/base) very likely negotiates HTTP/2, so one TCP connection can carry many
concurrent range requests. The guest's TCP also ends at QEMU user-mode networking (-netdev user), so guest socket
rtt/cwnd describe the guest<->QEMU hop, not the CDN path.

  pieces  --part FILE [--piece-mib 64] [--seconds 30]
      Two SEEK_DATA/SEEK_HOLE scans of the sparse .part (O_RDONLY, no data read), --seconds apart (1..120). Per 64 MiB
      piece: data bytes. Reports complete, growing (= concurrently written pieces, i.e. in-flight range requests for
      this archive), stalled partial pieces, per-growing-piece rate, and the projected piece time against the 120 s
      total request timeout. Caveat: allocation is not durable bytes (page cache); it shows write activity.
  parts   --cache DIR --manifest PINNED_MANIFEST
      For each *.part: apparent size == manifest archive size AND sparse => segmented path (set_len(total));
      apparent < manifest size => sequential append path. Stat only.
  journal < journalctl -u enclave-rpc-base-snapshot.service -o short-iso --no-pager [--since ...]
      Prints ONLY whitelisted messages from the reth source with whitelisted key=value fields. URLs are never printed.
"""
import argparse, json, os, re, sys, time

TIMEOUT_S = 120


def data_bytes_per_piece(path, piece, max_ranges=5_000_000):
    """{piece_index: data_bytes} via SEEK_DATA/SEEK_HOLE on an O_RDONLY fd (reads no file data)."""
    fd = os.open(path, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        out, off, n = {}, 0, 0
        while off < size:
            try:
                start = os.lseek(fd, off, os.SEEK_DATA)
            except OSError:                    # ENXIO: no more data
                break
            end = os.lseek(fd, start, os.SEEK_HOLE)
            n += 1
            if n > max_ranges:
                raise RuntimeError('too many data ranges; aborting (bounded)')
            s = start
            while s < end:
                k = s // piece
                e = min(end, (k + 1) * piece)
                out[k] = out.get(k, 0) + (e - s)
                s = e
            off = end
        return size, out
    finally:
        os.close(fd)


def piece_report(size, a, b, piece, dt):
    total = (size + piece - 1) // piece
    plen = lambda k: min(piece, size - k * piece)
    complete = sum(1 for k, v in b.items() if v >= plen(k))
    growing = {k: (v - a.get(k, 0)) / dt for k, v in b.items() if v > a.get(k, 0) and v < plen(k)}
    finished_in_window = [k for k, v in b.items() if v >= plen(k) and a.get(k, 0) < plen(k)]
    stalled = [k for k, v in b.items() if 0 < v < plen(k) and k not in growing]
    rates = sorted(growing.values())
    r = {'pieces': total, 'complete': complete, 'growing': len(growing), 'finishedInWindow': len(finished_in_window),
         'stalledPartial': len(stalled), 'dataBytes': sum(b.values()),
         'aggregateWriteBps': round((sum(b.values()) - sum(a.values())) / dt)}
    if rates:
        med = rates[len(rates) // 2]
        r.update(perPieceMinBps=round(rates[0]), perPieceMedianBps=round(med), perPieceMaxBps=round(rates[-1]),
                 projectedPieceSecondsAtMedian=round(piece / med, 1), timeoutMarginAtMedian=round(TIMEOUT_S / (piece / med), 2),
                 timeoutMarginAtMin=round(TIMEOUT_S / (piece / rates[0]), 2) if rates[0] > 0 else 0)
    r['note'] = ('growing = pieces whose allocated data increased in the window = concurrently written ranges; a piece '
                 'request is bounded by a 120 s TOTAL timeout (3 attempts, then the whole archive restarts from scratch)')
    return r


def cmd_pieces(a):
    piece = a.piece_mib * 1024 * 1024
    t0 = time.monotonic(); size, s0 = data_bytes_per_piece(a.part, piece)
    time.sleep(a.seconds)
    t1 = time.monotonic(); size1, s1 = data_bytes_per_piece(a.part, piece)
    if size1 != size:
        print(json.dumps({'error': 'apparent size changed between scans (file replaced or path not segmented)',
                          'before': size, 'after': size1}))
        return 3
    print(json.dumps(dict(piece_report(size, s0, s1, piece, t1 - t0), part=os.path.basename(a.part), apparent=size),
                     indent=1, sort_keys=True))
    return 0


def manifest_sizes(path):
    m = json.load(open(path))
    sizes = {}
    for comp in m.get('components', {}).values():
        if 'file' in comp:
            sizes[os.path.basename(comp['file'])] = comp['size']
        for f, s in zip(comp.get('chunk_files', []), comp.get('chunk_sizes', [])):
            sizes[os.path.basename(f)] = s
    return sizes


def cmd_parts(a):
    sizes = manifest_sizes(a.manifest)
    out = {}
    for n in sorted(os.listdir(a.cache)):
        if not n.endswith('.part'):
            continue
        st = os.stat(os.path.join(a.cache, n))
        want = sizes.get(n[:-5])
        alloc = st.st_blocks * 512
        path = ('segmented (set_len to the full archive size, sparse)' if want is not None and st.st_size == want
                else 'sequential append' if want is not None and st.st_size < want else 'unknown (not in manifest)')
        out[n] = {'apparent': st.st_size, 'allocated': alloc, 'manifestSize': want, 'path': path}
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


MESSAGES = ('Starting queued segmented download', 'Server does not support Range requests',
            'Archive attempt failed, retrying from scratch', 'Parallel download failed', 'Retry attempt',
            'Download complete', 'Using local archive', 'output verification failed', 'Startup integrity summary',
            'Downloading all archives')
FIELDS = ('file', 'component', 'attempt', 'pieces', 'workers', 'max_concurrent_requests', 'piece_size', 'total_size',
          'reusable', 'needs_download', 'archives', 'download_total', 'output_total')


def cmd_journal(_a):
    for line in sys.stdin:
        msg = next((m for m in MESSAGES if m in line), None)
        if not msg:
            continue
        ts = line.split(' ', 1)[0] if re.match(r'^\d{4}-\d\d-\d\dT', line) else ''
        kv = {k: v.strip('"') for k, v in re.findall(r'\b(' + '|'.join(FIELDS) + r')=("[^"]*"|\S+)', line)}
        kv = {k: v for k, v in kv.items() if '://' not in v and len(v) <= 120}     # never print URLs
        print(json.dumps({'ts': ts, 'message': msg, **kv}, sort_keys=True))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pieces'); p.add_argument('--part', required=True); p.add_argument('--piece-mib', type=int, default=64)
    p.add_argument('--seconds', type=float, default=30)
    q = sub.add_parser('parts'); q.add_argument('--cache', required=True); q.add_argument('--manifest', required=True)
    sub.add_parser('journal')
    a = ap.parse_args(argv)
    if a.cmd == 'pieces' and not 1 <= a.seconds <= 120:
        ap.error('--seconds must be 1..120')
    return {'pieces': cmd_pieces, 'parts': cmd_parts, 'journal': cmd_journal}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
