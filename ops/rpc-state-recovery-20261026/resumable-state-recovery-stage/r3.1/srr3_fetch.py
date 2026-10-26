#!/usr/bin/env python3
"""srr3_fetch.py (resumable-state-recovery-stage/r3; PREPARED, NOT TESTED, never run by Claude). HOST-ONLY durable fetch of the pinned
state archive. Python stdlib + curl. No VM, no systemd unit, no guest assumptions. Extraction/BLAKE3/finalize guards are a LATER,
separate phase (not qualified here).

  probe   ONE request `Range: bytes=0-0` -> <work>/probe-headers.txt + probe.json for ROOT REVIEW of the object identity (status 206,
          Content-Range 0-0/N with N = the pinned total, strong ETag, Last-Modified, identity encoding). Commits nothing.
  fetch   requires the REVIEWED --expect-etag/--expect-last-modified (never first-come pins). ONE bounded chunk per attempt (<= 64 MiB):
          curl -r S-E (body via a pipe into our O_EXCL chunk.tmp, refused past E-S+1 bytes), then validate the FINAL response before
          commit: curl exit 0, 206, Content-Range exactly bytes S-E/N, Content-Length = E-S+1 = received, identity encoding, ETag and
          Last-Modified byte-equal to the reviewed pins, no 3xx in the chain. Commit = pwrite at S + fsync + atomic committed.json
          (tmp + fsync + rename + dir fsync). committed.offset is the ONLY progress truth; each start truncates only our OWN uncommitted
          tail. A kill/crash loses <= one chunk; nothing ever discards committed bytes; identity changes STOP for root (never restart 0).
Ownership: the work dir must be a real directory owned by --owner-uid (== the running uid), mode 0700, holding ONLY this tool's files;
every file O_NOFOLLOW, regular, nlink 1, owned by us, no group/other write; flock; refuse if another process has the archive open or its
cwd inside the work dir. Capacity: free >= remaining archive + --reserve-bytes (>= 500 GB) before the first chunk and every 16 chunks.
Exit: 0 ok | 2 input/provenance | 3 ownership/lock/busy | 4 capacity | 5 local state inconsistent | 6 response refused (root review) |
7 retries exhausted | 143 signal (committed progress kept).
"""
import argparse, ctypes, errno, fcntl, hashlib, json, os, re, signal, stat, subprocess, sys, time
from urllib.parse import urljoin, urlparse, urlunparse

FMT = 'enclave-host-state-fetch-r3/v1'
MIN_RESERVE = 500_000_000_000
MAX_CHUNK, MIN_CHUNK = 64 << 20, 64 << 10
TRANSIENT_CURL = {7, 16, 18, 28, 35, 52, 55, 56, 92}
OWN_FILES = {'.lock', 'committed.json', 'committed.json.tmp', 'state.tar.zst', 'chunk.tmp', 'chunk.hdr', 'probe-headers.txt',
             'probe.json', 'probe.json.tmp', 'fetch-complete.json', 'fetch-complete.json.tmp'}
STOP = {'flag': False, 'proc': None}
COMMITTED = [0]
COPY = 4 << 20
ARGS = None


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def log(event, **kw):
    print(json.dumps({'t': now(), 'event': event, **kw}, sort_keys=True), flush=True)


class Refuse(Exception):
    def __init__(self, rc, reason, **kw):
        super().__init__(reason); self.rc, self.reason, self.kw = rc, reason, kw


def test_kill(point):
    """Real SIGKILL of this process at a named point. Honoured ONLY for the loopback-http test URL (never for the pinned https URL)."""
    if (ARGS.allow_http_loopback and os.environ.get('SRR3_TEST_KILL') == point
            and COMMITTED[0] >= int(os.environ.get('SRR3_TEST_KILL_AFTER', '0'))):
        log('test-kill', point=point); os.kill(os.getpid(), signal.SIGKILL)


