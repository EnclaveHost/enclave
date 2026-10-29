from pathlib import Path
import sys,json,subprocess,hashlib,base64,shlex
p=Path(__file__).resolve().parent;peer=p/'edge-plans'
host=sys.argv[1];assert host in ['us-west','ca-east','ap-southeast','eu-central']
plan=json.loads((peer/'root-switch-plan.json').read_text());e=next(x for x in plan['edges'] if x['host']==host)
prov=(p/'composite/composite-provenance.json').read_text();assert hashlib.sha256(prov.encode()).hexdigest()==plan['artifactProvenanceSha256']
files={str(f.relative_to(p/'composite/site')):hashlib.sha256(f.read_bytes()).hexdigest() for f in (p/'composite/site').rglob('*') if f.is_file()}
add=json.loads((p/'artifact/ADDITIONS.json').read_text());addbytes={x['path']:base64.b64encode((p/'artifact/site-additions'/x['path']).read_bytes()).decode() for x in add}
v={'activeCid':plan['activeCid'],'cid':plan['cid'],'baseCid':json.loads(prov)['base']['cid'],'before':json.loads((peer/(host+'.before.json')).read_text()),'candidate':json.loads((peer/(host+'.candidate.json')).read_text()),'beforeText':(peer/(host+'.before.Caddyfile')).read_text(),'candidateText':(peer/(host+'.candidate.Caddyfile')).read_text(),'changedPaths':e['exactSemanticChanges'],'files':files,'additions':addbytes,'provenance':prov}
for k,pin in [('beforeText','beforeCaddyfileSha256'),('candidateText','afterCaddyfileSha256')]:assert hashlib.sha256(v[k].encode()).hexdigest()==e[pin]
code=(p/'edge-apply.py').read_text()
(p/(host+'.intent.json')).write_text(json.dumps({'host':host,'cid':plan['cid'],'scriptSha256':hashlib.sha256(code.encode()).hexdigest(),'state':'SSH_REQUESTED_NO_RETRY'},indent=2)+'\n')
r=subprocess.run(['ssh','-o','ConnectTimeout=10',host,'python3 -c '+shlex.quote(code)],input=json.dumps(v),capture_output=True,text=True,timeout=180)
(p/(host+'.out')).write_text(r.stdout);(p/(host+'.err')).write_text(r.stderr)
print(r.stdout);print(r.stderr);raise SystemExit(r.returncode)
