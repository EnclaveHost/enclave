import http.client,json,time,pathlib,datetime
out={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'samples':[]};path=pathlib.Path('work/enclavedns-upload-502-20261021/post-relaunch-check.json')
for n in range(30):
 s={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 try:
  c=http.client.HTTPSConnection('ef514ed3.app.enclave.host',443,timeout=12);c.request('GET','/healthz');r=c.getresponse();b=r.read(32769);c.close();s['httpStatus']=r.status
  if r.status==200 and len(b)<=32768:
   j=json.loads(b);s['health']={k:j.get(k) for k in ['app','ready','keys','objects','openUploads','bytes']}
   if j.get('ready') and j.get('app')=='sia-s3/0.1.8':
    s['inventoryMatchesBaseline']=all(j.get(k)==v for k,v in {'keys':1487,'objects':1489,'bytes':21442904907}.items());out['samples'].append(s);out['status']='ready';path.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(s));raise SystemExit(0 if s['inventoryMatchesBaseline'] else 2)
 except SystemExit:raise
 except Exception as e:s['errorType']=type(e).__name__
 out['samples'].append(s);path.write_text(json.dumps(out,indent=2)+'\n');time.sleep(10)
print('Not ready within bounded check; no mutation attempted');raise SystemExit(1)