# ------------------------------------------------------------------ provenance -----------------------------------------------------
def resolve_archive_url(base_url, relative):         # mirrors reth 7134be3 manifest.rs:540 resolve_archive_url
    relative = relative.lstrip('/')
    if not base_url:
        return relative
    p = urlparse(base_url)
    if not p.scheme or not p.netloc:
        return base_url.rstrip('/') + '/' + relative
    if not p.path.endswith('/'):
        p = p._replace(path=p.path + '/')
    return urljoin(urlunparse(p), relative)


def read_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refuse(2, f'{path} is not a regular file')
        with os.fdopen(os.dup(fd), 'rb') as f:
            return f.read()
    finally:
        os.close(fd)


def load_manifest(a):
    raw = read_regular(a.manifest)
    if hashlib.sha256(raw).hexdigest() != a.manifest_sha256:
        raise Refuse(2, 'manifest sha256 differs from the pin (never use an unreviewed manifest)')
    m = json.loads(raw)
    st = (m.get('components') or {}).get('state')
    if not isinstance(st, dict) or not isinstance(st.get('file'), str) or not isinstance(st.get('size'), int):
        raise Refuse(2, 'manifest has no single-archive state component')
    if st['size'] != a.expect_total:
        raise Refuse(2, 'manifest state size differs from --expect-total', size=st['size'])
    url = resolve_archive_url(m.get('base_url') or '', st['file'])
    if url != a.expect_url:
        raise Refuse(2, 'resolved state URL differs from --expect-url', resolved=url)
    u = urlparse(url)
    if a.allow_http_loopback and not (u.scheme == 'http' and u.hostname == '127.0.0.1'):
        raise Refuse(2, '--allow-http-loopback requires an actual http://127.0.0.1 URL')
    if u.scheme != 'https' and not (a.allow_http_loopback and u.scheme == 'http' and u.hostname == '127.0.0.1'):
        raise Refuse(2, 'state URL must be https (plain http only to 127.0.0.1 with --allow-http-loopback, for the offline tests)')
    return url, st['size']


# ------------------------------------------------------------------ ownership ------------------------------------------------------
def check_work_dir(a, create):
    parent = os.path.dirname(os.path.abspath(a.work_dir))
    pst = os.lstat(parent)
    if stat.S_ISLNK(pst.st_mode) or not stat.S_ISDIR(pst.st_mode) or pst.st_uid != a.owner_uid or stat.S_IMODE(pst.st_mode) & 0o022:
        raise Refuse(3, 'work dir parent must be a real directory owned by the owner without group/other write', parent=parent)
    try:
        st = os.lstat(a.work_dir)
    except FileNotFoundError:
        if not create:
            raise Refuse(3, 'work dir missing')
        os.mkdir(a.work_dir, 0o700); os.chmod(a.work_dir, 0o700); fsync_dir(parent); st = os.lstat(a.work_dir)
        log('work-dir-created', path=a.work_dir)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise Refuse(3, 'work dir is a symlink or not a directory')
    if st.st_uid != a.owner_uid or stat.S_IMODE(st.st_mode) != 0o700:
        raise Refuse(3, 'work dir must be owned by the owner with mode exactly 0700', uid=st.st_uid, mode=oct(stat.S_IMODE(st.st_mode)))
    foreign = sorted(set(os.listdir(a.work_dir)) - OWN_FILES)
    if foreign:
        raise Refuse(3, 'work dir holds files this tool did not create: never mixed, never overwritten', entries=foreign[:20])


def open_own(path, flags, a, mode=0o600):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != a.owner_uid or st.st_mode & 0o022 or st.st_nlink != 1:
        os.close(fd); raise Refuse(3, f'{path} is not our private regular file')
    return fd


def unlink_own(path, a):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(st.st_mode) or st.st_uid != a.owner_uid:
        raise Refuse(3, f'{path} is not our regular file: not removed')
    os.unlink(path)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def atomic_json(path, obj, a):
    tmp = path + '.tmp'
    unlink_own(tmp, a)
    fd = open_own(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, a)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path); fsync_dir(os.path.dirname(os.path.abspath(path)))


