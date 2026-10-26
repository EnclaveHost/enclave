#!/usr/bin/env python3
"""bootstrap-systemd-canary-stage (PREPARED; NOT run): renderer + probes of the guest systemd canary for the r13-final bootstrap units.
Everything runs in TRANSIENT units `enclave-sdcanary-<ID>-*` (systemd-run; no unit file written, no daemon-reload) over PRIVATE test
paths; the REVIEWED code executes from the uploaded, sha-verified r13-final bytes (holder_gate.py; the wrapper's _secure_path,
launch_lock, release_launch_lock, service_identity, drop_privileges, executed verbatim from their AST; finality_state.publish_status).
The only stand-ins are named MOCK (mock-permit). Nothing here reads the Base datadir, runs a node, or touches a production unit/path.

  render ID LIVE_UNIT_TXT DROPIN REPROOF_UNIT BUNDLE   -> JSON {unit: systemd-run argv} (the canary script runs exactly these)
  probe-holder CTX       root phase in the release-mode sandbox, then the wrapper's own drop + execve of probe-dropped
  probe-dropped CTX      rpcbase phase (after the reviewed drop): capabilities gone, private data writable, journal/root files not
  probe-runtime CTX      reproof sandbox: publish_status into the unit's RuntimeDirectory
  mock-permit CTX NAME MODE   MOCK of enclave-base-restart-permit (flaky: fails once then succeeds; fail: always fails); stamps time
  verdict CTX            evaluates the collected evidence -> verdict.json (exit 0 only if every REQUIRED check passed)"""
import ast, fcntl, importlib.util, json, os, pathlib, pwd, re, stat, sys, time, types

ID_RE = re.compile(r'^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$')
SANDBOX_KEYS = ('NoNewPrivileges', 'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'UMask', 'IPAddressDeny', 'LimitNOFILE', 'TasksMax',
                'MemorySwapMax', 'OOMScoreAdjust', 'KillMode', 'KillSignal')        # copied VERBATIM from the live holder unit
DROPIN_KEYS = ('User', 'Group', 'Environment', 'CapabilityBoundingSet', 'InaccessiblePaths')   # copied VERBATIM from the r13 drop-in
PROD_RW = {'/srv/enclave-base-holder/data': 'data', '/srv/enclave-base-holder/tmp': 'tmp',
           '/etc/enclave-rpc/base-bootstrap/journal': 'journal', '/etc/enclave-rpc/base-bootstrap/journal.lock': 'lock'}
CAPS = {'CAP_CHOWN': 0, 'CAP_DAC_OVERRIDE': 1, 'CAP_DAC_READ_SEARCH': 2, 'CAP_FOWNER': 3, 'CAP_SETGID': 6, 'CAP_SETUID': 7}
WRAPPER_DEFS = ('_secure_path', 'launch_lock', 'release_launch_lock', 'service_identity', 'drop_privileges')
WRAPPER_CONSTS = ('BOOTSTRAP_DIR', 'BASE_SERVICE_USER', 'HANDSHAKE_ENV', 'TRUSTED_TOP', 'ROOT_UID')
MEM = {'MemoryMax': '512M', 'MemoryHigh': '480M', 'CPUQuota': '100%'}
BUSY = ('active', 'activating', 'deactivating', 'reloading', 'refreshing')          # == the reviewed holder_gate.BUSY
NODES = {'dir': '/run/systemd/inaccessible/dir', 'reg': '/run/systemd/inaccessible/reg'}   # systemd's InaccessiblePaths mask nodes              # canary bound (production: 28G/25G)


def paths(i):
    if not ID_RE.match(i):
        raise SystemExit('bad id')
    return {'run': f'/run/enclave-sdcanary-{i}', 'etc': f'/etc/enclave-sdcanary-{i}', 'srv': f'/srv/enclave-sdcanary-{i}',
            'data': f'/srv/enclave-sdcanary-{i}/data', 'tmp': f'/srv/enclave-sdcanary-{i}/tmp', 'boot': f'/etc/enclave-sdcanary-{i}/base-bootstrap',
            'journal': f'/etc/enclave-sdcanary-{i}/base-bootstrap/journal', 'lock': f'/etc/enclave-sdcanary-{i}/base-bootstrap/journal.lock',
            'ro': f'/etc/enclave-sdcanary-{i}/ro', 'rt': f'enclave-sdcanary-{i}-rt', 'unit': f'enclave-sdcanary-{i}',
            'sentinels': [f'/srv/enclave-sdcanary-{i}/sentinel-dir', f'/srv/enclave-sdcanary-{i}/sentinel-file']}


