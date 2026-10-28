from pathlib import Path
import json
import subprocess

p = Path(__file__).resolve().parent
a = json.loads(subprocess.check_output(['/home/steven/.local/bin/claude', 'auth', 'status'], text=True))
if not a.get('loggedIn') or a.get('email') != 'steven.r.batchelor@gmail.com':
    raise SystemExit('Required Claude account not active')
with (p / 'claude.out').open('x') as out:
    r = subprocess.run([
        '/home/steven/.local/bin/claude', '-p', (p / 'TASK.txt').read_text(),
        '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Write',
        '--tools', 'Read,Grep,Write', '--max-turns', '36', '--output-format', 'json'
    ], stdout=out, stderr=subprocess.STDOUT, timeout=1100, cwd=str(p))
(p / 'claude.rc').write_text(str(r.returncode) + '\n')
raise SystemExit(r.returncode)
