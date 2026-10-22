#!/usr/bin/env python3
# Relay-attach failure triage r2 (immutable; r1 swapped files in place and was guard-stopped at 274 MiB > 256 in its candidate
# half). ONE named case of test/windows-node-hv-attach-relay.test.mjs in the candidate, then in tmp/base-ad4-tree: a hard-linked
# copy of the candidate whose host.mjs and chain.mjs are separate files holding the COMMITTED HEAD (ad4a72a) bytes. Nothing
# is swapped in place. Hard bounds: --test-timeout, PID namespace with --kill-child, outer timeout -k. Offline loopback; stubs.
import hashlib, os, subprocess
HERE = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review'
CASE = "a relay that offers NO v2"
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
TREES = {'candidate': (HERE + '/candidate', '3881bd289cfd1f49', '3e9fae0392497841'),
         'base ad4a72a': (HERE + '/tmp/base-ad4-tree', '637fbdf6af2eedc8', '86c81124cca6f6e1')}
env = dict(os.environ, PATH=HERE + '/stubs:/usr/local/bin:/usr/bin:/bin', TMPDIR=HERE + '/tmp')
for t in ('ssh', 'scp', 'sftp'): assert subprocess.run([t, 'x'], env=env, capture_output=True).returncode == 97, t
print('[compare] ssh/scp/sftp -> denial stubs (rc=97)', flush=True)
cmd = ['timeout', '-k', '10', '150', 'unshare', '-rn', '--pid', '--fork', '--kill-child', '--mount-proc', 'sh', '-c',
       'ip link set lo up && exec node --test --test-timeout=60000 --test-concurrency=1 --test-reporter=spec --test-name-pattern="$0" test/windows-node-hv-attach-relay.test.mjs', CASE]
codes = {}
for label, (tree, h, c) in TREES.items():
  hh, cc = sha(tree + '/windows/node/host.mjs'), sha(tree + '/windows/node/chain.mjs')
  assert hh.startswith(h) and cc.startswith(c), (label, hh, cc)
  print(f'[compare] === {label}: {tree} host {hh[:16]} chain {cc[:16]}', flush=True)
  codes[label] = subprocess.run(cmd, cwd=tree, env=env).returncode
  print(f'[compare] === {label}: exit {codes[label]}', flush=True)
print('[compare] exits', codes, flush=True)
