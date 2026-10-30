from pathlib import Path
import hashlib, json, os, subprocess, time
p = Path(__file__).resolve().parent
assert os.sched_getaffinity(0) == {1}
g = json.loads((p / 'INPUT.json').read_text())
def check():
    for k in ['probe', 'client']:
        assert hashlib.sha256(Path(g[k]).read_bytes()).hexdigest() == g[k + '_sha256']
check()
with (p / 'ATTEMPT.json').open('x') as f:
    json.dump({'startedAt': time.time(), 'action': 'authenticated readonly commitment snapshot'}, f)
r = subprocess.run(['/usr/bin/node', g['probe'], '--client', g['client'],
                    '--client-sha256', g['client_sha256'], '--key-file', g['key_file'],
                    '--url', g['url']], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                   env={'PATH': '/usr/bin:/bin'}, timeout=25)
check()
assert len(r.stdout) < 65536
rec = json.loads(r.stdout)
with (p / 'RESULT.json').open('x') as f:
    json.dump({'capturedAt': time.time(), 'rc': r.returncode, 'snapshot': rec}, f, indent=2)
raise SystemExit(r.returncode)
