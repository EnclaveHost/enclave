from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent;f=(p/'PUSH.log').open('x');os.dup2(f.fileno(),1);os.dup2(f.fileno(),2)
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
subprocess.run(['git', 'add', '--', 'windows/rpc/stage-private-media.ps1', 'windows/rpc/README.md', 'ops/unified-funding-20261028/rpc-private-media-stage-r1', 'ops/unified-funding-20261028/rpc-private-media-source-r1', 'ops/unified-funding-20261028/rpc-private-media-target-read-r1'],cwd=s,check=True)
subprocess.run(['git','diff','--cached','--check'],cwd=s,check=True)
subprocess.run(['git','commit','-m','Stage complete RPC guest media with verified private Windows custody'],cwd=s,check=True)
subprocess.run(['git','push','origin','HEAD:main'],cwd=s,check=True,timeout=120)
a=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip();b=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
(p/'PUSH-RESULT.json').write_text(json.dumps({'head':a,'remote':b,'match':a==b})+'\n');assert a==b
