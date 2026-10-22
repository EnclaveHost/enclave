import pathlib,subprocess,json
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
e=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x)
keys=['SECRETS_RELEASE_PREDICT_PATH','SECRETS_RELEASE_PREDICT_SEED','SECRETS_RELEASE_SEV_SNP_MEASURE']
print(json.dumps({k:e.get(k) for k in keys},indent=2))
