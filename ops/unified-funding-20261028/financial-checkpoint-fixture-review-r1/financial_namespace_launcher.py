"""SOURCE ONLY. Runs only inside the owned fixture network namespace."""
import os,subprocess
from pathlib import Path
assert os.readlink('/proc/self/ns/net')!=os.readlink('/proc/1/ns/net')
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True,timeout=3)
root=Path('/var/tmp/enclave-financial-fixture-source-20261029-r1')
os.execve('/usr/bin/node',['/usr/bin/node','--max-old-space-size=96',str(root/'financial_fixture_parent.mjs'),str(root/'financial-fixture-profile-PROPOSED.json'),'--execute-owned-financial-fixture'],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
