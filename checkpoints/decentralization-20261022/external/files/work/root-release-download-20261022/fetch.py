from pathlib import Path
import subprocess,hashlib,json,datetime
W=Path.cwd();I=W/'work/claude-resumed-20261022/distribution-assembly/inputs';I.mkdir(exist_ok=True)
items=[('enclave-host-2026.10.12.47.zip','e010ea5b76ca0628e5b2663ef74d3ee3caa17039589112e61b6477592a5f939d',771688006),('EnclaveSetup-2026.10.12.47.exe','f9779425f1f59e626be411122c87364f5d281893a66711fda8452c2dfef9381c',None)]
results=[]
for name,want,size in items:
 dst=I/name;part=I/(name+'.part');assert not dst.exists() and not part.exists(),'existing artifact; inspect before retry'
 url='https://get.enclave.host/windows/'+name
 r=subprocess.run(['curl','--fail','--location','--proto','=https','--proto-redir','=https','--silent','--show-error','--connect-timeout','15','--max-time','300','--max-filesize',str(size or 100000000),'--output',str(part),url],capture_output=True,text=True,timeout=310)
 h=hashlib.sha256()
 if part.exists():
  with part.open('rb') as f:
   for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 actual=part.stat().st_size if part.exists() else 0
 ok=r.returncode==0 and h.hexdigest()==want and (size is None or actual==size)
 out={'name':name,'url':url,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'bytes':actual,'sha256':h.hexdigest(),'verified':ok,'stderr':r.stderr[-1200:]};results.append(out)
 if ok:part.rename(dst)
 print(json.dumps(out),flush=True)
 if not ok:break
with (W/'work/root-release-download-20261022/result.json').open('x') as f:json.dump(results,f,indent=2)
raise SystemExit(0 if len(results)==2 and all(x['verified'] for x in results) else 1)
