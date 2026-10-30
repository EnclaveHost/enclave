#!/usr/bin/python3 -I
"""guest-state-install-stage/r1: install the Base state DB from the KEPT, host-fetched state.tar.zst into the guest datadir WITHOUT
reth's delete-then-redownload path. Root runs each phase by hand or through its unit; nothing here downloads or deletes the archive.

Phases (each refuses on any doubt; exit 0 ok, 2 refused, 3 busy, 8 staging wrong, 10 digest wrong):
  import-verify  the archive in the work dir is exactly the host's kept archive: size == manifest state size and sha256 ==
                 the host provenance record (archive_provenance.py on the host, bound to the r3 fetch-complete record). Read-only
                 on the archive; writes import.json.
  extract-stage  runs the pinned base binary's legacy single-archive extraction (`snapshot download --url file://ARCHIVE
                 --datadir STAGE`, reth 7134be3 mod.rs:504-534: stream_and_extract only; no write_config/init_db) into an EMPTY
                 staging datadir, then checks the exact output set. Meant to run ONLY inside enclave-base-state-extract-gsi.service
                 (ReadWritePaths = the staging dir alone, PrivateNetwork, no capabilities): the datadir is read-only to it.
  install        never runs the extractor. Re-checks the exact staged set, hashes each staged output with the ROOT-QUALIFIED
                 BLAKE3 tool (pinned sha256 + known-answer test), writes install-intent.json, then per output: chown to the
                 datadir owner and rename into data/db (targets must be absent; data/db must exist, owned by the datadir owner,
                 and hold nothing else). Idempotent: a re-run after a crash finishes exactly the recorded renames. Writes
                 state-installed.json (holder root) with size/mtime/inode/dev/uid/gid/BLAKE3 of every installed output.
  guard          ExecStartPre=+ of EVERY enclave-base-retention.service start (drop-in): allowed only while data/db is exactly the
                 installed, unmodified state (so reth's own BLAKE3 reuse check passes and nothing is deleted) and no
                 retention-complete marker exists (a finalized DB is never re-entered: that is the delete/redownload path).
                 Read-only; it runs before ExecStart, i.e. before anything reth could delete.
--test-mode only relaxes uid-0 ownership, chown and the systemctl busy check (offline tests) and admits the labelled test-only
--kat-expect / --test-crash-after; every digest, size, set and identity check is the same code in both modes.
"""
import argparse, hashlib, json, os, shutil, stat, subprocess, sys, time

BLAKE3_EMPTY = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
FMT = 'enclave-guest-state-install/r1'
RETENTION_UNIT, HOLDER_UNIT = 'enclave-base-retention.service', 'enclave-base-holder.service'


class Refuse(Exception):
    def __init__(self, rc, msg):
        super().__init__(msg); self.rc = rc


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def log(event, **kw):
    print(json.dumps({'t': now(), 'event': event, **kw}, sort_keys=True), flush=True)


