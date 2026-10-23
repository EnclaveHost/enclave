#!/usr/bin/env python3
"""Read only. Emit only explicitly public admission settings, never general env/argv."""
import concurrent.futures, datetime, json, pathlib, subprocess
REMOTE = r'''
import hashlib, json, pathlib, re
keys = ['TRUSTED_OPERATORS','TUNNEL_OPERATOR_ATTACH','ADDRESS_BOOK_ADDRESS','REGISTRY_ADDRESS',
        'METAL_REQUIRE_VCEK','METAL_MIN_TCB','RELAY_HVNODE_ATTACH','RELAY_HVNODE_OPERATORS','HOST_POLICY_RECHECK_SEC']
rows=[]
for proc in pathlib.Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try:
  if proc.joinpath('comm').read_text().strip() not in ('node','nodejs'): continue
  args=proc.joinpath('cmdline').read_bytes().decode().strip('\0').split('\0')
  entry=next((a for a in args if a.endswith('/api-relay.js') or a=='api-relay.js'),None)
  if not entry: continue
  env=dict(x.split('=',1) for x in proc.joinpath('environ').read_bytes().decode().split('\0') if '=' in x)
  source=pathlib.Path(entry)
  if not source.is_absolute(): source=proc.joinpath('cwd').resolve()/source
  raw=source.read_bytes(); text=raw.decode()
  public={}
  for key in keys:
   v=env.get(key)
   # Expected public vocabulary only. Report malformed/unexpected as a hash, not raw data.
   public[key]=v if v is None or re.fullmatch(r'[A-Za-z0-9x*, ._\-]*',v) and len(v)<2048 else {'unexpectedValueSha256':hashlib.sha256(v.encode()).hexdigest()}
  pv=env.get('ENCLAVE_PLATFORM_HOST_POLICY')
  public['ENCLAVE_PLATFORM_HOST_POLICY']=pv if pv in (None,'','off','production') else {'configured':True,'sha256':hashlib.sha256(pv.encode()).hexdigest()}
  default=re.search(r'const DEFAULT_TRUSTED_OPERATORS\s*=\s*(\[[^;]*?\])',text)
  defaultops=re.findall(r'0x[0-9a-fA-F]{40}',default.group(1)) if default else None
  measure=env.get('METAL_ALLOWED_MEASUREMENTS','')
  rows.append({'pid':int(proc.name),'sourcePath':str(source),'sourceSha256':hashlib.sha256(raw).hexdigest(),
               'sourceMtime':source.stat().st_mtime,'processStartTicks':proc.joinpath('stat').read_text().rsplit(')',1)[1].split()[19],
               'publicEnvironment':public,'sourceDefaultTrustedOperators':defaultops,
               'measurementOverridePresent':bool(measure),'measurementOverrideSha256':hashlib.sha256(measure.encode()).hexdigest() if measure else None,
               'staticTunnelTokenOverrideConfigured':bool(env.get('METAL_TUNNEL_TOKENS')),
               'sourceHasHostPolicyRuntime':'createHostPolicyRuntime' in text})
 except (OSError,ValueError,UnicodeError): continue
print(json.dumps({'relays':rows}))
'''
def read(alias):
 try:
  cmd = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',alias,'python3 -'] if alias != 'minipc-control-vm' else ['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo -n python3 -']
  r=subprocess.run(cmd,input=REMOTE,text=True,capture_output=True,timeout=35)
  if r.returncode:return {'alias':alias,'status':'ssh-failed','exitCode':r.returncode}
  return {'alias':alias,'status':'observed',**json.loads(r.stdout)}
 except Exception as e:return {'alias':alias,'status':'unavailable','errorType':type(e).__name__}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 rows=list(pool.map(read,['minipc-control-vm']))
report={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'hosts':rows,
 'limitations':['Environment values are from the live process; source defaults/hash are from its current entry file, not proof of loaded in-memory bytes.','No keys, generic environment, command line, customer state, or token values are exported.','This is an inventory, not a policy-change authorization or proof of admission behavior.']}
p=pathlib.Path('outputs/decentralization-audit/production-control-admission-inventory-20261023.json');p.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
