# Appended to the already-tested directory activation engine with NO_MAIN=True.
# Only the mirror-specific paths/readback and public readiness file differ.
import stat

PREPARED = CF.with_name(CF.name + '.platform-policy-prepared')
BACKUP = CF.with_name(CF.name + '.before-platform-policy')
JOURNAL = CF.with_name('platform-policy.journal.jsonl')
LOCK = CF.with_name('platform-policy.lock')
GRAMMAR = r'^/platform-policy/(0x[0-9a-f]{64}|latest|ready)\.json$'
POLICY_ROOT = Path(P.get('policy_root', '/var/lib/enclave-platform-policy'))
READY = b'{"format":"enclave-platform-policy-mirror/v1","policyActivated":false}\n'


def running_has_route():
    try:
        conn = UnixHTTP(P['admin_socket'])
        try:
            conn.request('GET', '/config/apps/http', headers={'Host': 'localhost'})
            response = conn.getresponse()
            if response.status != 200:
                return None
            doc = json.loads(response.read())
        finally:
            conn.close()
        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)
            elif isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
        values = set(strings(doc))
        return GRAMMAR in values and str(POLICY_ROOT) in values
    except Exception:
        return None


def prepare_public_readiness():
    # No policy document, signature, 'latest' alias or chain anchor is created here.
    if POLICY_ROOT.is_symlink():
        raise RuntimeError('public mirror directory is a symlink')
    try:
        POLICY_ROOT.mkdir(mode=0o755)
    except FileExistsError:
        pass
    else:
        POLICY_ROOT.chmod(0o755)
    info = POLICY_ROOT.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022 or info.st_mode & 0o005 != 0o005:
        raise RuntimeError('public mirror directory is not a protected directory')
    path = POLICY_ROOT / 'ready.json'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not info.st_mode & 0o004 or info.st_size != len(READY) or os.read(fd, len(READY) + 1) != READY:
                raise RuntimeError('different existing readiness file; not overwritten')
        finally:
            os.close(fd)
        return
    try:
        os.fchmod(fd, 0o644)
        _write_all(fd, READY)
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(POLICY_ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def validate(path):
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, XDG_DATA_HOME=tmp + '/data', XDG_CONFIG_HOME=tmp + '/config')
        result = subprocess.run([P['caddy'], 'validate', '--config', str(path), '--adapter', 'caddyfile'],
                                capture_output=True, text=True, env=env, timeout=120)
    if result.returncode:
        raise RuntimeError('caddy validate failed: ' + result.stderr[-1200:])


def verify(pre):
    if running_has_route() is not True:
        raise RuntimeError('running config lacks policy mirror')
    status, headers, body = https('GET', '/platform-policy/ready.json', {'Origin': ORIGIN})
    if status != 200 or body != READY or headers.get('access-control-allow-origin') != '*':
        raise RuntimeError('policy readiness readback failed')
    if headers.get('access-control-allow-credentials') or headers.get('set-cookie'):
        raise RuntimeError('public mirror unexpectedly uses credentials')
    for method, path in [('POST', '/platform-policy/ready.json'), ('GET', '/platform-policy/unknown.txt')]:
        if https(method, path)[0] != 404:
            raise RuntimeError('policy mirror did not refuse unsupported request')
    status, _, body = https('GET', '/v1/network/records')
    local_status, local_body = direct('/v1/network/records')
    if status != 200 or local_status != 200 or json.loads(body).get('version') != 1:
        raise RuntimeError('existing directory readback failed')
    ids = lambda payload: sorted(x['record']['record']['providerId'] for x in json.loads(payload).get('providers', []))
    if ids(body) != ids(local_body):
        raise RuntimeError('directory differs from local provider records')
    post = legacy_probe()
    if any('status' not in pre[p] or post[p].get('status') != pre[p]['status'] or post[p].get('directoryShaped') for p in LEGACY):
        raise RuntimeError('legacy route health changed during mirror activation')
    return {'ready': True, 'unsupportedRequestsRefused': True, 'directoryEqualsLocal': True,
            'legacy': post, 'policyActivated': False}


original_apply = apply


def apply():
    # Refuse unrelated Caddy drift before even creating the readiness marker.
    if sha(CF) not in (BASE, RESULT):
        return {'state': 'refused', 'error': 'Caddyfile drift; no preparation performed'}
    prepare_public_readiness()
    return original_apply()


if not globals().get('TEST_OVERRIDES'):
    main()
