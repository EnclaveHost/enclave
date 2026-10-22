from pathlib import Path
import hashlib,json,uuid,shutil
R=Path(__file__).resolve().parent; W=R.parent
S=W/'claude-resumed-20261022/platform-activation/platform-carrier'
for src,name in [(S/'activation/gate/gate-proof.mjs','gate-proof.mjs'),(S/'out/candidate.host-admission.bundle.mjs','candidate.mjs')]:shutil.copyfile(src,R/name)
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert h(R/'candidate.mjs')=='40e8ba71d83c627e85af21d58b9ab0d8b3052504a0e7d9ee47b429948c40bd25'
stage='C:\\ProgramData\\Enclave\\staging\\carrier-gate-'+uuid.uuid4().hex[:12]
s=(W/'root-platform-gate-polkachu-20261022/gate.ps1').read_text()
s=s.replace('C:\\ProgramData\\Enclave\\staging\\policygate-ab4cdc0dc872',stage).replace('C:\\Program Files\\Enclave\\control\\windows\\node\\host-admission.bundle.mjs',stage+'\\candidate.mjs')
s=s.replace('6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18',h(R/'candidate.mjs')).replace('72346b95702ed7ea0a69d0c813844d925bb8c0d48216b79a1c7e9f9437',h(R/'gate-proof.mjs'))
s=s.replace('72346b95702ed7ea6d14ae0a69d0c813844d925bb8c0d48216b79a1c7e9f9437',h(R/'gate-proof.mjs'))
s=s.replace("$si.EnvironmentVariables['GATE_OPTION']='P4-independent';", "$si.EnvironmentVariables['GATE_OPTION']='RC4-staged-candidate';$si.EnvironmentVariables['GATE_CARRIERS']='"+json.dumps({'importDir':stage.replace('\\','/')+'/policy-import'},separators=(',',':'))+"';")
(R/'gate.ps1').write_text(s)
plan={'stage':stage,'gateSha':h(R/'gate-proof.mjs'),'bundleSha':h(R/'candidate.mjs'),'psSha':h(R/'gate.ps1'),'scope':'Staged candidate only. Native Node on Windows, carrier config and fresh public chain 3-of-4 reads. No installed bundle/config/policy/anchor change, no production restart. Unanchored state cannot prove live anchored document retrieval.'}
(R/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
s=(W/'root-platform-gate-polkachu-20261022/run.py').read_text()
s=s.replace("gate=R/'gate-proof.mjs'", "gate=R/'gate-proof.mjs';bundle=R/'candidate.mjs'")
s=s.replace("result['gate']=m.ps(script,90)","cp=subprocess.run(['timeout','120','scp','-q','-o','BatchMode=yes',str(bundle),'minipc:/'+(stage+'\\\\candidate.mjs').replace('\\\\','/')],capture_output=True,text=True)\n assert cp.returncode==0,cp.stderr[-400:]\n result['gate']=m.ps(script,90)")
s=s.replace("assert hashlib.sha256(script.encode()).hexdigest()==plan['psSha'];", "assert hashlib.sha256(bundle.read_bytes()).hexdigest()==plan['bundleSha'];assert hashlib.sha256(script.encode()).hexdigest()==plan['psSha'];")
s=s.replace("if(@(Get-ChildItem -LiteralPath $d -Force).Count -ne 1)","if((FileSha ($d+'\\\\candidate.mjs')) -ne "+"\"+q(plan['bundleSha'])+\""+"){throw 'own candidate changed'};if(@(Get-ChildItem -LiteralPath $d -Force).Count -ne 2)")
s=s.replace('Remove-Item -LiteralPath $f;Remove-Item -LiteralPath $d;',"Remove-Item -LiteralPath $f;Remove-Item -LiteralPath ($d+'\\\\candidate.mjs');Remove-Item -LiteralPath $d;")
(R/'run.py').write_text(s)
print(json.dumps(plan))
