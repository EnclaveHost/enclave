from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
repo=root/'work/enclave'; out=root/'work/windows-native-hardening-fixed-review';out.mkdir(exist_ok=True)
src=(repo/'windows/installer/EnclaveSetup.cs').read_text();a=src.index('    static class ReleaseChannel');b=src.index("    /// <summary>Setup's progress:",a)
h=(repo/'test/windows-native/Harness.cs').read_text().replace('// @@RELEASE_CHANNEL@@',src[a:b]);(out/'Harness.cs').write_text(h)
for f in ['fixtures.json','node-verdicts.json']:(out/f).write_bytes((repo/'test/windows-native'/f).read_bytes())
remote='C:\\Users\\claude\\AppData\\Local\\Temp\\enclave-native-hardening-fixed-20261020'
def ssh(cmd,log,timeout=60):
 p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc',cmd],capture_output=True,text=True,errors="replace",timeout=timeout);(out/log).write_text(p.stdout+p.stderr);print(log,p.returncode,p.stdout[-1000:],p.stderr[-300:],flush=True);return p
r=ssh("New-Item -ItemType Directory -Force -Path '"+remote+"' | Out-Null",'mkdir.log');assert r.returncode==0
for f in ['Harness.cs','fixtures.json','node-verdicts.json']:
 p=subprocess.run(['scp','-q','-o','BatchMode=yes',str(out/f),'minipc:'+remote.replace('\\','/')+'/'+f],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stderr
csc='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
r=ssh("& '"+csc+"' /nologo /target:exe /r:System.Web.Extensions.dll /r:System.Core.dll '/out:"+remote+"\\Harness.exe' '"+remote+"\\Harness.cs'; exit $LASTEXITCODE",'compile.log');assert r.returncode==0
r=ssh("& '"+remote+"\\Harness.exe' verdicts '"+remote+"\\fixtures.json'; exit $LASTEXITCODE",'verdicts.log');assert r.returncode==0
fx=json.loads((out/'fixtures.json').read_text());node=json.loads((out/'node-verdicts.json').read_text());vs={}
for l in r.stdout.splitlines():
 p=l.split('\t',3)
 if len(p)==4 and p[0]=='verdict':vs[int(p[1])]={'verdict':p[2],'detail':p[3]}
checks=[]
for i,c in enumerate(fx['cases']):
 v=vs.get(i); want=node[i]['verdict'] if c.get('agreeOnly') else c['expect'];checks.append({'name':c['name'],'expected':want,'actual':v,'ok':bool(v and v['verdict']==want)})
(out/'verdict-checks.json').write_text(json.dumps(checks,indent=2)+'\n');print('verdicts',sum(c['ok'] for c in checks),'/',len(checks),flush=True)
r=ssh("& '"+remote+"\\Harness.exe' transport '"+remote+"\\fixtures.json' '"+remote+"\\transport'; exit $LASTEXITCODE",'transport.log',90)
(out/'source.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha256':hashlib.sha256(src.encode()).hexdigest(),'verifierSha256':hashlib.sha256(src[a:b].encode()).hexdigest(),'harnessSha256':hashlib.sha256(h.encode()).hexdigest(),'cases':len(checks),'passed':sum(c['ok'] for c in checks),'transportExitCode':r.returncode,'remote':remote,'scope':'Native C# verifier and loopback download tests only; no installer or PowerShell runtime executed; no policy changed.'},indent=2)+'\n')