def parse_unit(text):
    """`systemctl cat` / unit text -> {section: [(key, value)]} (comments and file banners ignored; order kept)"""
    out, sec = {}, None
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith(('#', ';')):
            continue
        if s.startswith('[') and s.endswith(']'):
            sec = s[1:-1]; out.setdefault(sec, []); continue
        k, _, v = s.partition('=')
        out.setdefault(sec, []).append((k.strip(), v.strip()))
    return out


def last(sec, key):
    vals = [v for k, v in sec if k == key]
    return vals[-1] if vals else None


def remap_rw(values, p):
    out = []
    for v in values:
        for x in v.split():
            if x not in PROD_RW:
                raise SystemExit(f'unexpected ReadWritePaths entry {x!r}: refusing to render (no production path may become writable)')
            out.append(p[PROD_RW[x]])
    return out


def render(i, live_text, dropin_text, reproof_text, bundle, py='/usr/bin/python3'):
    p = paths(i); live = parse_unit(live_text).get('Service', []); drop = parse_unit(dropin_text).get('Service', [])
    rep = parse_unit(reproof_text).get('Service', [])
    if last(live, 'User') != 'rpcbase' or last(drop, 'User') != 'root' or last(drop, 'Environment') != 'ENCLAVE_BASE_LAUNCH_HANDSHAKE=1':
        raise SystemExit('live unit / drop-in are not the reviewed holder (User rpcbase) + release-mode drop-in (root, handshake env)')
    me = f'{bundle}/canary/canary_units.py'; ctx = f'{p["run"]}/ctx.json'
    holder = [f'{k}={v}' for k in SANDBOX_KEYS for kk, v in live if kk == k]
    holder += [f'{k}={v}' for k in DROPIN_KEYS for kk, v in drop if kk == k]
    rw = remap_rw([v for k, v in live + drop if k == 'ReadWritePaths'], p)
    holder += [f'ReadWritePaths={" ".join(rw)}'] + [f'{k}={v}' for k, v in MEM.items()] + ['TimeoutStartSec=600']
    holder += [f'InaccessiblePaths={" ".join(p["sentinels"])}']        # r5: canary-owned POSITIVE controls, same directive, no "-": must exist
    for need in ('ProtectSystem=strict', 'NoNewPrivileges=yes', 'PrivateTmp=yes'):
        if need not in holder:
            raise SystemExit(f'live holder unit lacks {need}: refusing (the canary would not test the production sandbox)')
    gate = f'{bundle}/bootstrap/holder_gate.py'
    run = lambda name, props, argv, extra=(): ['systemd-run', '--quiet', f'--unit={p["unit"]}-{name}', '--service-type=oneshot', *extra,
                                               *[a for x in props for a in ('-p', x)], '--', *argv]
    units = {
        'busy': run('busy', holder + [f'ExecCondition={py} -I -B {gate} datadir-idle'], ['/usr/bin/touch', f'{p["data"]}/busy-start-ran'], ['--wait']),
        'permit': run('permit', ['RemainAfterExit=no', 'MemoryMax=64M'], [py, '-I', '-B', me, 'mock-permit', ctx, 'permit', 'flaky'], ['--wait']),
        'holder': run('holder', holder + [f'Requires={p["unit"]}-permit.service', f'After={p["unit"]}-permit.service'],
                      [py, '-I', '-B', me, 'probe-holder', ctx], ['--wait']),
        'permitfail': run('permitfail', ['RemainAfterExit=no', 'MemoryMax=64M'], [py, '-I', '-B', me, 'mock-permit', ctx, 'permitfail', 'fail'], ['--wait']),
        'holderfail': run('holderfail', holder + [f'Requires={p["unit"]}-permitfail.service', f'After={p["unit"]}-permitfail.service'],
                          ['/usr/bin/touch', f'{p["data"]}/holderfail-start-ran'], ['--wait']),
    }
    rprops = [f'{k}={v}' for k, v in rep if k in ('User', 'NoNewPrivileges', 'PrivateTmp', 'RuntimeDirectoryMode', 'RuntimeDirectoryPreserve')]
    if last(rep, 'RuntimeDirectory') != 'enclave-rpc' or 'RuntimeDirectoryPreserve=yes' not in rprops:
        raise SystemExit('reproof unit is not the reviewed one (RuntimeDirectory=enclave-rpc, Preserve=yes)')
    rprops += [f'RuntimeDirectory={p["rt"]}', 'MemoryMax=128M', 'CPUQuota=50%']   # a PRIVATE name: /run/enclave-rpc is never created here
    units['runtime'] = run('runtime', rprops, [py, '-I', '-B', me, 'probe-runtime', ctx], ['--wait'])
    units['runtime2'] = run('runtime2', rprops, [py, '-I', '-B', me, 'probe-runtime', ctx], ['--wait'])
    return units


