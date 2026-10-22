from pathlib import Path
import subprocess,json
pid=subprocess.check_output(['systemctl','show','enclave-dns','-p','MainPID','--value'],text=True).strip();env=dict(x.split('=',1) for x in Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x)
print(json.dumps({k:env.get(k,'') for k in ['APP_STATIC','IP_ZONE','APP_ZONE','TCP_ZONE','BOX_ZONE','NS_NAME','BOX_A','BOX_AAAA']},indent=2))
