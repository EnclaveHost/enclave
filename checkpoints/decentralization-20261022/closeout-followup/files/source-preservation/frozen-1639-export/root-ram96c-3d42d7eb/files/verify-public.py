import concurrent.futures,datetime,json,pathlib,subprocess
ids=['c13d4b6a','ef514ed3','e64f7cba','59f1273d','a69dcbba','d9798e4c','a77d0c57','38f368d6','7ae476a3']
ips=['146.190.246.39','165.245.191.129']
def check(pair):
 i,ip=pair;host=i+'.app.enclave.host'
 r=subprocess.run(['curl','-sS','--max-time','10','--resolve',host+':443:'+ip,'-o','/dev/null','-w','%{http_code}','https://'+host+'/ping'],capture_output=True,text=True,timeout=12)
 return {'app':i,'ip':ip,'curlExit':r.returncode,'http':r.stdout,'error':r.stderr[:200]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex: rows=list(ex.map(check,[(i,ip)for i in ids for ip in ips]))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'note':'Existing ingress addresses explicitly selected; hostname/CA verification enabled. Does not test DNS resolution. /ping status may vary by app.','results':rows}
p=pathlib.Path('work/nucbox-ram96-20261023')/('public-'+datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S')+'.json');p.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
