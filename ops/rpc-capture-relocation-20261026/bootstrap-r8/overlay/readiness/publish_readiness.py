#!/usr/bin/env python3
"""publish_readiness.py (base-finality-proof-stage/r6-ops-fixes; PREPARED): run readiness_sampler ONCE as the unprivileged readiness user
and publish its report atomically as <dir>/latest.json (0644). The sampler's own exit code is returned (0 READY, 3 FAIL, 4 INCOMPLETE).
Usage: publish_readiness.py <out-dir> --settings <root-reviewed settings.json>   (enclave-base-readiness.service)
The settings file is root-owned, not group/other writable, no symlink, a JSON object with EXACTLY the REQUIRED keys (plus optional
OPTIONAL keys): the coverage receipt/verdict/origin files, the expected snapshot-manifest and chain-config pins and the finality status
file. Nothing is invented or defaulted for them: a missing/invalid settings file publishes a NOT-READY report (fail closed, exit 4)."""
import json, os, pathlib, re, stat, sys, time
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

REQUIRED = {'coverage-receipt': 'path', 'coverage-verdict': 'path', 'coverage-origin': 'path', 'finality-status': 'path',
            'expect-snapshot-manifest-sha256': 'sha', 'expect-chain-config-sha256': 'sha'}
# historical-origin-segments-stage/r3: the N-anchored coverage evidence replaces (never joins) the legacy receipt/verdict/origin triple
ANCHORED_REQUIRED = {'coverage-anchored-dir': 'path', 'expect-anchored-receipt-sha256': 'sha', 'finality-status': 'path',
                     'expect-snapshot-manifest-sha256': 'sha', 'expect-chain-config-sha256': 'sha'}
OPTIONAL = {'expect-kzg-sha256': 'sha', 'expect-base-sha256': 'sha', 'samples': 'int', 'interval': 'num', 'min-window': 'num',
            'max-finality-status-age': 'int'}
SHA = re.compile(r'[0-9a-f]{64}')


class Config(Exception):
    pass


def load_settings(path, uid=0):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise Config(f'settings {path}: {type(e).__name__}')
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_mode & 0o022:
            raise Config(f'settings {path} must be a root-owned regular file, not group/other writable')
        try:
            doc = json.loads(f.read(1 << 20))
        except ValueError:
            raise Config('settings are not JSON')
    if not isinstance(doc, dict):
        raise Config('settings are not an object')
    required = ANCHORED_REQUIRED if set(doc) & (set(ANCHORED_REQUIRED) - set(REQUIRED)) else REQUIRED
    missing, extra = sorted(set(required) - set(doc)), sorted(set(doc) - set(required) - set(OPTIONAL))
    if missing or extra:
        raise Config(f'settings: missing {missing}, unknown {extra}')
    args = []
    for k, v in doc.items():
        kind = {**required, **OPTIONAL}[k]
        ok = {'path': isinstance(v, str) and v.startswith('/') and '\0' not in v,
              'sha': isinstance(v, str) and bool(SHA.fullmatch(v)),
              'int': isinstance(v, int) and not isinstance(v, bool),
              'num': isinstance(v, (int, float)) and not isinstance(v, bool)}[kind]
        if not ok:
            raise Config(f'settings: {k} is not a valid {kind}')
        args += [f'--{k}', str(v)]
    return args


def publish(out, doc_bytes, mode=0o644):
    tmp = out / f'.publish-{os.getpid()}.json'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        v = memoryview(doc_bytes)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, out / 'latest.json')


def main(argv, sampler=None, settings_uid=0):
    if len(argv) != 3 or argv[1] != '--settings':
        print(__doc__); return 2
    out = pathlib.Path(argv[0])
    try:
        args = load_settings(argv[2], settings_uid)
    except Config as e:
        # fail closed: replace any older READY report with an explicit NOT-READY one (the consumer gate refuses it)
        now = round(time.time(), 3)
        publish(out, json.dumps({'overall': 'INCOMPLETE', 'acceptance': False, 'startedAt': now, 'finishedAt': now,
                                 'gates': {}, 'configError': str(e)[:500]}).encode())
        print(json.dumps({'published': 'NOT-READY', 'why': str(e)})); return 4
    if sampler is None:
        import readiness_sampler as rs
        sampler = rs.main
    tmp = out / f'.sample-{os.getpid()}.json'
    code = sampler(['--out', str(tmp), *args])
    if tmp.exists():
        os.chmod(tmp, 0o644); os.replace(tmp, out / 'latest.json')
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
