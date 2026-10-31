from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent;f=(p/'PUSH.log').open('x');os.dup2(f.fileno(),1);os.dup2(f.fileno(),2)
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
subprocess.run(['git', 'add', '--', 'windows/rpc/README.md', 'windows/rpc/build-boot-media.py', 'ops/unified-funding-20261028/rpc-boot-media-local-resource-r1', 'ops/unified-funding-20261028/rpc-boot-media-control-read-r1', 'ops/unified-funding-20261028/rpc-boot-media-control-read-r2', 'ops/unified-funding-20261028/rpc-boot-media-control-read-r3', 'ops/unified-funding-20261028/rpc-boot-media-tools-r1', 'ops/unified-funding-20261028/rpc-boot-media-transfer-r1', 'ops/unified-funding-20261028/rpc-boot-media-build-r1'],cwd=s,check=True)
subprocess.run(['git','diff','--cached','--check'],cwd=s,check=True)
subprocess.run(['git','commit','-m','Build and verify owned RPC boot media on existing Control guest'],cwd=s,check=True)
subprocess.run(['git','push','origin','HEAD:main'],cwd=s,check=True,timeout=120)
a=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip();b=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
(p/'PUSH-RESULT.json').write_text(json.dumps({'head':a,'remote':b,'match':a==b})+'\n');assert a==b
