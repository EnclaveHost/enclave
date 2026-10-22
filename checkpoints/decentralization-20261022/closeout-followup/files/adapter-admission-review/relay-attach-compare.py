#!/usr/bin/env python3
# Relay-attach failure triage (immutable): ONE named case of test/windows-node-hv-attach-relay.test.mjs, run on the candidate
# and then with the COMMITTED HEAD (ad4a72a) windows/node/host.mjs + chain.mjs swapped in - same tree, fixtures and environment.
# Hard bounds: node --test-timeout per test, a PID namespace with --kill-child (every child dies with it), and an outer
# timeout -k. Offline loopback namespace; ssh/scp/sftp denial stubs proved first. Both files restored and checked by sha256.
import hashlib, os, subprocess, sys
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review'
REPO = HERE + '/candidate'
CASE = "a relay that offers NO v2"
F = [os.path.join(REPO, 'windows/node/host.mjs'), os.path.join(REPO, 'windows/node/chain.mjs')]
sha = lambda b: hashlib.sha256(b).hexdigest()
orig = {f: open(f, 'rb').read() for f in F}
head = {f: subprocess.check_output(['git', '-C', REPO, 'show', 'HEAD:' + os.path.relpath(f, REPO)]) for f in F}
assert subprocess.check_output(['git', '-C', REPO, 'rev-parse', 'HEAD']).decode().startswith('ad4a72a')
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
for t in ('ssh', 'scp', 'sftp'): assert subprocess.run([t, 'x'], env=env, capture_output=True).returncode == 97, t
print('[compare] ssh/scp/sftp -> denial stubs (rc=97)', flush=True)
cmd = ['timeout', '-k', '10', '150', 'unshare', '-rn', '--pid', '--fork', '--kill-child', '--mount-proc', 'sh', '-c',
       'ip link set lo up && exec node --test --test-timeout=60000 --test-concurrency=1 --test-reporter=spec --test-name-pattern="$0" test/windows-node-hv-attach-relay.test.mjs', CASE]
def run(label, files):
  print(f'[compare] === {label}: ' + ', '.join(f'{os.path.basename(f)} {sha(b)[:16]}' for f, b in files.items()), flush=True)
  try:
    for f, b in files.items(): open(f, 'wb').write(b)
    r = subprocess.run(cmd, cwd=REPO, env=env)
  finally:
    for f, b in orig.items(): open(f, 'wb').write(b)
  print(f'[compare] === {label}: exit {r.returncode}', flush=True)
  return r.returncode
codes = {'candidate': run('candidate', orig), 'base ad4a72a': run('base ad4a72a', head)}
assert all(sha(open(f, 'rb').read()) == sha(b) for f, b in orig.items()), 'not restored'
print('[compare] restored; exits', codes, flush=True)
