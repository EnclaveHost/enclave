from pathlib import Path
import subprocess

p = Path(__file__).resolve().parent
assert not (p / 'generated').exists(), 'Never overwrite an earlier generated result'
subprocess.run(['python3', str(p / 'prepare.py'), '--require-pinned'], check=True, timeout=30)
raise SystemExit(subprocess.run(['node', '--test', '--test-concurrency=1', *map(str, sorted((p / 'test').glob('*.test.mjs')))], timeout=180).returncode)
