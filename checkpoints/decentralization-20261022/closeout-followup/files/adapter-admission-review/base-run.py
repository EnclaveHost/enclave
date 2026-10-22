#!/usr/bin/env python3
# Base comparison (immutable): run the given test files with the COMMITTED HEAD (ad4a72a) windows/node/host.mjs and chain.mjs
# swapped into the candidate (offline, denial stubs first in PATH), then restore both and check them by sha256.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review'
REPO = HERE + '/candidate'
F = [os.path.join(REPO, 'windows/node/host.mjs'), os.path.join(REPO, 'windows/node/chain.mjs')]
sha = lambda b: hashlib.sha256(b).hexdigest()
orig = {f: open(f, 'rb').read() for f in F}
head = {f: subprocess.check_output(['git', '-C', REPO, 'show', 'HEAD:' + os.path.relpath(f, REPO)]) for f in F}
assert subprocess.check_output(['git', '-C', REPO, 'rev-parse', 'HEAD']).decode().startswith('ad4a72a')
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
for t in ('ssh', 'scp', 'sftp'): assert subprocess.run([t, 'x'], env=env, capture_output=True).returncode == 97, t
print('[base-run] ssh/scp/sftp -> denial stubs (rc=97); HEAD', {os.path.basename(f): sha(b)[:16] for f, b in head.items()}, flush=True)
try:
  for f, b in head.items(): open(f, 'wb').write(b)
  r = subprocess.run(['unshare', '-r', '-n', 'bash', '-c', 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec "$@"', 'bash', *sys.argv[1:]], cwd=REPO, env=env)
  code = r.returncode
finally:
  for f, b in orig.items(): open(f, 'wb').write(b)
assert all(sha(open(f, 'rb').read()) == sha(b) for f, b in orig.items()), 'not restored'
print('[base-run] restored; node --test exit', code, flush=True); sys.exit(code)
