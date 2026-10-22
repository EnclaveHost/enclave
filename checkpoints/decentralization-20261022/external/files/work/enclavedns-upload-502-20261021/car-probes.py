from pathlib import Path
import subprocess,json,concurrent.futures
p=Path(__file__).resolve().parent
cid='bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau'
def run(a):
 label,url,resolve=a;cmd=['curl','-sS','--max-time','60','--max-filesize','5000000','-D',str(p/(label+'.headers')),'-o',str(p/(label+'.body')),'-w','%{http_code}',url]
 if resolve:cmd += ['--resolve',resolve]
 r=subprocess.run(cmd,capture_output=True,text=True,timeout=70)
 out={'label':label,'status':r.stdout,'curlExit':r.returncode}
 if r.stdout!='200' and (p/(label+'.body')).exists():
  b=(p/(label+'.body')).read_bytes()
  try:
   v=json.loads(b);out['error']=str(v.get('error',''))[:400]
  except:out['bodyType']='non-JSON';out['bodyBytes']=len(b)
 return out
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as x:
 print(json.dumps(list(x.map(run,[('canonical','https://ipfs.enclave.host/ipfs/'+cid+'?format=car',None),('direct-frankfurt','https://7ae476a3.app.enclave.host/ipfs/'+cid+'?format=car','7ae476a3.app.enclave.host:443:134.209.248.172')])),indent=2))