def read_json_own(path, a):
    fd = open_own(path, os.O_RDONLY, a)
    with os.fdopen(fd) as f:
        return json.load(f)


def take_lock(a):
    fd = open_own(os.path.join(a.work_dir, '.lock'), os.O_RDWR | os.O_CREAT, a)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd); raise Refuse(3, 'another process holds the work-dir lock')
    return fd


def busy(a):
    """Other processes (visible to us) with an fd on a work-dir file or a cwd inside the work dir."""
    work = os.path.realpath(a.work_dir); me = os.getpid(); hits = []
    for pid in (d for d in os.listdir('/proc') if d.isdigit()):
        if int(pid) == me:
            continue
        links = []
        try: links.append(os.readlink(f'/proc/{pid}/cwd'))
        except OSError: pass
        try:
            for n in os.listdir(f'/proc/{pid}/fd'):
                try: links.append(os.readlink(f'/proc/{pid}/fd/{n}'))
                except OSError: pass
        except OSError:
            pass
        if any(l == work or l.startswith(work + '/') for l in links):
            hits.append(int(pid))
    return hits


def capacity(a, remaining):
    s = os.statvfs(a.work_dir); free = s.f_bavail * s.f_frsize; need = remaining + a.reserve_bytes
    if free < need:
        raise Refuse(4, 'insufficient space: nothing is deleted to make room', free=free, need=need)


# ------------------------------------------------------------------ HTTP ---------------------------------------------------------
def parse_headers(raw):
    out = []
    for b in re.split(r'\r?\n\r?\n', raw.decode('iso-8859-1')):
        if not b.strip().startswith('HTTP/'):
            continue
        lines = b.strip().splitlines()
        m = re.match(r'HTTP/[0-9.]+\s+(\d{3})', lines[0])
        h, dup = {}, set()
        for ln in lines[1:]:
            if ':' in ln:
                k, v = ln.split(':', 1); k = k.strip().lower()
                if k in h: dup.add(k)
                h[k] = v.strip()
        out.append((int(m.group(1)) if m else None, h, dup))
    return out


def classify(blocks, rc, got, S, E, N, pins):
    """-> ('ok'|'transient'|'stop', reason)."""
    if not blocks:
        return ('transient' if rc in TRANSIENT_CURL else 'stop'), f'no HTTP response headers (curl {rc})'
    finals = [b for b in blocks if not (100 <= (b[0] or 0) < 200)]
    if not finals:
        return 'transient', 'only interim responses'
    if any(s and 300 <= s < 400 for s, _h, _d in finals):
        return 'stop', 'redirect in the response chain refused'
    status, h, dup = finals[-1]
    if status is None:
        return 'stop', 'malformed status line'
    if status in (408, 429, 500, 502, 503, 504):
        return 'transient', f'HTTP {status}'
    if status == 200:
        return 'stop', '200 full response: Range ignored or If-Range mismatch (object changed?)'
    if status != 206:
        return 'stop', f'unexpected HTTP {status}'
    if dup & {'content-range', 'content-length', 'etag', 'last-modified', 'content-encoding'}:
        return 'stop', f'duplicated critical headers {sorted(dup)}'
    enc = h.get('content-encoding', 'identity').strip().lower()
    if enc != 'identity':
        return 'stop', f'Content-Encoding {enc} refused'
    etag, lm = h.get('etag'), h.get('last-modified')
    if not etag or etag.startswith('W/') or not re.fullmatch(r'"[\x21\x23-\x7e\x80-\xff]*"', etag):
        return 'stop', f'missing or weak ETag {etag!r}'
    if etag != pins['etag'] or lm != pins['lastModified']:
        return 'stop', 'ETag/Last-Modified differ from the reviewed pins: never splice two objects'
    m = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', h.get('content-range', ''))
    if not m:
        return 'stop', '206 without an exact Content-Range'
    s, e, total = map(int, m.groups())
    if total != N:
        return 'stop', f'Content-Range total {total} != pinned total {N}'
    if (s, e) != (S, E):
        return 'stop', f'Content-Range {s}-{e} != requested {S}-{E}'
    cl = h.get('content-length', '')
    if not re.fullmatch(r'[0-9]{1,20}', cl) or int(cl) != E - S + 1:
        return 'stop', f'Content-Length {cl!r} != {E - S + 1}'
    if rc != 0 or got != E - S + 1:
        return 'transient', f'incomplete chunk (curl {rc}, {got}/{E - S + 1} bytes)'
    return 'ok', 'ok'


