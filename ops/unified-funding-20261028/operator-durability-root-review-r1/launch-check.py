from pathlib import Path
import subprocess,sys
p=Path(__file__).resolve().parent
name=sys.argv[1]
assert name.replace("-", "").isalnum()
assert (p/("run-"+name+".py")).exists()
assert not (p/(name+"-result.tap")).exists()
w=Path("/home/steven/Documents/Codex/2026-10-18/wo")
subprocess.run(["systemd-run","--user","--unit=enclave-operator-durability-r1-"+name+"-root-20261029","--property=RuntimeMaxSec=300","--property=TimeoutStopSec=3","--property=MemoryMax=512M","--property=MemorySwapMax=0","--property=CPUQuota=100%","--collect","/usr/bin/python3",str(w/"work/claude-test-queue.py"),"--mib","512","--log",str(p/(name+".outer.guard.log")),"--","node",str(w/"work/enclave/test/helpers/memory-guard.mjs"),"--max-rss-mib","450","--floor-available-mib","27648","--log",str(p/(name+".inner.guard.log")),"--","python3",str(p/("run-"+name+".py"))],check=True)
