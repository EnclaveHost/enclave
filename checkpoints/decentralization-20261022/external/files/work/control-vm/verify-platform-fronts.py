from pathlib import Path
import json,subprocess,hashlib,datetime
p=Path('work/control-vm');dirs=json.loads((p/'missing-pin-package/directories.json').read_text());sample=next(x for x in dirs if x['files']>0 and x['carBytes']<500000);m=json.loads((p/'missing-pin-package/sites'/sample['cid']/'manifest.json').read_text());f=m['fileManifest'][0];files=json.loads((p/'missing-pin-package/objects/manifest-additions.json').read_text());small=next(x for x in files if x['bytes']<100000)
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'normalTLSVerification':True,'regions':[]}
for host,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 checks=[]
 for name,path,expected in [('enclave.host','/index.html','fe4bcf82935494e7a0e04a7387369a55e3baf13375073a6a24ac7d2e016cf62d'),('ipfs.enclave.host','/ipfs/'+sample['cid']+'/'+f['path'],f['sha256']),('ipfs.enclave.host','/ipfs/'+sample['cid']+'?format=car',sample['carSHA256']),('ipfs.enclave.host','/ipfs/'+small['cid'],small['sha256']),('get.enclave.host','/install.sh',hashlib.sha256((p/'get-test-install.sh').read_bytes()).hexdigest()),('api.enclave.host','/health',None)]:
  r=subprocess.run(['curl','-fsS','--max-time','25','--resolve',name+':443:'+ip,'https://'+name+path],capture_output=True);assert r.returncode==0,(host,name,path,r.stderr.decode()[-300:])
  if expected:assert hashlib.sha256(r.stdout).hexdigest()==expected,(host,name,path)
  else:assert json.loads(r.stdout)['ok']
  checks.append({'host':name,'path':path,'bytes':len(r.stdout),'verified':True})
 report['regions'].append({'region':host,'checks':checks});print(host+': all six front tests passed',flush=True)
Path('outputs/platform-fronts-verification.json').write_text(json.dumps(report,indent=2)+'\n')
