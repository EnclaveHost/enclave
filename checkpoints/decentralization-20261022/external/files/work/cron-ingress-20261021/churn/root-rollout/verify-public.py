#!/usr/bin/env python3
"""One bounded public snapshot after the directory rollout; read-only, no failure injection."""
import concurrent.futures,datetime,json,pathlib,subprocess,urllib.request
F={'us-west':'134.199.235.187','ca-east':'146.190.246.39','ap-southeast':'165.245.191.129','eu-central':'134.209.248.172'}
APP=['38f368d6','7ae476a3','9eb4e600']
def get(ip,path):
 with urllib.request.urlopen('http://'+ip+':8188'+path,timeout=12) as r:
  return json.loads(r.read(4*1024*1024))
def front(pair):
 name,ip=pair; out={'ip':ip,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 try:
  r=get(ip,'/v1/network/routes');out['labels']=len(r.get('labels',{}));out['apps']={a:r.get('labels',{}).get(a) for a in APP}
 except Exception as e:out['routesError']=str(e)
 try:
  ps=get(ip,'/v1/network/providers')['providers'];out['providers']=[]
  for p in ps:
   record=p['record']['record']; qs=[]
   for q in p.get('qualifications',[]):
    v=q.get('qualification',{});qs.append({k:v.get(k) for k in ['checker','issuedAt','expiresAt','checks']})
   out['providers'].append({'address':record.get('address'),'qualifications':qs})
 except Exception as e:out['providersError']=str(e)
 d=subprocess.run(['dig','+short','+norecurse','+time=3','+tries=1','@'+ip,APP[0]+'.app.enclave.host','A'],capture_output=True,text=True,timeout=7)
 out['cronAuthoritativeDns']={'exit':d.returncode,'answer':d.stdout.strip(),'error':d.stderr[:200]}
 return name,out
def http(task):
 a,ip=task;host=a+'.app.enclave.host';cmd=['curl','--silent','--show-error','--max-time','12','--output','/dev/null','--write-out','%{http_code} %{ssl_verify_result} %{remote_ip} %{time_total}']
 if ip:cmd+=['--resolve',host+':443:'+ip]
 r=subprocess.run(cmd+['https://'+host+'/'],capture_output=True,text=True,timeout=15)
 return {'app':a,'forcedAddress':ip,'exit':r.returncode,'result':r.stdout.strip(),'error':r.stderr[:200]}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'public snapshot; qualification objects are observations, not independently verified signatures'}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:out['fronts']=dict(pool.map(front,F.items()))
ips=sorted({ip for row in out['fronts'].values() for ip in ((row.get('apps',{}).get(APP[0]) or {}).get('addresses',[]))})
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:out['https']=list(pool.map(http,[(a,None) for a in APP]+[(APP[0],ip) for ip in ips]))
p=pathlib.Path(__file__).with_name('public-verification.json');p.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'file':str(p),'fronts':{k:{'labels':v.get('labels'),'cron':(v.get('apps',{}).get(APP[0]) or {}).get('addresses'),'dns':v['cronAuthoritativeDns']} for k,v in out['fronts'].items()},'https':out['https']},indent=2))
