"""Root prepares immutable params only; this makes no remote calls."""
import datetime,hashlib,json,pathlib,sys
b=pathlib.Path(__file__).resolve().parent/'runs'
mode=sys.argv[1];stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dt%H%M%Sz')
if mode=='identify':
 p=json.loads((b/'params-identify-20261023t0048z.json').read_text())
elif mode=='apply':
 x=json.loads(pathlib.Path(sys.argv[2]).read_text());assert x['final']=='IDENTIFIED'
 row=next(json.loads(s) for s in x['journal']['lines'] if json.loads(s).get('final')=='IDENTIFIED')
 p=json.loads((b/'params-apply-20261023t0052z.json').read_text())
 # Do not silently approve source/config drift from the already reviewed runtime.
 assert {f['file']:f['sha'] for f in row['files']}=={f['name']:f['oldSha'] for f in p['files']}
 assert row['unchanged']==p['unchangedFiles']
 assert len(row['node']['cmd'])==len(row['node']['agent'])==len(row['privacy'])==1
 cmd=row['node']['cmd'][0];ag=row['node']['agent'][0];assert ag['parent']==cmd['pid']
 p['node']={'cmdPid':cmd['pid'],'cmdStart':cmd['start'],'agentPid':ag['pid'],'agentStart':ag['start']}
 p['task']={k:row['task'][k] for k in ('execute','arguments')}
 assert row['task']['count']==1
 p['scheduler']={k:row['scheduler'][k] for k in ('pid','start','name')};p['scheduler']['commandLike']=row['scheduler']['commandLine']
 p['privacy']=row['privacy'][0]
 for k in ('manager','vms','hyperv'):p[k]=row[k]
 ids=sorted(r['id'] for r in row['deployments'] if r['status']=='running');assert ids==sorted(p['expectedIds'])
 assert p['boundSec']==700 and p['lease']['revertSec']==355
else:raise SystemExit('identify or apply RECEIPT')
p['runId']=mode+'-'+stamp
out=b/('params-'+p['runId']+'.json')
with out.open('x') as f:json.dump(p,f,indent=2);f.write('\n')
print(json.dumps({'path':str(out),'sha':hashlib.sha256(out.read_bytes()).hexdigest(),'runId':p['runId']}))
