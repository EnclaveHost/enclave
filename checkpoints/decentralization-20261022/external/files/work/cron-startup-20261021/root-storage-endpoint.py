import urllib.request,urllib.parse,hashlib,json,subprocess,datetime,pathlib
p=pathlib.Path(__file__).parent
u='https://ipfs.enclave.host/ipfs/bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey?format=raw'
with urllib.request.urlopen(u,timeout=25) as r: b=r.read(8192)
assert hashlib.sha256(b).hexdigest()=='c5f92c7eb329afb2c36707cfd551456e6d4e76132f8a581da3b71eaa1e489826'
v=urllib.parse.urlsplit(json.loads(b)['storage']['endpoint'])
assert v.scheme=='https' and not v.username and not v.password and not v.query and not v.fragment
origin=urllib.parse.urlunsplit((v.scheme,v.netloc,'','',''))
d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'storageOrigin':origin,'checks':{}}
for path in ['/healthz','/']:
 r=subprocess.run(['curl','-sS','--max-time','20','--output','/dev/null','--write-out','%{http_code} %{ssl_verify_result} %{remote_ip}',origin+path],capture_output=True,text=True,timeout=25)
 d['checks'][path]={'exit':r.returncode,'result':r.stdout,'error':r.stderr[:400]}
(p/'root-storage-endpoint.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2))
