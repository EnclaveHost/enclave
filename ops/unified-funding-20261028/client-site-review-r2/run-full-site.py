from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
e=dict(os.environ,npm_config_offline="true",npm_config_audit="false",npm_config_fund="false")
r=subprocess.run(["node","scripts/build-site.mjs"],cwd=p/"full-site-build",env=e,timeout=900)
raise SystemExit(r.returncode)
