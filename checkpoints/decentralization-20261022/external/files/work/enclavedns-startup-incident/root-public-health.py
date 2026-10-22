import subprocess,json,pathlib,datetime,concurrent.futures
host='59f1273d.app.enclave.host';ip='134.199.235.187'
paths=['/healthz','/resolve?name=example.com&type=A','/dns-query?name=example.com&type=A']
def check(p):
 r=subprocess.run(['curl','--silent','--show-error','--max-time','35','--resolve',host+':443:'+ip,'--header','Accept: application/dns-json','--write-out','\nHTTP_STATUS:%{http_code}\n','https://'+host+p],capture_output=True,timeout=40)
 return {'path':p,'exit':r.returncode,'output':r.stdout.decode(errors='replace')[:14000],'error':r.stderr.decode(errors='replace')[:1000]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as ex:results=list(ex.map(check,paths))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':host,'publicIngressIp':ip,'tlsVerification':True,'dnsOverride':'Known existing public ingress used because local name resolution failed; hostname/certificate validation retained.','results':results};pathlib.Path(__file__).with_name('root-public-health.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
