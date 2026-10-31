from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent;f=(p/'PUSH.log').open('x');os.dup2(f.fileno(),1);os.dup2(f.fileno(),2)
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
subprocess.run(['git', 'add', '--', '.github/workflows/rpc-legacy-cohort.yml', '.github/workflows/rpc-legacy-handoff.yml', '.github/workflows/rpc-owned-definition.yml', '.github/workflows/rpc-provider-worker.yml', '.github/workflows/rpc-startup-cleanup.yml', '.github/workflows/rpc-template-fence.yml', '.github/workflows/rpc-template-system.yml', 'test/rpc-windows-worker/OwnedVmDefinitionHarness.cs', 'test/rpc-windows-worker/run-definition-ci.ps1', 'test/rpc-windows-worker/run-legacy-cohort-ci.ps1', 'test/rpc-windows-worker/run-legacy-handoff-ci.ps1', 'test/rpc-windows-worker/run-provider-worker-ci.ps1', 'test/rpc-windows-worker/run-startup-cleanup-ci.ps1', 'test/rpc-windows-worker/run-template-fence-ci.ps1', 'test/rpc-windows-worker/run-template-system-ci.ps1', 'windows/rpc/DefinitionWorkerController.cs', 'windows/rpc/DefinitionWorkerEntry.cs', 'windows/rpc/OwnedVmDefinition.cs', 'windows/rpc/ProtectedAttempt.cs', 'windows/rpc/ProviderWorkerEntry.cs', 'windows/rpc/README.md', 'test/rpc-windows-worker/OwnedVmBootHarness.cs', 'windows/rpc/BootStartBinding.cs', 'windows/rpc/OwnedVmBoot.cs', 'ops/unified-funding-20261028/rpc-boot-ci-admission-r1'],cwd=s,check=True)
subprocess.run(['git','diff','--cached','--check'],cwd=s,check=True)
subprocess.run(['git','commit','-m','Integrate owned Gen2 boot attachments and start-side graph verification'],cwd=s,check=True)
subprocess.run(['git','push','origin','HEAD:main'],cwd=s,check=True,timeout=120)
a=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip();b=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
(p/'PUSH-RESULT.json').write_text(json.dumps({'head':a,'remote':b,'match':a==b})+'\n');assert a==b
