from pathlib import Path
import subprocess,json,re,datetime
b=Path(__file__).resolve().parent
j=subprocess.check_output(['journalctl','--user','-u','enclave-metal.service','--since','-20 min','--no-pager'],text=True)
rows={}
for line in j.splitlines():
 if not any(s in line for s in ('release list could not be read','Unaffordable','RPC quorum')):continue
 ids=re.findall(r'0x[a-f0-9]{64}',line)
 if not ids:continue
 id=ids[0];v=rows.setdefault(id,{'releaseTimeout':0,'unaffordable':0,'rpcQuorum':0})
 k='releaseTimeout' if 'release list could not be read' in line else 'unaffordable' if 'Unaffordable' in line else 'rpcQuorum';v[k]+=1
ssh=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script="""import pathlib,json,subprocess,urllib.parse
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
e=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_text().split(chr(0)) if '=' in x)
o={}
for k,v in e.items():
 if 'RPC' in k:
  o[k]=[urllib.parse.urlsplit(x).hostname for x in v.split(',')]
print(json.dumps(o))
"""
p=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True,timeout=25);assert p.returncode==0
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'linuxLast20Minutes':rows,'relayRpcHosts':json.loads(p.stdout)}
(b/'queued-diagnosis.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2))
