import subprocess,pathlib,json,os
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
env=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x)
allowed={'SECRETS_RELEASE_DOMAIN_RELEASES','SECRETS_RELEASE_CERT_RELEASES','SECRETS_RELEASE_SEV_SNP_MEASURE','SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256','APP_CATALOG_ADDRESS','ADDRESS_BOOK_ADDRESS','SECRETS_RELEASE_CATALOG_RPCS'}
selected={k:v for k,v in env.items() if k.startswith('SECRETS_RELEASE_PREDICT_') or k in allowed}
selected.update(SECRETS_RELEASE_PREDICT_GATEWAY='',SECRETS_RELEASE_CONFIG_GATEWAY='',SECRETS_RELEASE_PREDICT_SEED='',SECRETS_RELEASE_PREDICT_WORK='/var/lib/enclave-relay/replica-preflight',SECRETS_RELEASE_PREDICT_GATEWAYS=','.join('https://bootstrap-'+r+'.enclave.host' for r in ['us-west','eu-central','ap-southeast','ca-east']))
p=pathlib.Path('/var/lib/indexd-migration/predictor-replicas-preflight.env');p.write_text(''.join(k+'='+json.dumps(v)+'\n' for k,v in selected.items()));p.chmod(0o600)
print(json.dumps({'selectedKeys':sorted(selected),'freshWork':not pathlib.Path(selected['SECRETS_RELEASE_PREDICT_WORK']).exists()}))
