#!/usr/bin/python3 -I
"""postrestore-recovery-stage/r1: READ-ONLY unit/mask inventory of the STOPPED enclave-rpc-production OS disk (root runs).

Reuses the FROZEN, qualified rpc-memory-recovery-stage/r1/inspect_os_disk.py unchanged: its bytes are read once, checked
against FROZEN_SHA256 (its SHA256SUMS line), compiled in memory and executed as a private module (no sys.path entry, no
bytecode cache, nothing imported from another stage by name). Its main() keeps every refusal and the whole lifecycle (VM +
guard inactive, OS qcow2 not open, nbdfuse -r [qemu-nbd -r], debugfs -c, unmount + wait); only that private module's
`inspect` is wrapped so the record body is the frozen body PLUS `unitInventory`:
  * every entry whose name contains "enclave" in /etc/systemd/system, /usr/lib/systemd/system and /lib/systemd/system:
    unit files, symlinks (+ target), NAME.d drop-in dirs, the type-wide drop-in dirs (service.d, path.d, ...), and the
    "enclave" entries of every *.wants / *.requires / *.upholds dir in those three dirs;
  * masks in both systemd forms (symlink to /dev/null, zero-byte unit file), also per drop-in;
  * activation: .path/.timer/.socket units and the unit each triggers (Unit= or the same name), the links enabling them,
    and Wants/Requires/BindsTo/Upholds lines of the enclave units;
  * every debugfs error is reported in readErrors; with any error a verdict is "unknown" unless positively proven
    (a mask or a link that WAS read). A .wants link never implies "not masked".
Only unit files and drop-ins are read; only their sha256/size and whitelisted directive lines are reported (no Environment=,
no EnvironmentFile contents, no seed/key files). Output/exit codes are the frozen tool's (record on stdout; 0 / 2 refused).
"""
import hashlib, json, re, subprocess, sys, types

FROZEN = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-memory-recovery-stage/r1/inspect_os_disk.py'
FROZEN_SHA256 = '287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531'
FORMAT = 'enclave-rpc-os-unit-inventory/r1'
UNIT_DIRS = ('/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system')     # precedence order
LINK_DIR = re.compile(r'\.(wants|requires|upholds)$')
TYPE_DROPINS = ('service.d', 'path.d', 'timer.d', 'socket.d', 'mount.d', 'target.d')
UNIT_SUFFIX = ('.service', '.path', '.timer', '.socket', '.mount', '.automount', '.target')
TRIGGERS = ('.path', '.timer', '.socket')
KEEP = re.compile(r'^(Unit|Path\w+|On\w+|Persistent|ListenStream|ListenDatagram|Wants|Requires|Requisite|BindsTo|PartOf|'
                  r'Upholds|WantedBy|RequiredBy|UpheldBy|Also|Alias|Condition\w+|Assert\w+|RequiresMountsFor|ExecCondition|'
                  r'ExecStartPre|ExecStart|DefaultDependencies)=')
NOISE = re.compile(r'^(debugfs \d\S* \(.*\)|catastrophic mode - not reading inode or group bitmaps)$')
S_IFMT, S_IFLNK, S_IFDIR, S_IFREG = 0o170000, 0o120000, 0o040000, 0o100000


class PinError(Exception):
    pass


def load_pinned(path, sha, name):
    """execute exactly the pinned bytes as a private module (the file is read once; no import machinery, no .pyc)"""
    with open(path, 'rb') as f:
        src = f.read()
    if hashlib.sha256(src).hexdigest() != sha:
        raise PinError(f'{path} sha256 {hashlib.sha256(src).hexdigest()} is not the pinned {sha}')
    mod = types.ModuleType(name)
    mod.__file__ = path
    exec(compile(src, path, 'exec'), mod.__dict__)
    return mod


def dbg(dev, request, run):
    """-> (stdout bytes, error text or ''); debugfs reports most failures on stderr with rc 0"""
    r = run(['debugfs', '-c', '-R', request, dev], capture_output=True, timeout=60)
    err = [l.strip() for l in (r.stderr or b'').decode('utf-8', 'replace').splitlines() if l.strip() and not NOISE.match(l.strip())]
    if r.returncode:
        err.append(f'debugfs rc {r.returncode}')
    return r.stdout or b'', '; '.join(err)


def absent(err):
    return 'File not found by ext2_lookup' in err


def directives(text):
    return [l.strip() for l in text.splitlines() if KEEP.match(l.strip())]


def link_target(dev, path, run, errors):
    out, err = dbg(dev, f'stat {path}', run)
    text = out.decode('utf-8', 'replace')
    if m := re.search(r'Fast link dest: "([^"]*)"', text):
        return m.group(1)
    if not err and 'Type: symlink' in text:              # slow symlink: the target is the inode's data
        data, err = dbg(dev, f'cat {path}', run)
        if not err and 0 < len(data) < 4096 and b'\0' not in data:
            return data.decode('utf-8', 'replace')
    errors.append(f'{path}: symlink target unreadable ({err or "no link dest"})')
    return None