# ---- probes (inside the transient units) ---------------------------------------------------------------------------------------
def emit(tag, **kv):
    print('SDCANARY ' + json.dumps({'probe': tag, **kv}, sort_keys=True), flush=True)


def caps(field):
    for l in open('/proc/self/status'):
        if l.startswith(field + ':'):
            return int(l.split()[1], 16)
    return None


def try_(fn):
    try:
        r = fn(); return {'ok': True, 'value': r}
    except BaseException as e:                              # noqa: BLE001 - every outcome is evidence
        return {'ok': False, 'error': type(e).__name__, 'errno': getattr(e, 'errno', None), 'msg': str(e)[:200]}


def load_file(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


def wrapper_ns(src):
    """the reviewed wrapper functions + constants, compiled from the BUNDLED bytes' AST (no module import: no import-time config reads)"""
    tree = ast.parse(pathlib.Path(src).read_text()); keep = []
    for n in tree.body:
        if isinstance(n, ast.FunctionDef) and n.name in WRAPPER_DEFS:
            keep.append(n)
        elif isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in WRAPPER_CONSTS for t in n.targets):
            keep.append(n)
    got = {n.name for n in keep if isinstance(n, ast.FunctionDef)} | {t.id for n in keep if isinstance(n, ast.Assign) for t in n.targets}
    if got != set(WRAPPER_DEFS) | set(WRAPPER_CONSTS):
        raise SystemExit(f'wrapper lacks {sorted(set(WRAPPER_DEFS) | set(WRAPPER_CONSTS) - got)}')
    ns = {'os': os, 'pwd': pwd, 'fcntl': fcntl, 'stat': stat, 'pathlib': pathlib}
    import builtins
    missing = {n for n in free_names(keep) - set(ns) - set(WRAPPER_DEFS) - set(WRAPPER_CONSTS) if not hasattr(builtins, n)}
    if missing:                                     # r2: every global the extracted code reads must be provided: no NameError at run time
        raise SystemExit(f'extracted wrapper code needs globals the canary does not provide: {sorted(missing)}')
    exec(compile(ast.Module(body=keep, type_ignores=[]), src, 'exec'), ns)
    return ns


def free_names(nodes):
    """names READ by the extracted functions that are neither their parameters nor assigned inside them"""
    out = set()
    for f in (n for n in nodes if isinstance(n, ast.FunctionDef)):
        a = f.args; local = {x.arg for x in a.args + a.kwonlyargs + a.posonlyargs + [a.vararg, a.kwarg] if x}
        for n in ast.walk(f):
            if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                local.add(n.id)
            elif isinstance(n, ast.ExceptHandler) and n.name:
                local.add(n.name)
            elif isinstance(n, (ast.FunctionDef, ast.Lambda)) and n is not f:
                local |= {x.arg for x in n.args.args + n.args.kwonlyargs}
        out |= {n.id for n in ast.walk(f) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)} - local
    return out


