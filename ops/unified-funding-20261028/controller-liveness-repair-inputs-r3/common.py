"""Preparation helpers. Never import this module during source-only preparation."""
from pathlib import Path
import errno, hashlib, json, os, re, stat, subprocess, time

P = Path(__file__).resolve().parent

def require(ok, code):
    if not ok:
        raise RuntimeError(code)

def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def read(name):
    return json.loads((P / name).read_text())

def write(name, value):
    with (P / name).open('x') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n'); f.flush(); os.fsync(f.fileno())

def verify_rows(name):
    for row in read(name)['files']:
        f = Path(row['path'])
        require(str(f.resolve(strict=True)) == row['realpath'], 'external-realpath-drift')
        require(f.stat().st_size == row['bytes'] and sha(f) == row['sha256'], 'external-input-drift')

def inventory(root):
    result = {}
    for here, dirs, files in os.walk(root, followlinks=False):
        for n in dirs + files:
            f = Path(here) / n
            require(not f.is_symlink(), 'symlink-in-workspace')
        for n in files:
            f = Path(here) / n
            require(stat.S_ISREG(f.stat().st_mode), 'nonregular-work-file')
            require(len(result) < 2000, 'work-file-count')
            result[str(f.relative_to(root))] = sha(f)
    return result

def verify_initial():
    for name, h in read('DELIVERY-PINS.json').items():
        require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'delivery-path')
        require(sha(P / name) == h, 'delivery-drift')
    verify_rows('SOURCE-PINS.json'); verify_rows('TOOL-PINS.json')
    require(inventory(P / 'candidate') == read('SEED-PINS.json'), 'candidate-seed-drift')
    require(inventory(P / 'baseline') == read('SEED-PINS.json'), 'baseline-seed-drift')
    require(len(read('SEED-PINS.json')) == read('PLAN.json')['seedFiles'] and len(read('SOURCE-PINS.json')['files']) == read('PLAN.json')['sourceFiles'],
            'seed-or-source-count')

def author_env(tmp=None):
    env = dict(os.environ)
    # Required Max login must not silently become a metered API/cloud run.
    for k in list(env):
        if k.startswith('ANTHROPIC_') or k.startswith('CLAUDE_CODE_USE_') or k in (
                'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CONFIG_DIR'):
            del env[k]
    require(env.get('HOME') == '/home/steven', 'home-must-be-preserved')
    env['PATH'] = '/usr/bin:/bin'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    if tmp is not None:
        env['TMPDIR'] = str(tmp); env['TEST_TMPDIR'] = str(tmp)
    return env

def account_check(plan):
    c = Path(plan['claudeExecutable'])
    require(c.is_absolute() and c.is_file() and not c.is_symlink(), 'claude-executable')
    # auth status only: root preflight and author runner call independently.
    r = subprocess.run([str(c), 'auth', 'status'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=20, env=author_env(), check=False)
    require(r.returncode == 0 and len(r.stdout) <= 65536, 'account-status-failed')
    a = json.loads(r.stdout)
    selected = {k: a.get(k) for k in plan['requiredAccount']}
    require(selected == plan['requiredAccount'], 'required-max-account-unavailable')
    return selected

def process(pid):
    try:
        f = Path('/proc') / str(pid)
        s = (f / 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'startTime': int(s[19]), 'exe': str((f / 'exe').resolve(strict=True)),
                'cgroup': (f / 'cgroup').read_text().strip()}
    except FileNotFoundError:
        return None

def available():
    return next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines()
                if x.startswith('MemAvailable:'))

def scope():
    name = Path('/proc/self/cgroup').read_text().strip()
    require(re.fullmatch(r'0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-[A-Za-z0-9-]+\.scope', name),
            'admitted-shared-queue-scope-required')
    return name, Path('/sys/fs/cgroup' + name[3:])

def members(cg):
    require(not any(x.is_dir() for x in cg.iterdir()), 'unexpected-scope-subtree')
    return {int(x) for x in (cg / 'cgroup.procs').read_text().split()}

def tmp_parent(plan):
    p = Path(plan['tmpParent'])
    for part in [*reversed(p.parents), p]:
        s = part.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid in (0, 1000) and not s.st_mode & 0o022,
                'unsafe-tmp-ancestor')
        for attr in ('system.posix_acl_access', 'system.posix_acl_default'):
            try:
                os.getxattr(part, attr, follow_symlinks=False)
            except OSError as e:
                require(e.errno == errno.ENODATA, 'tmp-acl-unreadable')
            else:
                raise RuntimeError('tmp-ancestor-acl')
    require((s.st_dev, s.st_ino, s.st_uid, stat.S_IMODE(s.st_mode)) ==
            (plan['tmpParentDevice'], plan['tmpParentInode'], 1000, 0o700), 'tmp-parent-drift')
    require(s.st_dev != Path('/').stat().st_dev, 'tmp-on-root-forbidden')
    v = os.statvfs(p)
    require(v.f_bavail * v.f_frsize >= 300 * (1 << 30) + plan['maxWorkBytes'], 'tmp-storage-floor')
    return p