def _pdeathsig():                                        # curl dies with us (no orphan after a SIGKILL of this process)
    try:
        ctypes.CDLL('libc.so.6', use_errno=True).prctl(1, signal.SIGKILL)   # PR_SET_PDEATHSIG
    except Exception:
        pass


def run_curl(a, url, S, E, if_range, sink_fd, hdr_path):
    limit = E - S + 1
    cmd = [a.curl, '-q', '-sS', '--http1.1', '--proto', '=http,https' if a.allow_http_loopback else '=https', '--proto-redir', '=https',
           '--max-redirs', '0', '--noproxy', '*', '-r', f'{S}-{E}', '-H', 'Accept-Encoding: identity', '--max-filesize', str(limit),
           '--connect-timeout', '20', '--max-time', str(a.chunk_seconds), '--speed-limit', '1', '--speed-time', str(a.stall_seconds),
           '-D', hdr_path, '-o', '-']
    if if_range:
        cmd += ['-H', f'If-Range: {if_range}']
    cmd.append(url)
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, preexec_fn=_pdeathsig)
    STOP['proc'] = p
    got, over = 0, False
    while True:
        b = p.stdout.read1(1 << 20)
        if not b:
            break
        if got + len(b) > limit:
            over = True; p.kill(); break
        if sink_fd is not None:
            os.write(sink_fd, b)
        got += len(b)
        if got >= limit // 2:
            test_kill('mid-chunk')
    err = p.stderr.read().decode(errors='replace')
    p.wait(); STOP['proc'] = None
    return p.returncode, got, over, err


def on_term(signum, _frame):
    STOP['flag'] = True
    p = STOP['proc']
    if p and p.poll() is None:
        p.terminate()


# ------------------------------------------------------------------ commands -----------------------------------------------------
def cmd_probe(a):
    url, N = load_manifest(a)
    check_work_dir(a, create=True)
    lk = take_lock(a)
    hdr = os.path.join(a.work_dir, 'probe-headers.txt')
    unlink_own(hdr, a)
    rc, got, over, err = run_curl(a, url, 0, 0, None, None, hdr)
    blocks = parse_headers(read_regular(hdr)) if os.path.lexists(hdr) else []
    finals = [b for b in blocks if not (100 <= (b[0] or 0) < 200)]
    status, h, _d = finals[-1] if finals else (None, {}, set())
    rec = {'format': FMT, 'url': url, 'total': N, 'status': status, 'contentRange': h.get('content-range'),
           'contentLength': h.get('content-length'), 'contentEncoding': h.get('content-encoding'), 'etag': h.get('etag'),
           'lastModified': h.get('last-modified'), 'curlRc': rc, 'probedAt': now(), 'note': 'for ROOT REVIEW; nothing committed'}
    atomic_json(os.path.join(a.work_dir, 'probe.json'), rec, a)
    log('probe', **{k: rec[k] for k in ('status', 'contentRange', 'etag', 'lastModified', 'contentEncoding')})
    if any(s and 300 <= s < 400 for s, _h, _d in finals):
        raise Refuse(6, 'probe: redirect refused')
    pins = {'etag': h.get('etag'), 'lastModified': h.get('last-modified')}
    kind, reason = classify(blocks, rc, got, 0, 0, N, pins)
    os.close(lk)
    if kind != 'ok':
        raise Refuse(6, f'probe response not acceptable: {reason}')
    log('probe-ok-review-pins', etag=pins['etag'], lastModified=pins['lastModified']); return 0


