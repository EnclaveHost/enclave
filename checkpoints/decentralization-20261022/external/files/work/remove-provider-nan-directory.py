import json,pathlib,shutil,os,subprocess,time,urllib.request
p=pathlib.Path('/etc/enclave-network/provider.json');c=json.loads(p.read_text());old=c.get('directories')
expected=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188']
if old!=expected+['https://api.enclave.host']:raise RuntimeError('unexpected directory configuration; not changing it')
backup=p.with_name('provider.before-removing-nan-directory.json')
if backup.exists():raise RuntimeError('migration backup already exists')
shutil.copy2(p,backup);st=p.stat();c['directories']=expected;temp=p.with_suffix('.migration-tmp');temp.write_text(json.dumps(c,indent=2)+'\n');os.chmod(temp,st.st_mode);os.chown(temp,st.st_uid,st.st_gid);temp.replace(p)
subprocess.run(['systemctl','restart','enclave-network-provider'],check=True)
deadline=time.monotonic()+60
while True:
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(c.get('ports',{}).get('control',51822))+'/v1/info',timeout=3) as r:info=json.load(r)
  if not info['status']['accepting']:raise RuntimeError('provider not accepting')
  print(json.dumps({'address':c['publicAddress'],'directories':expected,'status':info['status']}),flush=True);break
 except Exception:
  if time.monotonic()>deadline:raise
  time.sleep(2)
