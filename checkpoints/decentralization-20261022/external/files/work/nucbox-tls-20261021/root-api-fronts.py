import concurrent.futures,json,subprocess,pathlib,datetime
ips=['134.199.235.187','134.209.248.172','146.190.246.39','165.245.191.129']
def check(pair):
 ip,path=pair;cmd=['curl','-sS','--max-time','15','--resolve','api.enclave.host:443:'+ip,'-w','\n%{http_code} %{time_total}','https://api.enclave.host'+path]
 if path.endswith('/exists'):cmd+=['-H','content-type: application/json','--data','{"id":"0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c"}']
 p=subprocess.run(cmd,capture_output=True,text=True,timeout=20);body,_,meta=p.stdout.rpartition('\n')
 try:b=json.loads(body);body={k:b[k] for k in ['ok','exists','error','enclaves','of'] if k in b}
 except:body=body[:150]
 return {'ip':ip,'path':path,'rc':p.returncode,'meta':meta,'body':body,'error':p.stderr[:200]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4)as ex:r=list(ex.map(check,[(ip,p)for ip in ips for p in ['/health','/v1/secrets/exists']]))
x={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':r};pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x,indent=2))
