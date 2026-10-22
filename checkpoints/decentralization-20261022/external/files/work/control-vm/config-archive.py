from pathlib import Path
import subprocess,json,sys
units=['enclave-api-relay.service','enclave-dns.service','enclave-native-discovery.service','nan-wasm-gateway.service','enclave-policy-migration-bridge.service','enclave-provider-migration-mirror.service','enclave-native-certs.service','enclave-native-certs.timer']
files={'etc/nan-relay','etc/enclave-dns','etc/caddy/Caddyfile'}
for unit in units:
 for key in ['FragmentPath','DropInPaths']:
  raw=subprocess.check_output(['systemctl','show',unit,'-p',key,'--value'],text=True).strip()
  for p in raw.split():
   if p and Path(p).exists():files.add(p.lstrip('/'))
subprocess.run(['tar','-C','/','-czf','-',*sorted(files)],stdout=sys.stdout.buffer,check=True)