def cmd_fetch(a):
    url, N = load_manifest(a)
    if not a.expect_etag or a.expect_last_modified is None:
        raise Refuse(2, 'fetch requires the ROOT-REVIEWED --expect-etag and --expect-last-modified (from probe.json)')
    if a.expect_etag.startswith('W/') or not re.fullmatch(r'"[\x21\x23-\x7e\x80-\xff]*"', a.expect_etag):
        raise Refuse(2, '--expect-etag must be a strong quoted ETag')
    pins = {'etag': a.expect_etag, 'lastModified': a.expect_last_modified or None}
    check_work_dir(a, create=True)
    lk = take_lock(a)
    w = a.work_dir
    arch_p, chunk_p, hdr_p, com_p, done_p = (os.path.join(w, n) for n in
                                              ('state.tar.zst', 'chunk.tmp', 'chunk.hdr', 'committed.json', 'fetch-complete.json'))
    if not os.path.lexists(com_p) and os.path.lexists(com_p + '.tmp'):
        raise Refuse(5, 'only temporary progress record exists: preserve it and the archive for recovery')
    for leftover in (chunk_p, hdr_p, com_p + '.tmp'):
        unlink_own(leftover, a)                                          # our own uncommitted attempt files only
    if os.path.lexists(arch_p) and not stat.S_ISREG(os.lstat(arch_p).st_mode):
        raise Refuse(3, 'archive path is a symlink or not a regular file')
    users = busy(a)
    if users:
        raise Refuse(3, 'other processes have the archive open or a cwd in the work dir', pids=users)
    try:
        com = read_json_own(com_p, a)
    except FileNotFoundError:
        if os.path.lexists(arch_p) and os.lstat(arch_p).st_size != 0:
            raise Refuse(5, 'archive exists without committed.json: unknown provenance, never adopted (root review)')
        com = {'format': FMT, 'url': url, 'manifestSha256': a.manifest_sha256, 'total': N, 'offset': 0, **pins, 'createdAt': now()}
        atomic_json(com_p, com, a)
    if (com.get('format'), com.get('url'), com.get('manifestSha256'), com.get('total')) != (FMT, url, a.manifest_sha256, N):
        raise Refuse(2, 'committed.json belongs to another format/URL/manifest/total')
    if (com.get('etag'), com.get('lastModified')) != (pins['etag'], pins['lastModified']):
        raise Refuse(6, 'reviewed pins differ from those the committed bytes were fetched under: root review (never spliced)')
    afd = open_own(arch_p, os.O_RDWR | os.O_CREAT, a)
    size, off = os.fstat(afd).st_size, int(com['offset'])
    if size < off:
        raise Refuse(5, 'archive is shorter than the committed offset: committed bytes missing (root review)', size=size, offset=off)
    if size > off:
        os.ftruncate(afd, off); os.fsync(afd); log('truncated-uncommitted-tail', offset=off, removed=size - off)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_term)
    capacity(a, N - off)
    failures, chunks = 0, 0
    while off < N:
        if STOP['flag']:
            raise Refuse(143, 'stopped by signal; committed progress kept', offset=off)
        if chunks and chunks % 16 == 0:
            capacity(a, N - off)
        S, E = off, min(off + a.chunk_bytes, N) - 1
        cfd = open_own(chunk_p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, a)
        try:
            rc, got, over, err = run_curl(a, url, S, E, pins['etag'], cfd, hdr_p)
        finally:
            os.close(cfd)
        try:
            raw = read_regular(hdr_p) if os.path.lexists(hdr_p) else b''
        except Refuse:
            raw = b''
        kind, reason = classify(parse_headers(raw), rc, got, S, E, N, pins)
        if over:
            kind, reason = 'stop', f'body exceeds the requested range ({E - S + 1} bytes)'
        if kind != 'ok':
            unlink_own(chunk_p, a); unlink_own(hdr_p, a)
            log('chunk-rejected', start=S, end=E, curl_rc=rc, received=got, kind=kind, reason=reason, stderr=err[-200:])
            if STOP['flag']:
                raise Refuse(143, 'stopped by signal; committed progress kept', offset=off)
            if kind == 'stop':
                raise Refuse(6, reason, start=S)
            failures += 1
            if failures >= a.max_failures:
                raise Refuse(7, 'too many consecutive failed chunks', failures=failures)
            time.sleep(min(a.backoff_cap, 2 ** min(failures, 7)))
            continue
        test_kill('before-pwrite')
        cfd = open_own(chunk_p, os.O_RDONLY, a)
        try:
            pos = 0
            while pos < got:
                buf = os.pread(cfd, min(COPY, got - pos), pos)
                if not buf:
                    raise Refuse(5, 'chunk file shorter than received')
                n = os.pwrite(afd, buf, S + pos)
                if n != len(buf):
                    raise Refuse(5, 'short pwrite')
                pos += n
        finally:
            os.close(cfd)
        os.fsync(afd)
        test_kill('after-pwrite')
        com['offset'] = E + 1
        atomic_json(com_p, com, a)
        unlink_own(chunk_p, a); unlink_own(hdr_p, a)
        off, failures, chunks = E + 1, 0, chunks + 1
        COMMITTED[0] = chunks
        log('chunk-committed', start=S, end=E, offset=off, total=N)
    if os.fstat(afd).st_size != N:
        raise Refuse(5, 'archive size differs from the committed total')
    os.close(afd)
    atomic_json(done_p, {'format': FMT, 'url': url, 'manifestSha256': a.manifest_sha256, 'total': N, **pins, 'completedAt': now(),
                         'note': 'transport only: integrity is the BLAKE3 of the extracted outputs in a later, separate phase'}, a)
    log('fetch-complete', total=N); os.close(lk); return 0