def probe_holder(ctx):
    c = json.load(open(ctx)); p = paths(c['id']); b = c['bundle']; r = {}
    r['identity'] = {'startNs': time.time_ns(), 'euid': os.geteuid(), 'handshakeEnv': os.environ.get('ENCLAVE_BASE_LAUNCH_HANDSHAKE'),
                     'capBnd': caps('CapBnd'), 'capEff': caps('CapEff'), 'noNewPrivs': caps('NoNewPrivs')}
    r['readRpcbaseSecret'] = try_(lambda: len(open(f'{p["data"]}/secret', 'rb').read()))            # needs CAP_DAC_READ_SEARCH
    def journal_append():
        q = f'{p["journal"]}/.probe-{os.getpid()}'
        fd = os.open(q, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644); os.write(fd, b'{}'); os.fsync(fd); os.close(fd)
        os.link(q, f'{p["journal"]}/000001.json'); os.unlink(q); d = os.open(p['journal'], os.O_RDONLY | os.O_DIRECTORY); os.fsync(d); os.close(d)
    r['journalAppend'] = try_(journal_append)
    r['roEtcWrite'] = try_(lambda: os.close(os.open(f'{p["ro"]}/must-not-exist', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)))   # expect EROFS
    r['launchBootstrapWrite'] = try_(lambda: os.close(os.open(f'{p["boot"]}/must-not-exist', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)))
    mh = json.load(open(f'{c["out"]}/mask-host.json'))                                   # r5: METADATA only, never a protected byte
    r['mask'] = {x: {'meta': meta(x), 'mounts': mountinfo(x)} for x in mh['paths']}
    r['maskNodes'] = {k: meta(v) for k, v in NODES.items()}
    r['sentinelFileLen'] = try_(lambda: len(open(p['sentinels'][1], 'rb').read()))     # the canary's OWN non-secret sentinel only
    hg = load_file('holder_gate_canary', f'{b}/bootstrap/holder_gate.py')
    r['ownDatadir'] = try_(lambda: hg.own_datadir(data=p['data']))                                       # PRIVATE data only
    r['rootfileOwner'] = try_(lambda: os.lstat(f'{p["data"]}/rootfile').st_uid)
    hg.L1_READY = ['/usr/bin/python3', '-I', '-B', f'{b}/wrapper/chain_service.py', 'l1-ready']          # the r13-final wrapper's l1-ready
    r['waitL1'] = try_(lambda: hg.wait_l1(c.get('l1WaitSec', 300)))
    W = wrapper_ns(f'{b}/wrapper/chain_service.py'); W['BOOTSTRAP_DIR'] = pathlib.Path(p['boot'])
    r['legacyRefusal'] = try_(lambda: W['release_launch_lock']({}))                                       # env set + no baseRelease
    lk = try_(lambda: W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}}))           # root + env -> the held lock
    r['releaseLock'] = {k: v for k, v in lk.items() if k != 'value'}
    emit('holder-root', **r)
    pw = W['service_identity']()
    W['drop_privileges'](pw)                                                                               # verified irreversible inside
    opens = json.dumps({x: v.get('type') for x, v in mh['paths'].items() if v.get('exists')})
    os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B', f'{b}/canary/canary_units.py', 'probe-dropped', ctx, opens])


def try_open(path, kind):
    """open ONLY (O_NOFOLLOW; O_DIRECTORY for a directory), closed at once: never a byte read"""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if kind == 'dir' else 0)); os.close(fd)
        return {'ok': True}
    except OSError as e:
        return {'ok': False, 'errno': e.errno}