def entry(dev, path, mode, run, errors, frozen, depth=0):
    kind = mode & S_IFMT
    if kind == S_IFLNK:
        t = link_target(dev, path, run, errors)
        return {'type': 'symlink', 'target': t, 'masked': None if t is None else t == '/dev/null'}
    if kind == S_IFREG:
        data, err = dbg(dev, f'cat {path}', run)
        if err:
            errors.append(f'{path}: {err}')
            return {'type': 'file', 'error': err, 'masked': None}
        return {'type': 'file', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'masked': len(data) == 0,
                'directives': directives(data.decode('utf-8', 'replace'))}
    if kind == S_IFDIR and depth == 0:
        es, err = listing(dev, path, run, frozen)
        if es is None:
            errors.append(f'{path}: {err}')
            return {'type': 'dir', 'error': err}
        return {'type': 'dir', 'entries': {e['name']: entry(dev, f'{path}/{e["name"]}', e['mode'], run, errors, frozen, 1) for e in es}}
    return {'type': oct(kind)}


def listing(dev, path, run, frozen):
    out, err = dbg(dev, f'ls -p {path}', run)
    if err:
        return None, err
    return frozen.parse_ls_p(out.decode('utf-8', 'replace')), ''


def scan(dev, run, frozen):
    dirs, errors = {}, []
    for d in UNIT_DIRS:
        es, err = listing(dev, d, run, frozen)
        if es is None:
            dirs[d] = {'status': 'absent' if absent(err) else 'error', 'error': err}
            if not absent(err):
                errors.append(f'{d}: {err}')
            continue
        rec = dirs[d] = {'status': 'ok', 'entries': {}, 'links': {}}
        for e in es:
            n, p = e['name'], f'{d}/{e["name"]}'
            if LINK_DIR.search(n) and (e['mode'] & S_IFMT) == S_IFDIR:
                sub, serr = listing(dev, p, run, frozen)
                if sub is None:
                    errors.append(f'{p}: {serr}')
                    rec['links'][n] = {'error': serr}
                    continue
                for s in sub:
                    if 'enclave' in s['name']:
                        rec['links'][f'{n}/{s["name"]}'] = entry(dev, f'{p}/{s["name"]}', s['mode'], run, errors, frozen, 1)
            elif 'enclave' in n or n in TYPE_DROPINS:
                rec['entries'][n] = entry(dev, p, e['mode'], run, errors, frozen)
    return dirs, errors


def summarize(dirs, errors, watch):
    ok = [d for d in UNIT_DIRS if dirs[d]['status'] == 'ok']
    names = set(watch) | {n for d in ok for n in dirs[d]['entries'] if n.endswith(UNIT_SUFFIX)}
    unknown = bool(errors)
    units = {}
    for u in sorted(names):
        layers = [(d, dirs[d]['entries'][u]) for d in ok if u in dirs[d]['entries']]
        top = layers[0][1] if layers else None              # /etc wins over /usr/lib (/run is empty on a stopped disk)
        masked = True if top and top.get('masked') else 'unknown' if unknown or (top and top.get('masked') is None) else False
        links = sorted(f'{d}/{k}' for d in ok for k, v in dirs[d]['links'].items() if k.rsplit('/', 1)[-1] == u and 'error' not in v)
        drops = {f'{d}/{u}.d': dirs[d]['entries'][f'{u}.d'] for d in ok if f'{u}.d' in dirs[d]['entries']}
        unit_name = next((l.split('=', 1)[1].strip() for l in (top or {}).get('directives', []) if l.startswith('Unit=')), None)
        units[u] = {'fragment': layers[0][0] + '/' + u if layers else None, 'layers': [d for d, _ in layers], 'masked': masked,
                    'enabledBy': links, 'dropIns': drops,
                    'triggers': (unit_name or u.rsplit('.', 1)[0] + '.service') if u.endswith(TRIGGERS) else None,
                    'pulls': [l for l in (top or {}).get('directives', []) if l.startswith(('Wants=', 'Requires=', 'BindsTo=', 'Upholds='))]}
    for u, s in units.items():
        s['triggeredBy'] = [{'unit': t, 'masked': v['masked'], 'enabledBy': v['enabledBy']} for t, v in units.items() if v['triggers'] == u]
        s['pulledBy'] = [t for t, v in units.items() if any(u in l.split('=', 1)[1].split() for l in v['pulls'])]
    for u, s in units.items():
        if s['masked'] is True:
            s['bootLinked'] = 'masked'
        elif s['masked'] == 'unknown':
            s['bootLinked'] = 'unknown'
        elif s['enabledBy'] or s['pulledBy'] or any(t['enabledBy'] and t['masked'] is False for t in s['triggeredBy']):
            s['bootLinked'] = 'linked'
        else:
            s['bootLinked'] = 'unknown' if unknown else 'not-linked'
    return units


def inventory(dev, run, frozen):
    dirs, errors = scan(dev, run, frozen)
    return {'format': FORMAT, 'frozenInspectorSha256': FROZEN_SHA256, 'dirs': dirs, 'units': summarize(dirs, errors, frozen.WATCH),
            'readErrors': errors, 'complete': not errors,
            'limits': ['/run/systemd/system, generators, kernel-cmdline masks and non-enclave units pulling enclave units are '
                       'not evaluated', 'bootLinked=linked means a link/trigger/pull exists, not that the start would succeed']}


def extended(frozen):
    orig = frozen.inspect

    def inspect(dev, payload, run=subprocess.run):
        body = orig(dev, payload, run)
        body['unitInventory'] = inventory(dev, run, frozen)
        return body
    return inspect


def main(argv=None, run=subprocess.run):
    try:
        frozen = load_pinned(FROZEN, FROZEN_SHA256, 'inspect_os_disk_frozen')
    except (OSError, PinError) as e:
        print(json.dumps({'refused': str(e)}))
        return 2
    frozen.inspect = extended(frozen)
    return frozen.main(argv, run=run)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
