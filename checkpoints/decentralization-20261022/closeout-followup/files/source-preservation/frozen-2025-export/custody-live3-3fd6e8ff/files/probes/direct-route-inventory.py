import pathlib,json,datetime,subprocess
paths=['/home/steven/enclave-prod/enclave-network/metal0/config.json','/home/steven/Projects/enclave/metal/config.json']
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'files':[]}
for raw in paths:
 p=pathlib.Path(raw);d=json.loads(p.read_text());n=d.get('enclaveNetwork',{})
 selected={'path':raw,'topLevelKeys':sorted(d),'enclaveNetworkKeys':sorted(n) if isinstance(n,dict) else [],'hostServicesPresent':bool(d.get('hostServices') or n.get('hostServices'))}
 for k in ['runner','endpoint','zone','registryEndpoint']:
  if isinstance(d.get(k),str):selected[k]=d[k]
 for label,obj in [('topHostServices',d.get('hostServices')),('networkHostServices',n.get('hostServices'))]:
  if isinstance(obj,dict):selected[label]={'keys':sorted(obj),'zone':obj.get('zone'),'ports':obj.get('ports'),'tls':obj.get('tls')}
 out['files'].append(selected)
out['limits']=['Selected public metadata only; no private keys, token, environments or complete configuration emitted. No configuration changed.']
pathlib.Path('work/custody-v2-live-20261023/evidence/direct-route-inventory.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
