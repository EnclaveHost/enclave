expected={'compose_loader_release.py': 'bda0174b6f56bbb6fbf6e4b74e7f6528037066973d6a20c629e91c8aa9259a2c', 'release-manifest.py': '6facdb9a77da31e6ddaf5a544f58a4966ea8dfdede87ad36e50818e22adbfd6b', 'shieldmodel': 'acd688ecd7fdd1bca3a2e6269a948bab36fa066e8dca2b91b1886d4fe4c68d28', 'app.bundle': '5bac47ac3b99d9999314ac3f5ee7c2749defdde98b2a52212302d05da13d58eb'}
from pathlib import Path
import hashlib,subprocess,json
p=Path('/tmp/enclave-loader-rollout-20261028')
for name,digest in expected.items():
 assert hashlib.file_digest((p/name).open('rb'),'sha256').hexdigest()==digest,name
args=['systemd-run','--unit=enclave-loader-compose-20261028','--wait','--pipe','--collect','--property=MemoryMax=512M','--property=MemorySwapMax=0','--property=CPUQuota=100%','--property=RuntimeMaxSec=180','python3',str(p/'compose_loader_release.py'),'--base','/opt/enclave-predict/release-5cab66e4','--base-id','5cab66e478a78adf69c5bb6f058117fcd91cddfb72ca3f6c5d47c109cc47ba17','--loader',str(p/'shieldmodel'),'--loader-sha256',expected['shieldmodel'],'--manifest-tool',str(p/'release-manifest.py'),'--manifest-tool-sha256',expected['release-manifest.py'],'--out','/opt/enclave-predict/release-af50d526','--receipt',str(p/'remote-receipt.json')]
subprocess.run(args,check=True,timeout=190)
r=json.loads((p/'remote-receipt.json').read_text());assert r['new']['release_id']=='af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae'
print('REMOTE RELEASE VERIFIED',r['new']['release_id'])
