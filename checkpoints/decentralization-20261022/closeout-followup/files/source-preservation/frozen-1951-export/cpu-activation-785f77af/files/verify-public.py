"""Verify CA/hostname TLS and an HTTP response for all DNS-advertised app ingress addresses."""
import concurrent.futures,datetime,json,pathlib,socket,ssl,sys
HERE=pathlib.Path(__file__).resolve().parent
prior=json.loads((HERE/'preflight-191716.json').read_text())['result']['deployments']
hosts=[v['id'][2:10]+'.app.enclave.host' for v in prior if v['status']=='running']
if sys.argv[1:]:
 requested={s+'.app.enclave.host' for s in sys.argv[1:]}
 assert requested.issubset(set(hosts))
 hosts=[s for s in hosts if s in requested]
ctx=ssl.create_default_context()
def check(host):
 results=[]
 try: addresses=sorted({r[4][0] for r in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)})
 except Exception as e:return [{'host':host,'ok':False,'error':str(e)}]
 for addr in addresses:
  try:
   with socket.create_connection((addr,443),timeout=10) as raw:
    with ctx.wrap_socket(raw,server_hostname=host) as s:
     cert=s.getpeercert();s.sendall(('GET / HTTP/1.1\r\nHost: '+host+'\r\nConnection: close\r\n\r\n').encode())
     first=s.recv(1024).split(b'\r\n',1)[0].decode('ascii','replace')
     results.append({'host':host,'address':addr,'tlsVerified':True,'serial':cert.get('serialNumber'),'expires':cert.get('notAfter'),'response':first,'ok':first.startswith('HTTP/') and len(first.split())>1 and first.split()[1]=='200'})
  except Exception as e:results.append({'host':host,'address':addr,'ok':False,'error':str(e)})
 return results
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 rows=[row for group in pool.map(check,hosts) for row in group]
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':rows,'ok':all(r['ok'] for r in rows)}
path=HERE/('tls-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
raise SystemExit(0 if result['ok'] else 1)
