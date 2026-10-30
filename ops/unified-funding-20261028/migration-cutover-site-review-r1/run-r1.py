from pathlib import Path
import subprocess
p=Path(__file__).resolve().parent
r=subprocess.run(["python3",str(p/"generator/generate_site.py"),"--link-viem"],timeout=30)
if r.returncode: raise SystemExit(r.returncode)
raise SystemExit(subprocess.run(["node","--test","--test-concurrency=1",str(p/"test/site-cutover.test.mjs")],timeout=120).returncode)
