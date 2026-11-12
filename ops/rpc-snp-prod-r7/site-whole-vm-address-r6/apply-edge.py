from pathlib import Path
import sys,json,subprocess,shlex,base64,hashlib
p=Path(__file__).resolve().parent
h=sys.argv[1]
assert h in ['us-west','ca-east','ap-southeast','eu-central']
j=json.loads((p/'release.json').read_text());b=json.loads((p/(h+'.current.json')).read_text())
assert b['files']==json.loads((p/'base-files.json').read_text())
old='/opt/enclave-site/'+j['baseCid']+'/site';new='/opt/enclave-site/'+j['cid']+'/site'
assert b['activeRoot']==old and b['caddyfile'].count(old)==2
changes=[]
def rewrite(v,at=''):
 if isinstance(v,dict):return {k:rewrite(x,at+'/'+k) for k,x in v.items()}
 if isinstance(v,list):return [rewrite(x,at+'/'+str(i)) for i,x in enumerate(v)]
 if v==old:changes.append(at.lstrip('/'));return new
 return v
after=rewrite(b['config']);assert len(changes)==2
add={}
for n,pin in j['delta'].items():
 content=(p/'composite/site'/n).read_bytes();assert hashlib.sha256(content).hexdigest()==pin
 add[n]=base64.b64encode(content).decode()
assert [n for n in add if n in b['files']]==['js/boot.js']
v={'activeCid':j['baseCid'],'cid':j['cid'],'before':b['config'],'candidate':after,'beforeText':b['caddyfile'],'candidateText':b['caddyfile'].replace(old,new),'changedPaths':changes,'files':j['files'],'baseFiles':b['files'],'additions':add,'provenance':(p/'release.json').read_text()}
code=(p/'edge-apply.py').read_text()
intent={'host':h,'cid':j['cid'],'state':'REQUESTED_NO_AUTOMATIC_RETRY','scriptSha256':hashlib.sha256(code.encode()).hexdigest(),'semanticChanges':changes}
with (p/(h+'.intent.json')).open('x') as f:json.dump(intent,f,indent=2)
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',h,'python3 -c '+shlex.quote(code)],input=json.dumps(v),capture_output=True,text=True,timeout=180)
(p/(h+'.result.txt')).write_text(r.stdout+r.stderr)
print(r.stdout);print(r.stderr);raise SystemExit(r.returncode)
