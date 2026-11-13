"""The guest's /memory reports over time: is the clients' anonymous memory still growing, and how much of what the
kernel takes from them do they read back?

python3 -I rpc/snp/memtrend.py DIR      DIR: memory-*.json, each one answer of the front's GET /memory (local name),
                                        and beside any of them health-*.json (GET /health) taken at the same time

Those are the two things a smaller guest is sized from (ops/rpc-snp-prod-r7/release-r14/README.md): anonymous memory
cannot be reclaimed in a guest with no swap, so its level is the floor; the rest of the clients' slice is page cache,
and the share of reclaimed pages that come back (workingset_refault_file against pgsteal, both counted since the
client started) says whether that cache is already smaller than what the client keeps reading. One line per report;
the rates are over the time since the report before it, and blank across a restart of the guest or a client. With a
health answer, the last columns are how many seconds the newest Ethereum and Base blocks were old at the report.
Below the table: the half-hourly samples of the clients' slice that the guest's probe keeps for 48 hours (memprobe.py),
from the newest report, so one report a day later still carries the day's curve.
"""
import json
from pathlib import Path
import sys
import time

GROUPS = ('clients', 'el', 'cl', 'base')
GIB = 1 << 30
PAGE = 4096


def rows(reports):
    """[{'at', 'total', 'anon': {group: bytes}, 'file': {..}, 'steal': {group: bytes/s or None}, 'refault': {..},
    'behind': {'l1': seconds, 'base': seconds} from the report's 'health' when it has one}]"""
    out, before = [], None
    for r in sorted(reports, key=lambda r: r['at']):
        stat = {g: r['groups'][g]['stat'] for g in GROUPS if g in r['groups']}
        row = {'at': r['at'], 'total': r['meminfo']['MemTotal'], 'current': r['groups']['clients']['current'],
               'anon': {g: s['anon'] for g, s in stat.items()}, 'file': {g: s['file'] for g, s in stat.items()},
               'steal': {}, 'refault': {}, 'logs': r.get('trees', {}).get('/var/log'),
               'behind': {k: r['at'] - v['headTimestamp'] for k, v in r.get('health', {}).items() if 'headTimestamp' in v}}
        for g, s in stat.items():
            was = before and before['groups'].get(g, {}).get('stat')
            took = was and [s[k] - was[k] for k in ('pgsteal', 'workingset_refault_file')]
            ok = took and r['at'] > before['at'] and min(took) >= 0
            row['steal'][g], row['refault'][g] = [n * PAGE / (r['at'] - before['at']) for n in took] if ok else (None, None)
        out.append(row)
        before = r
    return out


def samples(report):
    """[(at, anon, file)] of the clients' slice from the probe's state in a report; none from before the clients ran"""
    return [(s[0], s[2], s[3]) for s in (report.get('probe') or {}).get('samples', []) if s[1] > 0]


def growth(points, hours=6):
    """GiB an hour over the last `hours` of [(at, bytes, ...)]; None when that spans less than an hour"""
    if not points:
        return None
    last = points[-1]
    first = next(p for p in points if p[0] >= last[0] - hours * 3600)
    span = last[0] - first[0]
    return (last[1] - first[1]) / GIB / (span / 3600) if span >= 3600 else None


def main(directory):
    reports = []
    for p in sorted(Path(directory).glob('memory-*.json')):
        health = p.with_name('health-' + p.name[len('memory-'):])
        reports.append({**json.loads(p.read_text()), **({'health': json.loads(health.read_text())} if health.exists() else {})})
    reports.sort(key=lambda r: r['at'])
    table = rows(reports)
    if not table:
        print('no memory-*.json in', directory)
        return 1
    rate = lambda v: '      -' if v is None else '%7.1f' % (v / 1e6)
    print('GiB, time Z     guest  slice | anon   all    el    cl  base | file   all  base | MB/s taken, read back: base, el    | logs MB | s behind: l1, base')
    for r in table:
        a, f = r['anon'], r['file']
        print('%s %6.2f %6.2f |      %5.2f %5.2f %5.2f %5.2f |      %5.2f %5.2f |   %s %s  %s %s | %7s | %s' % (
            time.strftime('%m-%d %H:%M:%S', time.gmtime(r['at'])), r['total'] / GIB, r['current'] / GIB,
            a['clients'] / GIB, a['el'] / GIB, a['cl'] / GIB, a['base'] / GIB, f['clients'] / GIB, f['base'] / GIB,
            rate(r['steal']['base']), rate(r['refault']['base']), rate(r['steal']['el']), rate(r['refault']['el']),
            '-' if r['logs'] is None else '%.0f' % (r['logs'] / 1e6),
            ', '.join('%d' % r['behind'][k] for k in ('l1', 'base') if k in r['behind']) or '-'))
    kept = samples(reports[-1]) if 'probe' in reports[-1] else []
    kept = [s for s in kept if s[0] >= max(r['at'] for r in table) - 48 * 3600]
    if kept:
        print("the probe's samples of the slice, anon / file GiB: " + '  '.join(
            '%s %.2f/%.2f' % (time.strftime('%H:%M', time.gmtime(at)), anon / GIB, file / GIB) for at, anon, file in kept))
    points = sorted(set([(at, anon) for at, anon, _ in kept] + [(r['at'], r['anon']['clients']) for r in table]))
    for hours in (2, 6, 24):
        g = growth(points, hours=hours) if points[-1][0] - points[0][0] >= hours * 3600 else None   # not a shorter record under a longer name
        if g is not None:
            print("the clients' anonymous memory over the last %d h on record: %+.2f GiB an hour" % (hours, g))
    return 0


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:]))
