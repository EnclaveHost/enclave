#!/usr/bin/python3 -I
"""retention_guard.py (base-retention-stage/activation; PREPARED by 50cf; never run live by Claude). ROOT-run, read-only gate for the
SECOND (cached retention) Base snapshot download, plus the post-download verifier that writes its OWN completion marker.

  retention_guard.py pre      every precondition below; exit 0 admitted, 3 refused (JSON on stdout). Writes nothing.
  retention_guard.py status   read-only report (unit states, missing/partial archives, markers); exit 0.
  retention_guard.py post     (unit ExecStartPost, root) all selected archive outputs present at their manifest sizes -> write
                              /srv/enclave-base-holder/retention-complete atomically (tmp, fsync, rename, dir fsync); else exit 3.
Preconditions (pre):
  1. the FIRST download unit enclave-rpc-base-snapshot.service is loaded, inactive/dead, Result=success, ExecMainStatus=0, AND its own
     root-owned marker /srv/enclave-base-holder/snapshot-complete exists (written only by its success path). A running/failed/restarting
     first download is never touched or restarted.
  2. enclave-base-holder.service and .path are stopped (not active/activating/deactivating/reloading) and NOT enabled
     (disabled, or masked/masked-runtime), so nothing auto-starts the holder while the datadir is mutated.
  3. no process uses the datadir (cwd/root/exe/open fds under /srv/enclave-base-holder/data) and no process runs the base binary.
  4. pins: /opt/enclave-rpc/bin/base sha256 == 9c44836d... == /opt/enclave-rpc/manifest.json binaries.base (production install manifest);
     the snapshot manifest sha256 == 1f0c4e6c... (harness-first MANIFEST_SHA); all root-owned, no group/other write, no symlink.
  5. capacity: the pinned v2 cached_download_preflight (sha af70424c...) admits, selects exactly 18 archives (tested policy:
     history from 48000000, state history from 52500000) and its command == the unit's ExecStart argv (no --force/--prune-unlisted).
  6. memory: MemAvailable >= 16 GiB floor + the unit's 4 GiB MemoryMax (the guest VM's fixed 64 GiB is not changed).
  7. the retention marker /srv/enclave-base-holder/retention-complete is absent (otherwise: already complete, nothing to do).
Partial state (reported, NEVER deleted): selected archives whose outputs exist with a wrong size (an interrupted extraction) and
download leftovers (manifest archive file names or *.part/*.tmp/*.download) in the datadir and datadir/static_files.
"""
import contextlib, datetime, hashlib, importlib.util, io, json, os, stat, subprocess, sys

