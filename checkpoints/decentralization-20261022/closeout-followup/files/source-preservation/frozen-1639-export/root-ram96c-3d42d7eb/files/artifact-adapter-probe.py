import concurrent.futures,subprocess,json,datetime,pathlib
cid='bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau'
def check(ip):
 r=subprocess.run(['curl','-sS','--max-time','8','--max-filesize','5000000','-w','\n%{http_code}','--resolve','7ae476a3.app.enclave.host:443:'+ip,'https://7ae476a3.app.enclave.host/ipfs/'+cid+'?format=car&dag-scope=all'],capture_output=True,timeout=10)
 body,_,status=r.stdout.rpartition(b'\n');return {'ip':ip,'exit':r.returncode,'http':status.decode(),'bytes':len(body),'bodyIfError':body[:500].decode(errors='replace') if status!=b'200' else '', 'error':r.stderr.decode()[:150]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4)as ex:rows=list(ex.map(check,['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39']))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':rows};pathlib.Path('work/nucbox-ram96-20261023/artifact-adapter-probe.json').write_text(json.dumps(o,indent=2));print(json.dumps(o))