def probe_dropped(ctx, opens='{}'):
    c = json.load(open(ctx)); p = paths(c['id']); r = {}
    r['maskOpen'] = {x: try_open(x, k) for x, k in json.loads(opens).items()}
    r['identity'] = {'resuid': os.getresuid(), 'resgid': os.getresgid(), 'groups': os.getgroups(), 'capEff': caps('CapEff'), 'capPrm': caps('CapPrm'),
                     'rpcbase': [pwd.getpwnam('rpcbase').pw_uid, pwd.getpwnam('rpcbase').pw_gid]}
    r['setuid0'] = try_(lambda: os.setuid(0))
    r['dataWrite'] = try_(lambda: os.close(os.open(f'{p["data"]}/dropped-wrote', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)))
    r['tmpWrite'] = try_(lambda: os.close(os.open(f'{p["tmp"]}/dropped-wrote', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)))
    r['journalWrite'] = try_(lambda: os.close(os.open(f'{p["journal"]}/dropped-must-not', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)))
    r['rootOnlyRead'] = try_(lambda: len(open(f'{p["run"]}/rootonly', 'rb').read()))
    emit('holder-dropped', **r)


def probe_runtime(ctx):
    c = json.load(open(ctx)); p = paths(c['id']); d = f'/run/{p["rt"]}'
    F = load_file('finality_state_canary', f'{c["bundle"]}/src/finality_state.py')
    r = {'before': try_(lambda: oct(stat.S_IMODE(os.lstat(d).st_mode))), 'fileBefore': os.path.exists(f'{d}/base-finality-status.json')}
    r['publish'] = try_(lambda: str(F.publish_status({'state': 'canary', 'qualified': False}, f'{d}/base-finality-status.json')))
    emit('runtime', **r)


