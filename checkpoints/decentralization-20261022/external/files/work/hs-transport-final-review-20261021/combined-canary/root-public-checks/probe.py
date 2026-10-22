import json,subprocess,pathlib,hashlib,datetime,sys
here=pathlib.Path(__file__).resolve().parent
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
provider='c4c7888e4741dcbe2c092dd81e888bf7'; ip='146.190.246.39'
cid='bafkreiaaz5z2sqhidxdb2w3dhh4syl4lgv5wfn2hlpkldknbglucwakahe'
checks=[('routes','http://'+ip+':8188/v1/network/routes',None),('providers','http://'+ip+':8188/v1/network/providers',None),('custody','https://custody-ca-east.app.enclave.host/health','custody-ca-east.app.enclave.host'),('bootstrap','https://bootstrap-ca-east.enclave.host/ipfs/'+cid,'bootstrap-ca-east.enclave.host')]
r={'at':stamp,'phase':sys.argv[1] if len(sys.argv)>1 else 'observe','providerId':provider,'checks':{}}
for name,url,host in checks:
 cmd=['curl','--silent','--show-error','--connect-timeout','10','--max-time','35','--max-filesize','3000000','--write-out','\n%{http_code}',url]
 if host: cmd[1:1]=['--resolve',host+':443:'+ip]
 p=subprocess.run(cmd,capture_output=True)
 body,_,status=p.stdout.rpartition(b'\n')
 x={'rc':p.returncode,'status':status.decode(errors='replace'),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'error':p.stderr.decode(errors='replace')[:350]}
 try:
  d=json.loads(body)
  if name=='providers':
   entries=[v for v in d.get('providers',[]) if v.get('record',{}).get('record',{}).get('providerId')==provider]
   x['matching']=len(entries);x['qualifications']=[v['qualification'] for e in entries for v in e.get('qualifications',[])]
   (here/(stamp+'-providers.json')).write_bytes(body)
  elif name=='routes':x['shape']={k:len(v) if isinstance(v,(list,dict)) else str(v)[:60] for k,v in d.items()}
  elif name=='custody':x['health']=d
 except (ValueError,AttributeError):pass
 if name=='bootstrap':x['expectedHashMatch']=x['sha256']=='00cf73a940e81dc61d5b6339f92c2f8b357b62b7475bd4b1a9a132e82b014039'
 r['checks'][name]=x
f=here/(stamp+'-'+r['phase']+'.json');f.write_text(json.dumps(r,indent=2));print(str(f));print(json.dumps(r,indent=2))
