#!/usr/bin/env python3
"""production-bootstrap-wiring-stage (PREPARED; NOT run): ROOT-ONLY placement of the reviewed M7+M10 release binary and the journaled
switch of /opt/enclave-rpc/manifest.json to release mode. Dry run unless --commit. NEVER touches /opt/enclave-rpc/bin/base (the official
v1.5.1 harness binary 9c44836d that ALSO runs the snapshot download): it is only hashed, read-only.

  release --from <path> [--commit]   copy the EXISTING built artifact (the guest's m7-m10 build output; no build here) to the versioned
                                     path, root:root 0555: a fsynced private sibling, then link(2) - which never replaces an existing
                                     name, so a concurrent or earlier different destination is never overwritten; sha256 ==
                                     BASE_RELEASE_SHA256 of the source, of the copy, and of the placed file. Present and identical ->
                                     nothing to do; present and different -> refused
  manifest [--commit]                binaries.base 9c44836d -> 4a7c013a and baseRelease null -> {path, sha256}; every other key/value kept.
                                     Refused unless the release is placed and verified, bin/base is still 9c44836d, the holder is
                                     stopped and the datadir idle (holder_gate.datadir_idle: no download unit, no process naming the
                                     mount), and no bootstrap journal is open. Order (each step durable before the next): journal `open`
                                     -> byte backup -> atomic replace (original mode/owner) -> journal `committed`
  revert-manifest --journal <file> [--commit]
                                     restores the backed-up bytes ONLY if manifest.json is exactly what that journal wrote, and only
                                     with the holder stopped and the datadir idle
  recover [--commit]                 resolves an interrupted switch from durable state: manifest == new -> `committed`; == old ->
                                     `aborted`; anything else refused (root decides)
  status                             read-only
Every path this tool trusts is checked component by component from / : real (no symlink), root-owned, not group/other writable; a
file must be a regular file with one link. Afterwards the coverage receipt is produced for the NEW manifest bytes and
readiness-settings.json sets expect-base-sha256 to the release sha (readiness_sampler defaults to 9c44836d)."""
import datetime, hashlib, importlib.util, json, os, pathlib, stat, sys

BASE_RELEASE_SHA256 = '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f'   # == base_launch.py / chain_service.py
BASE_RELEASE_PATH = '/opt/enclave-rpc/releases/base-m7m10-4a7c013a510f8816/base'
HARNESS_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'  # == base_launch.HARNESS_BINARY_SHA256
HARNESS_BINARY = '/opt/enclave-rpc/bin/base'
MANIFEST = '/opt/enclave-rpc/manifest.json'
JOURNAL_DIR = '/var/lib/enclave-rpc/bootstrap-journal'
FORMAT = 'enclave-bootstrap-journal/v1'
HOLDER_UNIT = 'enclave-base-holder.service'
STATES = ('open', 'committed', 'aborted', 'reverted')


class Refused(Exception):
    pass


def refuse(why):
    raise Refused(why)


def R(root, p):
    return pathlib.Path(str(root).rstrip('/') + p)


