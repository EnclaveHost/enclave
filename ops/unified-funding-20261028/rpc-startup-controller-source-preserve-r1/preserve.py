from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent;f=(p/'PUSH.log').open('x');os.dup2(f.fileno(),1);os.dup2(f.fileno(),2)
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
subprocess.run(['git', 'add', '--', 'windows/rpc/StartupController.cs', 'windows/rpc/ProtectedAttempt.cs', 'test/rpc-windows-worker/StartupControllerHarness.cs', 'test/rpc-windows-worker/run-startup-controller-ci.ps1', '.github/workflows/rpc-startup-controller.yml', 'ops/unified-funding-20261028/rpc-startup-controller-ci-admission-r1'],cwd=s,check=True)
subprocess.run(['git','diff','--cached','--check'],cwd=s,check=True)
subprocess.run(['git','commit','-m','Compose owned RPC permit cleanup guardian and guarded startup'],cwd=s,check=True)
subprocess.run(['git','push','origin','HEAD:main'],cwd=s,check=True,timeout=120)
a=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip();b=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
(p/'PUSH-RESULT.json').write_text(json.dumps({'head':a,'remote':b,'match':a==b})+'\n');assert a==b