GiB = 1 << 30
FIRST_UNIT = 'enclave-rpc-base-snapshot.service'
HOLDER_UNITS = ('enclave-base-holder.service', 'enclave-base-holder.path')
RETENTION_UNIT = 'enclave-base-retention.service'
BASE_BIN_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'   # producer HARNESS_BINARY_SHA256 == binaries.base
MANIFEST_SHA256 = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'   # harness-first/a2a4.py:52 MANIFEST_SHA
PREFLIGHT_SHA256 = 'af70424cf32db44f95be43094180085a41b23f21ee64ccd7aac5eb2f236c3411'  # base-retention-stage/v2 (tested 36+6 OK)
HISTORY_FROM, STATE_FROM, CONCURRENCY, EXPECTED_ARCHIVES = 48_000_000, 52_500_000, 8, 18
MEMORY_FLOOR, UNIT_MEMORY_MAX = 16 * GiB, 4 * GiB
DEFAULT_ENV = {'root': '/srv/enclave-base-holder', 'baseBin': '/opt/enclave-rpc/bin/base', 'installManifest': '/opt/enclave-rpc/manifest.json',
               'snapshotManifest': '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', 'proc': '/proc', 'meminfo': '/proc/meminfo',
               'preflight': os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cached_download_preflight.py'), 'uid': 0}
LEFTOVER_SUFFIXES = ('.part', '.tmp', '.download')


def paths(env):
    r = env['root']
    return {'datadir': r + '/data', 'snapMarker': r + '/snapshot-complete', 'retMarker': r + '/retention-complete'}


def sha_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def trusted_file(p, uid):
    st = os.lstat(p)
    return stat.S_ISREG(st.st_mode) and st.st_uid == uid and not st.st_mode & 0o022


def load_preflight(env):
    if sha_file(env['preflight']) != PREFLIGHT_SHA256:
        raise ValueError('cached_download_preflight.py is not the tested v2 bytes')
    spec = importlib.util.spec_from_file_location('cached_download_preflight', env['preflight'])
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def expected_argv(pf, env):
    return pf.command(paths(env)['datadir'], env['snapshotManifest'], HISTORY_FROM, STATE_FROM, CONCURRENCY)


def systemctl_show(unit, run=subprocess.run):
    props = 'LoadState,ActiveState,SubState,Result,ExecMainStatus,UnitFileState'
    r = run(['/usr/bin/systemctl', 'show', '--property=' + props, unit], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise ValueError(f'systemctl show {unit} failed')
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def first_ok(s):
    return (s.get('LoadState') == 'loaded' and s.get('ActiveState') == 'inactive' and s.get('SubState') == 'dead'
            and s.get('Result') == 'success' and s.get('ExecMainStatus') == '0')


def holder_ok(s):
    return (s.get('ActiveState') in ('inactive', 'failed') and s.get('UnitFileState') in ('disabled', 'masked', 'masked-runtime'))


def datadir_users(env):
    """pids whose cwd/root/exe or any open fd is under the datadir, or that run the base binary (own pid excluded)"""
    d = os.path.realpath(paths(env)['datadir']); base = os.path.realpath(env['baseBin']); users = []
    for pid in os.listdir(env['proc']):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        pd = os.path.join(env['proc'], pid); links = []
        for n in ('cwd', 'root', 'exe'):
            with contextlib.suppress(OSError):
                links.append(os.readlink(os.path.join(pd, n)))
        with contextlib.suppress(OSError):
            for fd in os.listdir(os.path.join(pd, 'fd')):
                with contextlib.suppress(OSError):
                    links.append(os.readlink(os.path.join(pd, 'fd', fd)))
        if any(l == d or l.startswith(d + '/') or l == base for l in links):
            users.append(int(pid))
    return sorted(users)


def mem_available(env):
    for l in open(env['meminfo']):
        if l.startswith('MemAvailable:'):
            return int(l.split()[1]) * 1024
    raise ValueError('no MemAvailable')


def archives(pf, env, manifest):
    """-> (all selected, missing, partial-extraction) from the pinned preflight's plan/present"""
    sel = pf.plan(manifest, HISTORY_FROM, STATE_FROM)['missingArchives']
    dd = paths(env)['datadir']
    missing = [a for a in sel if not pf.present(dd, a['outputs'])]
    partial = [{'component': a['component'], 'chunk': a['chunk'], 'outputs': [o['path'] for o in a['outputs']
               if os.path.exists(os.path.join(dd, o['path'])) and os.path.getsize(os.path.join(dd, o['path'])) != o['size']]}
               for a in missing]
    return sel, missing, [p for p in partial if p['outputs']]


def leftovers(env, manifest):
    names = {os.path.basename(f) for c in manifest['components'].values() if isinstance(c, dict) for f in c.get('chunk_files', [])}
    dd, found = paths(env)['datadir'], []
    for d in (dd, os.path.join(dd, 'static_files')):
        with contextlib.suppress(OSError):
            for n in os.listdir(d):
                if n in names or n.endswith(LEFTOVER_SUFFIXES):
                    found.append(os.path.join(d, n))
    return sorted(found)


def preflight_report(pf, env):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = pf.main(['--manifest', env['snapshotManifest'], '--datadir', paths(env)['datadir'], '--history-from', str(HISTORY_FROM),
                      '--state-history-from', str(STATE_FROM), '--download-concurrency', str(CONCURRENCY)] + env.get('preflightExtra', []))
    return rc, json.loads(out.getvalue())


def pre(env, run=subprocess.run):
    p, refusals = paths(env), []
    first = systemctl_show(FIRST_UNIT, run)
    if not first_ok(first):
        refusals.append(f'first download {FIRST_UNIT} is not inactive/dead with Result=success and exit 0: {first}')
    if not (os.path.lexists(p['snapMarker']) and trusted_file(p['snapMarker'], env['uid'])):
        refusals.append('first download marker snapshot-complete absent or not a root-owned regular file')
    holders = {u: systemctl_show(u, run) for u in HOLDER_UNITS}
    for u, s in holders.items():
        if not holder_ok(s):
            refusals.append(f'{u} must be stopped and not enabled (disabled/masked): {s}')
    users = datadir_users(env)
    if users:
        refusals.append(f'processes use the datadir or run the base binary: {users}')
    try:
        for f in (env['baseBin'], env['installManifest'], env['snapshotManifest']):
            if not trusted_file(f, env['uid']):
                refusals.append(f'{f} is not a root-owned regular file without group/other write')
        if sha_file(env['baseBin']) != BASE_BIN_SHA256:
            refusals.append('base binary is not 9c44836d...')
        if (json.load(open(env['installManifest'])).get('binaries') or {}).get('base') != BASE_BIN_SHA256:
            refusals.append('production install manifest binaries.base is not 9c44836d...')
        if sha_file(env['snapshotManifest']) != MANIFEST_SHA256:
            refusals.append('snapshot manifest is not 1f0c4e6c...')
        manifest = json.load(open(env['snapshotManifest']))
        pf = load_preflight(env)
        rc, rep = preflight_report(pf, env)
        sel, missing, partial = archives(pf, env, manifest)
        if len(sel) != EXPECTED_ARCHIVES:
            refusals.append(f'policy drift: {len(sel)} archives selected, tested policy is {EXPECTED_ARCHIVES}')
        if rc != 0 or not rep.get('admitted'):
            refusals.append(f'capacity preflight refused: {rep.get("refusal")}')
        if rep.get('command') != expected_argv(pf, env):
            refusals.append('preflight command != the unit ExecStart argv')
    except (OSError, ValueError, KeyError) as e:
        refusals.append(f'input: {e}'); rep, missing, partial, manifest = {}, [], [], {'components': {}}
    if mem_available(env) < MEMORY_FLOOR + UNIT_MEMORY_MAX:
        refusals.append('MemAvailable below the 16 GiB floor + 4 GiB unit MemoryMax')
    if os.path.lexists(p['retMarker']):
        refusals.append('retention-complete already exists: nothing to do (never re-run over a completed retention)')
    return {'admitted': not refusals, 'refusals': refusals, 'missingArchives': len(missing), 'partialExtraction': partial,
            'leftovers': leftovers(env, manifest) if manifest.get('components') else [], 'preflight': rep}


def status(env, run=subprocess.run):
    p, pf = paths(env), load_preflight(env)
    manifest = json.load(open(env['snapshotManifest']))
    sel, missing, partial = archives(pf, env, manifest)
    return {'units': {u: systemctl_show(u, run) for u in (FIRST_UNIT, RETENTION_UNIT) + HOLDER_UNITS},
            'snapshotComplete': os.path.lexists(p['snapMarker']), 'retentionComplete': os.path.lexists(p['retMarker']),
            'selectedArchives': len(sel), 'missingArchives': len(missing), 'partialExtraction': partial,
            'leftovers': leftovers(env, manifest), 'datadirUsers': datadir_users(env)}


def post(env, now=None):
    p, pf = paths(env), load_preflight(env)
    manifest = json.load(open(env['snapshotManifest']))
    if sha_file(env['snapshotManifest']) != MANIFEST_SHA256:
        return {'complete': False, 'refusal': 'snapshot manifest changed'}
    sel, missing, partial = archives(pf, env, manifest)
    if missing or len(sel) != EXPECTED_ARCHIVES:
        return {'complete': False, 'missingArchives': len(missing), 'partialExtraction': partial}
    rec = {'format': 'enclave-base-retention-complete/v1', 'manifestSha256': MANIFEST_SHA256, 'baseBinarySha256': BASE_BIN_SHA256,
           'historyFrom': HISTORY_FROM, 'stateHistoryFrom': STATE_FROM, 'archives': len(sel), 'argv': expected_argv(pf, env),
           'completedAt': (now or datetime.datetime.now(datetime.timezone.utc)).isoformat()}
    if os.path.lexists(p['retMarker']):
        return {'complete': False, 'refusal': 'retention-complete already exists (not overwritten)'}
    tmp = p['retMarker'] + f'.tmp-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        os.write(fd, (json.dumps(rec, sort_keys=True) + '\n').encode()); os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, p['retMarker'])
    dfd = os.open(env['root'], os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
    return {'complete': True, 'marker': p['retMarker'], 'record': rec}


def main(argv=None, env=None, run=subprocess.run):
    argv = sys.argv[1:] if argv is None else argv
    env = dict(DEFAULT_ENV, **(env or {}))
    if argv not in (['pre'], ['status'], ['post']):
        print(__doc__); return 2
    if env['uid'] == 0 and os.geteuid() != 0:
        print(json.dumps({'refused': 'root only'})); return 2
    r = {'pre': lambda: pre(env, run), 'status': lambda: status(env, run), 'post': lambda: post(env)}[argv[0]]()
    print(json.dumps(r, indent=1, sort_keys=True))
    if argv[0] == 'pre':
        return 0 if r['admitted'] else 3
    if argv[0] == 'post':
        return 0 if r['complete'] else 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