def secure(p, owner, kind, root='/'):
    """every component from `root` down to p: no symlink, uid owner, not group/other writable; the leaf a directory or a regular
    single-link file (kind 'dir'/'file'). -> the leaf lstat."""
    p, top = pathlib.Path(p), pathlib.Path(root)
    if not p.is_absolute() or '..' in p.parts or not (p == top or top in p.parents):
        refuse(f'{p} is not a plain path under {top}')
    cur = top
    for part in [None] + list(p.relative_to(top).parts):
        cur = cur / part if part else cur
        st = os.lstat(cur)
        if stat.S_ISLNK(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022:
            refuse(f'{cur} is a symlink, not owned by uid {owner}, or group/other writable')
        if cur != p and not stat.S_ISDIR(st.st_mode):
            refuse(f'{cur} is not a directory')
    if kind == 'dir' and not stat.S_ISDIR(st.st_mode) or kind == 'file' and not (stat.S_ISREG(st.st_mode) and st.st_nlink == 1):
        refuse(f'{p} is not a {"directory" if kind == "dir" else "regular single-link file"}')
    return st


def file_sha(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            refuse(f'{p} is not a regular file')
        h = hashlib.sha256()
        while (b := os.read(fd, 1 << 22)):
            h.update(b)
        return h.hexdigest(), st
    finally:
        os.close(fd)


def fsync_dir(d):
    fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(p, b, mode):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fchmod(fd, mode); os.fsync(fd)
    finally:
        os.close(fd)


def release_ok(root, owner):
    p = R(root, BASE_RELEASE_PATH)
    if not os.path.lexists(p):
        return False
    st = secure(p, owner, 'file', root)
    h, _ = file_sha(p)
    if h != BASE_RELEASE_SHA256:
        refuse(f'{p} exists with other bytes ({h[:12]}): never overwritten; root resolves it')
    if st.st_mode & 0o111 != 0o111:
        refuse(f'{p} is not executable by the service user')
    return True


def harness_ok(root):
    h, _ = file_sha(R(root, HARNESS_BINARY))
    if h != HARNESS_BINARY_SHA256:
        refuse(f'{HARNESS_BINARY} is not the harness/download binary {HARNESS_BINARY_SHA256[:12]} (it is never replaced here)')


def place_release(src, *, root='/', owner=0, commit=False):
    src = pathlib.Path(src); s = os.lstat(src)
    if stat.S_ISLNK(s.st_mode) or not stat.S_ISREG(s.st_mode):
        refuse(f'{src} is not a regular file')
    h, _ = file_sha(src)
    if h != BASE_RELEASE_SHA256:
        refuse(f'{src} is not the reviewed release ({h[:12]} != {BASE_RELEASE_SHA256[:12]})')
    if release_ok(root, owner):
        return {'release': 'present', 'path': BASE_RELEASE_PATH}
    dest = R(root, BASE_RELEASE_PATH)
    secure(dest.parent.parent.parent, owner, 'dir', root)                     # /opt/enclave-rpc
    plan = [str(d) for d in (dest.parent.parent, dest.parent) if not os.path.lexists(d)] + [str(dest)]
    if not commit:
        return {'release': 'dry-run', 'create': plan, 'sha256': h}
    for d in (dest.parent.parent, dest.parent):
        if not os.path.lexists(d):
            try:
                os.mkdir(d, 0o755)
            except FileExistsError:
                pass
            else:
                os.chmod(d, 0o755); fsync_dir(d.parent)
        secure(d, owner, 'dir', root)
    tmp = dest.with_name(f'.base.partial-{os.getpid()}')
    fi = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fo = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
        try:
            h2 = hashlib.sha256()
            while (b := os.read(fi, 1 << 22)):
                h2.update(b); v = memoryview(b)
                while v:
                    v = v[os.write(fo, v):]
            os.fchmod(fo, 0o555); os.fsync(fo)
        finally:
            os.close(fo)
    finally:
        os.close(fi)
    try:
        if h2.hexdigest() != BASE_RELEASE_SHA256:
            refuse('the source changed while it was copied: nothing placed')
        try:
            os.link(tmp, dest)                                                 # never replaces: EEXIST if anything is there now
        except FileExistsError:
            refuse(f'{dest} appeared concurrently: not overwritten (status shows whether it is the release)')
    finally:
        os.unlink(tmp)
    fsync_dir(dest.parent)
    if not release_ok(root, owner):
        refuse('the placed release does not verify')
    return {'release': 'placed', 'path': BASE_RELEASE_PATH, 'sha256': BASE_RELEASE_SHA256}


def _gate(here=None):
    p = pathlib.Path(here or pathlib.Path(__file__).resolve().parent) / 'holder_gate.py'
    s = importlib.util.spec_from_file_location('holder_gate_release', p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    return m


def _holder_stopped():
    g = _gate()
    try:
        s = g.unit_state(HOLDER_UNIT)
    except Exception as e:                                   # noqa: BLE001 - undeterminable is not stopped
        return 1, f'cannot determine {HOLDER_UNIT} ({e})'
    return (1, f'{HOLDER_UNIT} is {s}: stop it first') if s in g.BUSY else (0, '')


def quiet(idle, holder):
    """the holder stopped AND the datadir idle (no download unit, no process naming the mount), else refused"""
    for fn in (holder or _holder_stopped, idle or (lambda: _gate().datadir_idle())):
        rc, why = fn()
        if rc != 0:
            refuse(f'not while the Base holder/datadir is in use: {why}')


def jdir(root, owner, create=False):
    d = R(root, JOURNAL_DIR)
    if not os.path.lexists(d):
        if not create:
            return None
        secure(d.parent, owner, 'dir', root)
        os.mkdir(d, 0o700); os.chmod(d, 0o700); fsync_dir(d.parent)
    st = secure(d, owner, 'dir', root)
    if st.st_mode & 0o077:
        refuse(f'{d} must be 0700')
    return d


def jread(p, owner, root):
    secure(p, owner, 'file', root)
    j = json.loads(pathlib.Path(p).read_bytes())
    if not isinstance(j, dict) or j.get('format') != FORMAT or j.get('state') not in STATES:
        refuse(f'{p} is not a journal of this tool')
    return j


def jwrite(d, name, doc):
    """atomic: a fsynced sibling renamed over the journal, then the directory fsynced"""
    tmp = d / f'.{name}.partial-{os.getpid()}'
    write_new(tmp, json.dumps(doc, indent=1, sort_keys=True).encode(), 0o600)
    os.rename(tmp, d / name); fsync_dir(d)


def open_journals(root, owner):
    d = jdir(root, owner)
    if d is None:
        return []
    return [n for n in sorted(os.listdir(d)) if n.endswith('-manifest.json') and jread(d / n, owner, root)['state'] == 'open']


def switched(doc):
    return {**doc, 'binaries': {**(doc.get('binaries') or {}), 'base': BASE_RELEASE_SHA256},
            'baseRelease': {'path': BASE_RELEASE_PATH, 'sha256': BASE_RELEASE_SHA256}}


def replace_atomic(p, b, uid, gid, mode):
    tmp = p.with_name(f'.{p.name}.partial-{os.getpid()}')
    write_new(tmp, b, 0o600)
    os.chown(tmp, uid, gid); os.chmod(tmp, mode)
    os.rename(tmp, p); fsync_dir(p.parent)


def _crash(hooks, point):
    if hooks and point in hooks:
        hooks[point]()


def switch_manifest(*, root='/', owner=0, commit=False, idle=None, holder=None, now=None, hooks=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    p = R(root, MANIFEST); st = secure(p, owner, 'file', root); raw = p.read_bytes(); doc = json.loads(raw)
    if open_journals(root, owner):                                              # r2: FIRST - an interrupted switch is resolved before anything
        refuse(f'an open bootstrap journal exists in {JOURNAL_DIR}: recover first')
    if doc.get('baseRelease') is not None and doc == switched(doc):
        if not release_ok(root, owner):
            refuse('manifest.json names the release, but the release is not placed')
        return {'manifest': 'already release mode', 'sha256': hashlib.sha256(raw).hexdigest()}
    if (doc.get('binaries') or {}).get('base') != HARNESS_BINARY_SHA256 or doc.get('baseRelease') is not None:
        refuse('manifest.json is neither the legacy (binaries.base 9c44836d, baseRelease null) nor the release state: root resolves it')
    if not release_ok(root, owner):
        refuse('the release binary is not placed (release --from <path> --commit first)')
    harness_ok(root)
    quiet(idle, holder)
    new = (json.dumps(switched(doc), indent=2) + '\n').encode()
    plan = {'manifest': 'switch', 'from': hashlib.sha256(raw).hexdigest(), 'to': hashlib.sha256(new).hexdigest(),
            'binaries.base': [HARNESS_BINARY_SHA256, BASE_RELEASE_SHA256], 'baseRelease': switched(doc)['baseRelease']}
    if not commit:
        return {**plan, 'dryRun': True}
    d = jdir(root, owner, create=True); stamp = now.strftime('%Y%m%dT%H%M%S%fZ'); name = f'{stamp}-manifest.json'
    j = {'format': FORMAT, 'op': 'manifest-switch', 'state': 'open', 'path': MANIFEST, 'oldSha256': plan['from'], 'newSha256': plan['to'],
         'mode': stat.S_IMODE(st.st_mode), 'uid': st.st_uid, 'gid': st.st_gid, 'backup': f'{stamp}.backup/manifest.json', 'at': now.isoformat()}
    jwrite(d, name, j)                                                          # 1. durable intent BEFORE anything changes
    _crash(hooks, 'after-journal')
    bdir = d / f'{stamp}.backup'; os.mkdir(bdir, 0o700); fsync_dir(d)
    write_new(bdir / 'manifest.json', raw, 0o600); fsync_dir(bdir)            # 2. durable backup (file, its dir, the dir's entry)
    _crash(hooks, 'after-backup')
    replace_atomic(p, new, st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode))      # 3. one rename: old or new bytes, never partial
    _crash(hooks, 'after-replace')
    if hashlib.sha256(p.read_bytes()).hexdigest() != plan['to']:
        refuse('manifest.json did not land as planned (the journal stays open: recover)')
    jwrite(d, name, {**j, 'state': 'committed'})                                # 4.
    return {**plan, 'journal': str(d / name)}


def recover(*, root='/', owner=0, commit=False):
    d = jdir(root, owner); out = []
    for n in open_journals(root, owner):
        j = jread(d / n, owner, root); cur = hashlib.sha256(R(root, MANIFEST).read_bytes()).hexdigest()
        to = 'committed' if cur == j['newSha256'] else 'aborted' if cur == j['oldSha256'] else None
        if to is None:
            refuse(f'{n}: manifest.json is neither the journalled old nor new bytes: root resolves it')
        if commit:
            jwrite(d, n, {**j, 'state': to})
        out.append({'journal': n, 'state': to, 'dryRun': not commit})
    return {'recovered': out}


def revert_manifest(journal, *, root='/', owner=0, commit=False, idle=None, holder=None):
    d = jdir(root, owner); jp = pathlib.Path(journal)
    if d is None or jp.parent != d:
        refuse(f'the journal must be in {JOURNAL_DIR}')
    j = jread(jp, owner, root)
    if j.get('op') != 'manifest-switch' or j['state'] != 'committed':
        refuse('only a committed manifest-switch journal is reverted (recover an open one first)')
    p = R(root, MANIFEST); secure(p, owner, 'file', root); cur = hashlib.sha256(p.read_bytes()).hexdigest()
    if cur != j['newSha256']:
        refuse('manifest.json is not what that journal wrote: nothing is restored (root resolves it)')
    bp = d / j['backup']; secure(bp, owner, 'file', root); b = bp.read_bytes()
    if hashlib.sha256(b).hexdigest() != j['oldSha256']:
        refuse('the backup differs from the journalled sha')
    quiet(idle, holder)
    if not commit:
        return {'revert': 'dry-run', 'to': j['oldSha256']}
    replace_atomic(p, b, j['uid'], j['gid'], j['mode'])
    jwrite(d, jp.name, {**j, 'state': 'reverted'})
    return {'revert': 'restored', 'sha256': j['oldSha256']}


def status(root='/', owner=0):
    out = {}
    for k, fn in (('release', lambda: 'placed' if release_ok(root, owner) else 'absent'), ('binBase', lambda: harness_ok(root) or HARNESS_BINARY_SHA256),
                  ('openJournals', lambda: open_journals(root, owner))):
        try:
            out[k] = fn()
        except (Refused, OSError, ValueError) as e:
            out[k] = f'REFUSED: {e}'
    doc = json.loads(R(root, MANIFEST).read_bytes())
    out['manifest'] = {'binaries.base': (doc.get('binaries') or {}).get('base'), 'baseRelease': doc.get('baseRelease')}
    return out


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    a = argv[1:]; commit = '--commit' in a; a = [x for x in a if x != '--commit']
    try:
        if len(a) == 3 and a[0] == 'release' and a[1] == '--from':
            r = place_release(a[2], commit=commit)
        elif a == ['manifest']:
            r = switch_manifest(commit=commit)
        elif len(a) == 3 and a[0] == 'revert-manifest' and a[1] == '--journal':
            r = revert_manifest(a[2], commit=commit)
        elif a == ['recover']:
            r = recover(commit=commit)
        elif a == ['status'] and not commit:
            r = status()
        else:
            print(__doc__); return 2
    except (Refused, OSError, ValueError, KeyError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, **r}, indent=1)); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
