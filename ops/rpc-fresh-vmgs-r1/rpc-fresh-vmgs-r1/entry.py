from pathlib import Path
import json,subprocess,resource
resource.setrlimit(resource.RLIMIT_FSIZE,(128<<20,128<<20))
subprocess.run(['/usr/bin/python3','-B','/src/rpc/native/test_prepare_vmgs.py','-v'],check=True,timeout=15)
subprocess.run(['/usr/bin/python3','-B','/src/rpc/native/prepare_vmgs.py','--tool','/inputs/vmgstool','--out','/output/state'],check=True,timeout=25)
r=json.loads(Path('/output/state/build.json').read_text())
assert all(r[k] is False for k in ('windowsAccepted','providerSharingQualified','growthQualified','hardwareIdentity','deployed'))
print(json.dumps(r))
