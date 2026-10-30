#!/usr/bin/env python3
"""require_ready.py (base-finality-proof-stage/r6; PREPARED): the CONSUMER gate. A Base node is usable by consumers only while the
latest readiness report (written by enclave-base-readiness.service as the `enclave-readiness` user) is fresh, READY, and its
post-anchor-finality gate passed - i.e. root's finality status names the RUNNING node process and the served chain holds the proven
block. After any Base restart that fails until a post-restart proof is recorded and republished.
  check                 exit 0 ready / 1 not (consumer units: ExecCondition=)
  enforce <units-file>  root timer: start the listed consumer units while ready, stop them otherwise"""
import json, os, pathlib, pwd, stat, subprocess, sys, time

REPORT = pathlib.Path('/run/enclave-rpc-readiness/latest.json')
READINESS_USER = 'enclave-readiness'
MAX_AGE_SEC = 600


def ready(report=REPORT, owner_uid=None, max_age=MAX_AGE_SEC, now=None):
    owner_uid = pwd.getpwnam(READINESS_USER).pw_uid if owner_uid is None else owner_uid
    try:
        fd = os.open(report, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        return False, f'no readiness report ({type(e).__name__})'
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != owner_uid or st.st_mode & 0o022:
            return False, 'the readiness report is not a regular file of the readiness user (not group/other writable)'
        try:
            doc = json.loads(f.read(16 << 20))
        except ValueError:
            return False, 'the readiness report is not JSON'
    g = ((doc.get('gates') or {}).get('post-anchor-finality') or {}) if isinstance(doc, dict) else {}
    if doc.get('overall') != 'READY' or doc.get('acceptance') is not True or g.get('status') != 'pass':
        return False, f'not READY (overall {doc.get("overall")!r}, post-anchor-finality {g.get("status")!r} {g.get("code", "")})'
    age = (now or time.time()) - float(doc.get('finishedAt') or 0)
    if not 0 <= age <= max_age:
        return False, f'the readiness report is {int(age)} s old (max {max_age})'
    return True, 'READY'


def enforce(units_file):
    st = os.lstat(units_file)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise SystemExit(f'{units_file} must be a root-owned regular file')
    units = [l.strip() for l in pathlib.Path(units_file).read_text().splitlines() if l.strip() and not l.startswith('#')]
    ok, why = ready()
    for u in units:
        subprocess.run(['systemctl', 'start' if ok else 'stop', '--no-block', u], check=False, env={'PATH': '/usr/bin:/bin'})
    print(json.dumps({'ready': ok, 'why': why, 'units': units}))
    return 0


def main(argv):
    if argv[:1] == ['check']:
        ok, why = ready(); print(why); return 0 if ok else 1
    if len(argv) == 2 and argv[0] == 'enforce':
        return enforce(argv[1])
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
