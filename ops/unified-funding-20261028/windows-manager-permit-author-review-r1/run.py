from pathlib import Path
import hashlib, json, os, subprocess, time

p = Path(__file__).resolve().parent
os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})
sha = lambda f: hashlib.sha256(Path(f).read_bytes()).hexdigest()
if sha(p / 'TASK.reviewed.txt') != 'c4ca6e6569c6b00384aa27b0724316f2f161e7dff1fb0100933ddf01c2855da1':
    raise SystemExit('Reviewed task drift')
pins = json.loads((p / 'input-pins.json').read_text())
def drift():
    return [name for name, digest in pins.items() if not Path(name).is_file() or sha(name) != digest]
if drift():
    raise SystemExit('Qualified input drift; no author started')
seed = json.loads((p / 'installed-seed-pins.json').read_text())
if len(seed) != 119 or any(sha(p / 'candidate' / name) != digest for name, digest in seed.items()):
    raise SystemExit('Installed seed drift; no author started')
actual = {str(f.relative_to(p / 'candidate')) for f in (p / 'candidate').rglob('*') if f.is_file()}
if actual != set(seed):
    raise SystemExit('Installed seed contains unexpected or missing files; no author started')
# Exclusive record prevents accidental second invocation. No automatic retries.
with (p / 'attempt.json').open('x') as out:
    out.write(json.dumps({'pid': os.getpid(), 'at': time.time(), 'authorStarted': False}) + '\n')
a = json.loads(subprocess.check_output(['/home/steven/.local/bin/claude', 'auth', 'status'], text=True, timeout=20))
if not a.get('loggedIn') or a.get('email') != 'steven.r.batchelor@gmail.com' or a.get('subscriptionType') != 'max':
    raise SystemExit('Required Claude Max account not active; no author started')
(p / 'account-verification.json').write_text(json.dumps({k: a.get(k) for k in ['loggedIn', 'email', 'subscriptionType']}) + '\n')
(p / 'started.json').write_text(json.dumps({'pid': os.getpid(), 'startedAt': time.time(), 'inputHashes': pins, 'freshSession': True}) + '\n')
rc = 1
try:
    with (p / 'claude.out').open('x') as out:
        result = subprocess.run([
            '/home/steven/.local/bin/claude', '-p', (p / 'TASK.txt').read_text(),
            '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Write', '--tools', 'Read,Grep,Write',
            '--max-turns', '55', '--output-format', 'json'
        ], stdout=out, stderr=subprocess.STDOUT, timeout=1800, cwd=p)
        rc = result.returncode
except subprocess.TimeoutExpired:
    rc = 124
finally:
    (p / 'claude.rc').write_text(str(rc) + '\n')
    (p / 'finished.json').write_text(json.dumps({'rc': rc, 'finishedAt': time.time(), 'inputDrift': drift()}) + '\n')
raise SystemExit(rc)
