from pathlib import Path
import subprocess
p=Path(__file__).resolve().parent
for r in ["generator/generate_site.py", "fixture/generate_fixture.py"]:
 subprocess.run(["python3",str(p/r)]+(["--link-viem"] if r.startswith("generator") else []),check=True,timeout=30)