def meta(path):
    """lstat metadata only (exists/type/mode/dev/ino/uid): no open, no read"""
    try:
        st = os.lstat(path)
    except OSError as e:
        return {'exists': False, 'errno': e.errno}
    t = 'dir' if stat.S_ISDIR(st.st_mode) else 'reg' if stat.S_ISREG(st.st_mode) else 'other'
    return {'exists': True, 'type': t, 'mode': oct(stat.S_IMODE(st.st_mode)), 'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid}


def mountinfo(path, text=None):
    """the mount entries whose mount point is `path` (root, fstype, source; metadata)"""
    text = text if text is not None else open('/proc/self/mountinfo').read(); out = []
    for l in text.splitlines():
        f = l.split(); dash = f.index('-') if '-' in f else None
        if dash and len(f) > 4 and f[4].replace('\\040', ' ') == path:
            out.append({'root': f[3], 'fstype': f[dash + 1], 'source': f[dash + 2] if len(f) > dash + 2 else None})
    return out


def protected(dropin_text):
    return [x.lstrip('-') for k, v in parse_unit(dropin_text).get('Service', []) if k == 'InaccessiblePaths' for x in v.split()]


def mask_host(ctx, dropin):
    """OUTSIDE the sandbox, before any unit: host metadata of every protected + sentinel path and of systemd's mask nodes"""
    c = json.load(open(ctx)); p = paths(c['id']); ps = protected(open(dropin).read()) + p['sentinels']
    doc = {'paths': {x: meta(x) for x in ps}, 'production': protected(open(dropin).read()), 'sentinels': p['sentinels'],
           'nodes': {k: meta(v) for k, v in NODES.items()}}
    json.dump(doc, open(f'{c["out"]}/mask-host.json', 'w'), indent=1, sort_keys=True); return 0


def mask_eval(host, h, d):
    """per path: present on the host -> INSIDE it is systemd's mask node of that type (same dev/ino as the node, NOT the host's own
    identity), mode 0000, and the dropped (rpcbase) phase gets EACCES on open; absent on the host -> absent inside ('-' semantics).
    Sentinels (canary-owned) must exist on the host: the positive control."""
    res, nodes_in = {}, h.get('maskNodes') or {}
    for x, hm in host['paths'].items():
        im = ((h.get('mask') or {}).get(x) or {}).get('meta') or {}
        if not hm.get('exists'):
            res[x] = x not in host['sentinels'] and im.get('exists') is False; continue
        node, hnode = nodes_in.get(hm.get('type')) or {}, (host.get('nodes') or {}).get(hm.get('type')) or {}
        ident = lambda m: (m.get('dev'), m.get('ino'))
        res[x] = (bool(node.get('exists')) and im.get('exists') is True and ident(im) == ident(node) == ident(hnode) and ident(im) != ident(hm)
                  and im.get('mode') == '0o0' and ((d.get('maskOpen') or {}).get(x) or {}).get('errno') == 13)
    return res


def mock_permit(ctx, name, mode):
    c = json.load(open(ctx)); p = paths(c['id']); flag = f'{p["run"]}/{name}.attempted'
    with open(f'{p["run"]}/{name}.stamps', 'a') as f:
        f.write(f'{time.time_ns()}\n')
    if mode == 'fail' or not os.path.exists(flag):
        open(flag, 'w').close(); emit('mock-permit', name=name, result='fail'); sys.exit(1)
    emit('mock-permit', name=name, result='ok')


# ---- verdict (orchestrator, after every unit) -------------------------------------------------------------------------------------
def lines(path, tag):
    out = []
    for l in pathlib.Path(path).read_text(errors='replace').splitlines():
        i = l.find('SDCANARY ')
        if i >= 0:
            x = json.loads(l[i + 9:])
            if x.get('probe') == tag:
                out.append(x)
    return out


def verdict(ctx):
    c = json.load(open(ctx)); p = paths(c['id']); o = pathlib.Path(c['out']); ok, info = {}, {}
    rb = pwd.getpwnam('rpcbase')
    want_bnd = sum(1 << CAPS[x] for x in ('CAP_SETUID', 'CAP_SETGID', 'CAP_DAC_READ_SEARCH', 'CAP_CHOWN'))
    h = (lines(o / 'journal-holder.txt', 'holder-root') or [None])[-1]; d = (lines(o / 'journal-holder.txt', 'holder-dropped') or [None])[-1]
    err = lambda x, n: isinstance(x, dict) and x.get('ok') is False and x.get('errno') == n
    if h:
        i = h['identity']
        ok['root-phase identity: euid 0, handshake env, CapBnd == drop-in set, NoNewPrivs'] = (i['euid'], i['handshakeEnv'], i['capBnd'], i['noNewPrivs']) == (0, '1', want_bnd, 1)
        ok['root reads the rpcbase-only datadir file (DAC_READ_SEARCH)'] = h['readRpcbaseSecret']['ok']
        ok['journal dir append (ReadWritePaths on the dir) works'] = h['journalAppend']['ok']
        ok['launch lock O_RDWR + flock (ReadWritePaths on a FILE) works'] = h['releaseLock']['ok']
        ok['non-RW /etc path is read-only (EROFS)'] = err(h['roEtcWrite'], 30)
        ok['launch dir itself (not journal) is read-only (EROFS)'] = err(h['launchBootstrapWrite'], 30)
        mh = json.load(open(o / 'mask-host.json')); me = mask_eval(mh, h, d or {}); info['InaccessiblePaths per path'] = me
        ok['InaccessiblePaths: every present path is systemd\'s 0000 mask node (not the host object), EACCES for rpcbase; absent = absent'] = bool(me) and all(me.values())
        ok['InaccessiblePaths positive control: both canary sentinels exist on the host and are masked (sentinel file reads 0 bytes)'] = \
            all(me.get(x) for x in mh['sentinels']) and h['sentinelFileLen'].get('value') == 0
        ok['own-datadir (reviewed) chowns the private root file to rpcbase'] = h['ownDatadir'].get('value', [1])[0] == 0 and h['rootfileOwner'].get('value') == rb.pw_uid
        ok['legacy manifest + handshake env is refused by the reviewed wrapper'] = h['legacyRefusal']['ok'] is False and 'legacy bin/base' in h['legacyRefusal']['msg']
        ok['own L1 ready from INSIDE the release-mode sandbox (reviewed wait_l1 -> r13-final wrapper l1-ready, bounded)'] = \
            h['waitL1'].get('ok') is True and (h['waitL1'].get('value') or [1])[0] == 0
        info['waitL1'] = h['waitL1']
    else:
        ok['holder root probe ran'] = False
    if d:
        i = d['identity']
        ok['after the reviewed drop: all ids rpcbase, no capability'] = (i['resuid'] == [rb.pw_uid] * 3 and i['resgid'] == [rb.pw_gid] * 3 and i['capEff'] == 0 and i['capPrm'] == 0)
        ok['setuid(0) refused after the drop'] = err(d['setuid0'], 1)
        ok['rpcbase writes its data + tmp subtrees'] = d['dataWrite']['ok'] and d['tmpWrite']['ok']
        ok['rpcbase cannot write the journal or read root-only files'] = err(d['journalWrite'], 13) and err(d['rootOnlyRead'], 13)
    else:
        ok['holder dropped probe ran (execve after the drop)'] = False
    st = lambda n: [int(x) for x in pathlib.Path(f'{p["run"]}/{n}.stamps').read_text().split()] if pathlib.Path(f'{p["run"]}/{n}.stamps').exists() else []
    ps = st('permit')
    ok['order: holder start re-ran the failed (mock) permit first, then the holder'] = len(ps) >= 2 and bool(h) and h['identity']['startNs'] > ps[-1]
    ok['order: a failing permit keeps the holder from starting (Requires=)'] = len(st('permitfail')) >= 2 and not os.path.exists(f'{p["data"]}/holderfail-start-ran')
    busy = json.load(open(o / 'busy.json'))
    if busy['downloaderState'] in BUSY:                       # r5: the reviewed gate's BUSY states (activating included)
        ok[f'datadir-idle (reviewed) SKIPS the start while the snapshot download is {busy["downloaderState"]}'] = \
            busy['startRan'] is False and busy['conditionMsg'] is True and busy['conditionResult'] == 'no' and busy['skippedExecCondition'] is True
    else:
        info['datadir-idle busy refusal'] = f'NOT EXERCISED: the snapshot download was {busy["downloaderState"]!r} (no claim)'
    rt = lines(o / 'journal-runtime.txt', 'runtime')
    m = json.load(open(o / 'runtime.json'))
    ok['RuntimeDirectory created root 0755 + publish_status writes 0644 there'] = bool(rt) and rt[-1]['publish']['ok'] and m['mode'] == '0o755' and m['uid'] == 0 and m['fileMode'] == '0o644'
    ok['RuntimeDirectoryPreserve keeps dir + file for the next unit (second run finds run 1 file, republishes)'] = \
        len(rt) >= 2 and rt[0]['fileBefore'] is False and rt[-1]['fileBefore'] is True and rt[-1]['publish']['ok']
    inv = json.load(open(o / 'invariants.json'))
    ok['production PIDs (EL/CL/snapshot/forwards/holder) unchanged'] = inv['pidsUnchanged']
    ok['production units + /etc/enclave-rpc metadata unchanged'] = inv['configUnchanged']
    ok['GUEST reserve: >= 2 readable guest samples, all >= the reserve, no reserve breach (the HOST floor is host_verdict.py)'] = \
        inv['guestSamples'] >= 2 and inv['guestSamplesReadable'] and (inv['guestMinAvailMiB'] or 0) >= inv['guestReserveMiB'] and not inv['guestReserveBreach']
    res = {'id': c['id'], 'required': ok, 'informational': info, 'pass': all(bool(v) for v in ok.values())}
    (o / 'verdict.json').write_text(json.dumps(res, indent=1, sort_keys=True)); print(json.dumps(res, indent=1, sort_keys=True))
    return 0 if res['pass'] else 1


def main(a):
    if a[1:2] == ['render'] and len(a) == 7:
        print(json.dumps(render(a[2], open(a[3]).read(), open(a[4]).read(), open(a[5]).read(), a[6]))); return 0
    f = {'probe-holder': probe_holder, 'probe-dropped': probe_dropped, 'probe-runtime': probe_runtime, 'verdict': verdict}
    if len(a) == 3 and a[1] in f:
        return f[a[1]](a[2]) or 0
    if len(a) == 4 and a[1] == 'probe-dropped':
        return probe_dropped(a[2], a[3]) or 0
    if len(a) == 4 and a[1] == 'mask-host':
        return mask_host(a[2], a[3])
    if len(a) == 5 and a[1] == 'mock-permit' and a[4] in ('flaky', 'fail'):
        return mock_permit(a[2], a[3], a[4]) or 0
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
