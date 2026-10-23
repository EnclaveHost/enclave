import json,pathlib,datetime,socket,ssl,concurrent.futures
ids=['c13d4b6a','ef514ed3','e64f7cba','59f1273d','a69dcbba','d9798e4c','a77d0c57','38f368d6','7ae476a3']
def check(i):
 host=i+'.app.enclave.host'
 try:
  with socket.create_connection((host,443),timeout=8)as s:
   with ssl.create_default_context().wrap_socket(s,server_hostname=host)as t:
    c=t.getpeercert();return {'id':i,'verified':True,'issuer':dict(x[0]for x in c['issuer']).get('organizationName'),'notAfter':c['notAfter']}
 except Exception as e:return {'id':i,'verified':False,'error':str(e)[:160]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as ex:rows=list(ex.map(check,ids))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tls':rows};p=pathlib.Path('outputs/decentralization-audit')/('nucbox-tls-verification-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json');p.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o));print('Saved',p)
