import ast,pathlib,subprocess,json,concurrent.futures
p=pathlib.Path(__file__).parent
mod=ast.parse((p/'dns-policy-inventory.py').read_text());src=next(ast.literal_eval(x.value) for x in mod.body if isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='src' for t in x.targets))
def check(host):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'python3 -'],input=src,capture_output=True,text=True,timeout=45)
 if r.returncode:return {'host':host,'error':r.stderr[-300:]}
 o=json.loads(r.stdout);o['host']=host;return o
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:out=list(ex.map(check,['us-west','eu-central','ap-southeast','ca-east']))
(p.parent/'evidence/provider-policy-inventory.json').write_text(json.dumps(out,indent=2)+'\n')
for r in out:print(json.dumps({'host':r['host'],'error':r.get('error'),'services':[{'unit':x['unit'],'policyPaths':x['policyPaths'],'policyCount':len(x['policies'])} for x in r.get('services',[])]}))
