from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
subprocess.run(['python3', str(root / 'generator/generate_cutover.py'), '--link-viem'], check=True, timeout=30)
raise SystemExit(subprocess.run(['node', '--test', '--test-concurrency=1', str(root / 'test/cutover-pause.test.mjs')], timeout=120).returncode)
