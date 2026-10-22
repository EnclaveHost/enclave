import pathlib,subprocess,json,os
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
env=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x)
paths={}
for k,v in env.items():
 if k.endswith(('_FILE','_DIR','_REPO','_WORK')) and v.startswith('/') and '\n' not in v:
  p=pathlib.Path(v);paths[k]={'path':v,'exists':p.exists(),'kind':'directory' if p.is_dir() else 'file'}
releases=[x.split('=',1)[1] for x in env.get('SECRETS_RELEASE_PREDICT_RELEASES','').split(',') if '=' in x]
print(json.dumps({'paths':paths,'releaseDirectories':releases,'environmentKeys':sorted(k for k in env if k not in ['CREDENTIALS_DIRECTORY','INVOCATION_ID'])},indent=2))
