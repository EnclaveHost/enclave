import os,json,base64,hashlib,pathlib,subprocess,datetime
import sys
p=json.loads(sys.stdin.read())
for f,want in p['baseline'].items():
 if hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()!=want:raise SystemExit('baseline changed: '+f)
root=pathlib.Path('/opt/enclave-funding-staged')
if root.exists():
 st=root.lstat()
 if root.is_symlink() or st.st_uid!=0 or st.st_mode&0o022:raise SystemExit('unsafe stage parent')
else:root.mkdir(mode=0o755)
d=pathlib.Path(p['path']);d.mkdir(mode=0o755,exist_ok=False)
for name,v in p['files'].items():
 if name not in ['sessions.mjs','funding-route.mjs','funding-abi.mjs','fee-policy.mjs','funding-activation.mjs']:raise SystemExit('unexpected file')
 b=base64.b64decode(v['data']);assert hashlib.sha256(b).hexdigest()==v['sha256']
 fd=os.open(d/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
result={'status':'STAGED_ONLY_NOT_INSTALLED_OR_IMPORTED','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'path':str(d),'files':{n:hashlib.sha256((d/n).read_bytes()).hexdigest()for n in p['files']},'baselineAfter':{f:hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()for f in p['baseline']},'service':subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','ActiveState'],text=True).strip()}
assert result['baselineAfter']==p['baseline']
(d/'STAGED-MANIFEST.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