def fsync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, obj):
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.rename(tmp, path); fsync_dir(os.path.dirname(path))


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def manifest_state(a):
    raw = open(a.manifest, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != a.manifest_sha256:
        raise Refuse(2, 'snapshot manifest sha256 is not the pinned one')
    s = json.loads(raw)['components'].get('state')
    if not isinstance(s, dict) or not isinstance(s.get('output_files'), list) or not s['output_files']:
        raise Refuse(2, 'manifest has no state outputs')
    outs = []
    for o in s['output_files']:
        p = o.get('path', '')
        if not p.startswith('db/') or '..' in p.split('/') or p.count('/') != 1 or type(o.get('size')) is not int or len(o.get('blake3', '')) != 64:
            raise Refuse(2, f'unexpected state output {p!r}')
        outs.append({'path': p, 'size': o['size'], 'blake3': o['blake3']})
    return s, outs


def check_dir(path, a, mode=0o700):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or (not a.test_mode and (st.st_uid != 0 or stat.S_IMODE(st.st_mode) != mode)):
        raise Refuse(2, f'{path} is not a root-owned {oct(mode)} directory')


def busy(a):
    if a.test_mode:
        return
    for u in (RETENTION_UNIT, HOLDER_UNIT):
        r = subprocess.run(['/usr/bin/systemctl', 'is-active', u], capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'})
        if r.stdout.strip() not in ('inactive', 'failed', 'unknown') and not (u == RETENTION_UNIT and a.cmd == 'guard'):
            raise Refuse(3, f'{u} is {r.stdout.strip()}')


def staged_set(stage, outs):
    """the staging datadir holds EXACTLY the declared outputs: regular, nlink 1, exact sizes; only the db/ directory"""
    want = {o['path']: o for o in outs}
    for root, dirs, files in os.walk(stage):
        rel = os.path.relpath(root, stage)
        for d in dirs:
            r = os.path.normpath(os.path.join(rel, d))
            if r != 'db' or os.path.islink(os.path.join(root, d)):
                raise Refuse(8, f'unexpected staged directory {r}')
        for n in files:
            r = os.path.normpath(os.path.join(rel, n))
            st = os.lstat(os.path.join(root, n))
            if r not in want or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != want[r]['size'] \
                    or st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX | 0o022):
                raise Refuse(8, f'staged {r} is not a declared regular single-link file of its size')
    missing = [p for p in want if not os.path.lexists(os.path.join(stage, p))]
    if missing:
        raise Refuse(8, f'staged outputs missing: {missing}')


def b3tool(a):
    """the root-qualified BLAKE3 tool: pinned sha256, copied into the private work dir (0500) and executed from there; KAT"""
    if sha256_file(a.b3sum) != a.b3sum_sha256:
        raise Refuse(2, 'BLAKE3 tool sha256 is not the root-qualified pin')
    copy = os.path.join(a.work_dir, 'b3sum.qualified')
    shutil.copyfile(a.b3sum, copy); os.chmod(copy, 0o500)
    if sha256_file(copy) != a.b3sum_sha256:
        raise Refuse(2, 'BLAKE3 tool copy differs')
    empty = os.path.join(a.work_dir, 'kat-empty')
    open(empty, 'wb').close()
    try:
        if b3(copy, empty) != (a.kat_expect or BLAKE3_EMPTY):        # --kat-expect exists ONLY with --test-mode (labelled stub)
            raise Refuse(2, 'BLAKE3 tool fails the known-answer test (BLAKE3 of empty input)')
    finally:
        os.unlink(empty)
    return copy


def b3(tool, path):
    r = subprocess.run([tool, '--no-names', path], capture_output=True, text=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    out = r.stdout.strip()
    if r.returncode != 0 or len(out) != 64:
        raise Refuse(2, f'BLAKE3 tool failed on {path}')
    return out


def cmd_import_verify(a):
    s, _ = manifest_state(a)
    check_dir(a.work_dir, a)
    arch = os.path.join(a.work_dir, 'state.tar.zst')
    st = os.lstat(arch)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != s['size']:
        raise Refuse(2, f'archive is not a regular single-link file of the manifest size {s["size"]}')
    prov = read_json(a.provenance)
    if prov.get('format') != 'enclave-host-archive-provenance/r1' or prov.get('manifestSha256') != a.manifest_sha256 or prov.get('size') != s['size']:
        raise Refuse(2, 'not the host provenance record for this manifest/archive')
    got = sha256_file(arch)
    if got != prov.get('sha256'):
        raise Refuse(10, 'imported archive sha256 differs from the host kept archive (transfer corrupted or another object)')
    atomic_json(os.path.join(a.work_dir, 'import.json'), {'format': FMT, 'phase': 'import', 'archiveSha256': got, 'size': st.st_size,
                'provenance': prov, 'ino': st.st_ino, 'dev': st.st_dev, 'mtimeNs': st.st_mtime_ns, 'at': now()})
    log('import-verified', sha256=got)


def cmd_extract_stage(a):
    s, outs = manifest_state(a)
    check_dir(a.work_dir, a)
    imp = read_json(os.path.join(a.work_dir, 'import.json'))
    arch = os.path.join(a.work_dir, 'state.tar.zst'); st = os.lstat(arch)
    if (imp.get('ino'), imp.get('dev'), imp.get('mtimeNs'), imp.get('size')) != (st.st_ino, st.st_dev, st.st_mtime_ns, st.st_size):
        raise Refuse(2, 'the archive changed since import-verify')
    if sha256_file(a.base_bin) != a.base_bin_sha256:
        raise Refuse(2, 'base binary is not the pinned one')
    # the ONLY writable paths of the extract unit: stage/, x-home/, extract-state/ (pre-created root 0700); their CONTENTS are
    # emptied here (the directories stay, so the unit never needs the work dir itself writable: archive + records stay read-only)
    stage, home, xs = (os.path.join(a.work_dir, n) for n in ('stage', 'x-home', 'extract-state'))
    for d in (stage, home, xs):
        check_dir(d, a)
        for n in os.listdir(d):
            q = os.path.join(d, n)
            shutil.rmtree(q) if os.path.isdir(q) and not os.path.islink(q) else os.unlink(q)
    cmd = [a.base_bin, 'snapshot', 'download', '--chain', 'base', '--datadir', stage, '--url', 'file://' + arch]
    log('extract-start', cmd=cmd)
    r = subprocess.run(cmd, stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'HOME': home, 'TMPDIR': home, 'LC_ALL': 'C'})
    if r.returncode != 0:
        raise Refuse(9, f'extractor exited {r.returncode} (staging only; retry re-creates it)')
    staged_set(stage, outs)
    atomic_json(os.path.join(xs, 'staged.json'), {'format': FMT, 'phase': 'staged', 'archiveSha256': imp['archiveSha256'], 'at': now(),
                'files': {o['path']: _id(os.path.join(stage, o['path'])) for o in outs}})
    log('staged', files=len(outs))


def _id(p):
    st = os.lstat(p)
    return {'size': st.st_size, 'ino': st.st_ino, 'dev': st.st_dev, 'mtimeNs': st.st_mtime_ns}


def cmd_install(a):
    s, outs = manifest_state(a)
    check_dir(a.work_dir, a); busy(a)
    stage, db = os.path.join(a.work_dir, 'stage'), os.path.join(a.datadir, 'db')
    intent_p, rec_p = os.path.join(a.work_dir, 'install-intent.json'), os.path.join(a.holder_root, 'state-installed.json')
    if os.path.lexists(rec_p):
        raise Refuse(2, 'state-installed.json exists: already installed (never re-installed over a DB)')
    dst = os.lstat(a.datadir); dbst = os.lstat(db) if os.path.lexists(db) else None
    if dbst is None or not stat.S_ISDIR(dbst.st_mode) or (dbst.st_uid, dbst.st_gid) != (dst.st_uid, dst.st_gid):
        raise Refuse(2, 'data/db must exist as a directory owned by the datadir owner')
    intent = read_json(intent_p) if os.path.lexists(intent_p) else None
    if intent is None:
        if os.listdir(db):
            raise Refuse(2, f'data/db is not empty: {sorted(os.listdir(db))[:8]}')
        staged = read_json(os.path.join(a.work_dir, 'extract-state', 'staged.json'))
        staged_set(stage, outs)
        if any(_id(os.path.join(stage, o['path'])) != staged['files'][o['path']] for o in outs):
            raise Refuse(8, 'staged outputs changed since extract-stage')
        tool = b3tool(a)
        for o in outs:
            if b3(tool, os.path.join(stage, o['path'])) != o['blake3']:
                raise Refuse(10, f'{o["path"]}: BLAKE3 differs from the manifest (nothing installed)')
            if _id(os.path.join(stage, o['path'])) != staged['files'][o['path']]:
                raise Refuse(8, f'{o["path"]} changed while hashing')
        intent = {'format': FMT, 'phase': 'install-intent', 'archiveSha256': staged['archiveSha256'], 'owner': [dst.st_uid, dst.st_gid],
                  'files': {o['path']: {**staged['files'][o['path']], 'blake3': o['blake3']} for o in outs}, 'at': now()}
        atomic_json(intent_p, intent)
    for n, (path, f) in enumerate(sorted(intent['files'].items())):
        src, tgt = os.path.join(stage, path), os.path.join(a.datadir, path)
        same = lambda p: os.path.lexists(p) and {k: v for k, v in _id(p).items() if k != 'mtimeNs'} == {k: f[k] for k in ('size', 'ino', 'dev')}
        if same(tgt) and not os.path.lexists(src):
            continue                                              # renamed by an earlier, interrupted run
        if not same(src) or os.path.lexists(tgt):
            raise Refuse(2, f'{path}: neither the recorded staged file nor its recorded installed copy (refusing to guess)')
        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not a.test_mode:
                os.fchown(fd, *intent['owner'])
        finally:
            os.close(fd)
        os.rename(src, tgt); fsync_dir(db); fsync_dir(os.path.dirname(src))
        if a.test_crash_after is not None and a.test_mode and n + 1 >= a.test_crash_after:
            os._exit(77)
    leftover = sorted(set(os.listdir(db)) - {os.path.basename(p) for p in intent['files']})
    if leftover:
        raise Refuse(2, f'data/db holds foreign files: {leftover}')
    rec = {'format': FMT, 'phase': 'installed', 'archiveSha256': intent['archiveSha256'], 'manifestSha256': a.manifest_sha256, 'at': now(),
           'files': {p: {**_id(os.path.join(a.datadir, p)), 'blake3': f['blake3'], 'uid': os.lstat(os.path.join(a.datadir, p)).st_uid,
                         'gid': os.lstat(os.path.join(a.datadir, p)).st_gid} for p, f in intent['files'].items()}}
    atomic_json(rec_p, rec)
    log('installed', record=rec_p, archiveKept=os.path.join(a.work_dir, 'state.tar.zst'))


def cmd_guard(a):
    _, outs = manifest_state(a)
    rec_p, marker = os.path.join(a.holder_root, 'state-installed.json'), os.path.join(a.holder_root, 'retention-complete')
    if os.path.lexists(marker):
        raise Refuse(2, 'retention-complete exists: the DB is finalized; a retention start would delete and re-download state')
    if not os.path.lexists(rec_p):
        raise Refuse(2, 'no state-installed.json: state is not installed (reth would re-download it non-durably)')
    rec = read_json(rec_p)
    if rec.get('format') != FMT or rec.get('manifestSha256') != a.manifest_sha256 or set(rec.get('files', {})) != {o['path'] for o in outs}:
        raise Refuse(2, 'state-installed.json is not this manifest\'s record')
    db = os.path.join(a.datadir, 'db')
    extra = sorted(set(os.listdir(db)) - {os.path.basename(p) for p in rec['files']})
    if extra:
        raise Refuse(2, f'data/db holds files beyond the installed state: {extra}')
    for p, f in rec['files'].items():
        cur = _id(os.path.join(a.datadir, p))
        if cur != {k: f[k] for k in ('size', 'ino', 'dev', 'mtimeNs')} or not stat.S_ISREG(os.lstat(os.path.join(a.datadir, p)).st_mode):
            raise Refuse(2, f'{p} changed since install (finalized or modified): reth would not reuse it')
    log('guard-ok', files=len(rec['files']))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=('import-verify', 'extract-stage', 'install', 'guard'))
    ap.add_argument('--manifest', required=True); ap.add_argument('--manifest-sha256', required=True)
    ap.add_argument('--work-dir'); ap.add_argument('--datadir'); ap.add_argument('--holder-root')
    ap.add_argument('--provenance'); ap.add_argument('--base-bin'); ap.add_argument('--base-bin-sha256')
    ap.add_argument('--b3sum'); ap.add_argument('--b3sum-sha256')
    ap.add_argument('--test-mode', action='store_true'); ap.add_argument('--test-crash-after', type=int); ap.add_argument('--kat-expect')
    a = ap.parse_args(argv)
    need = {'import-verify': ('work_dir', 'provenance'), 'extract-stage': ('work_dir', 'base_bin', 'base_bin_sha256'),
            'install': ('work_dir', 'datadir', 'holder_root', 'b3sum', 'b3sum_sha256'), 'guard': ('datadir', 'holder_root')}[a.cmd]
    if any(getattr(a, k) is None for k in need) or ((a.test_crash_after is not None or a.kat_expect) and not a.test_mode):
        ap.error(f'{a.cmd} needs ' + ', '.join('--' + k.replace('_', '-') for k in need))
    try:
        {'import-verify': cmd_import_verify, 'extract-stage': cmd_extract_stage, 'install': cmd_install, 'guard': cmd_guard}[a.cmd](a)
    except Refuse as e:
        log('refused', phase=a.cmd, reason=str(e)); return e.rc
    except (OSError, ValueError, KeyError) as e:
        log('refused', phase=a.cmd, reason=f'{type(e).__name__}: {e}'); return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
