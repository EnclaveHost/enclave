import sys,pathlib,urllib.request,hashlib,subprocess,os,time,threading
ORIGIN='https://7ae476a3.app.enclave.host'
IPFS_ENV={**os.environ,'IPFS_PATH':str(pathlib.Path('work/retained-kubo',str(os.getpid())).resolve())};IPFS_LOCK=threading.Lock()
def ranged(cid,size,target):
 target=pathlib.Path(target);tmp=target.with_suffix('.download')
 with open(tmp,'wb') as f:
  for start in range(0,max(size,1),1<<20):
   length=min(1<<20,size-start);end=start+length-1
   for attempt in range(3):
    try:
     headers={'Range':f'bytes={start}-{end}'} if size else {}
     req=urllib.request.Request(ORIGIN+'/ipfs/'+cid,headers=headers)
     with urllib.request.urlopen(req,timeout=40) as r:
      if size and (r.status!=206 or r.headers.get('Content-Range')!=f'bytes {start}-{end}/{size}'):raise ValueError('range mismatch')
      b=r.read(length+1)
     if len(b)!=length:raise ValueError('short range')
     f.write(b);break
    except Exception:
     if attempt==2:raise
     time.sleep(attempt+1)
 with IPFS_LOCK:
  if not pathlib.Path(IPFS_ENV['IPFS_PATH'],'config').exists():subprocess.run(['ipfs','init','--profile=test'],env=IPFS_ENV,check=True,stdout=subprocess.DEVNULL)
  root=subprocess.check_output(['ipfs','--offline','add','--cid-version=1','--raw-leaves=true','--pin=false','-Q',str(tmp)],env=IPFS_ENV,text=True).strip()
  if root!=cid:raise ValueError('ranged bytes do not match requested CID')
  with open(target.with_suffix('.car'),'wb') as car:subprocess.run(['ipfs','--offline','dag','export',cid],env=IPFS_ENV,stdout=car,check=True)
 tmp.replace(target)
 return target.with_suffix('.car').read_bytes()
if __name__=='__main__':
 cid,size,out=sys.argv[1:];ranged(cid,int(size),out);print('CID-verified ranged retrieval',cid,pathlib.Path(out).stat().st_size,flush=True)