def main(argv=None):
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('probe', 'fetch'):
        p = sub.add_parser(name)
        for k in ('--manifest', '--manifest-sha256', '--expect-url', '--work-dir', '--curl'):
            p.add_argument(k, required=True)
        p.add_argument('--expect-total', type=int, required=True); p.add_argument('--owner-uid', type=int, required=True)
        p.add_argument('--reserve-bytes', type=int, required=True)
        p.add_argument('--allow-http-loopback', action='store_true', help='OFFLINE TESTS ONLY: permits http://127.0.0.1 and test kill hooks')
        p.add_argument('--chunk-seconds', type=int, default=600); p.add_argument('--stall-seconds', type=int, default=60)
        if name == 'fetch':
            p.add_argument('--chunk-bytes', type=int, default=MAX_CHUNK)
            p.add_argument('--max-failures', type=int, default=30); p.add_argument('--backoff-cap', type=int, default=120)
            p.add_argument('--expect-etag'); p.add_argument('--expect-last-modified')
    a = ARGS = ap.parse_args(argv)
    try:
        if a.owner_uid != os.getuid():
            raise Refuse(2, '--owner-uid must equal the running uid (explicit production ownership)', uid=os.getuid())
        if a.reserve_bytes < MIN_RESERVE:
            raise Refuse(2, f'--reserve-bytes must be >= {MIN_RESERVE}')
        if a.cmd == 'fetch' and not (MIN_CHUNK <= a.chunk_bytes <= MAX_CHUNK):
            raise Refuse(2, f'--chunk-bytes must be within [{MIN_CHUNK}, {MAX_CHUNK}]')
        if not os.path.isabs(a.curl) or not os.path.isabs(a.work_dir):
            raise Refuse(2, '--curl and --work-dir must be absolute')
        return {'probe': cmd_probe, 'fetch': cmd_fetch}[a.cmd](a)
    except Refuse as e:
        log('stopped' if e.rc == 143 else 'refused', rc=e.rc, reason=e.reason, **e.kw); return e.rc
    except OSError as e:
        rc = 3 if e.errno in (errno.ELOOP, errno.EACCES, errno.EPERM) else 5
        log('refused', rc=rc, reason=f'{type(e).__name__}: {e}'); return rc
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        log('refused', rc=5, reason=f'malformed local state: {type(e).__name__}: {e}'); return 5


if __name__ == '__main__':
    sys.exit(main())
