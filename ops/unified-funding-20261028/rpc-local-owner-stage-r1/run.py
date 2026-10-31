from pathlib import Path
import os,json,hashlib,stat,importlib.util,shlex,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';u=p.parent
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
spec=importlib.util.spec_from_file_location('delivery',s/'rpc/deliver_guest_workflow.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g);c=g.c
import subprocess
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
c.write_new(p/'ADMISSION.json',c.encode(a));cfg=json.loads((p/'INPUT.json').read_text())
c.write_new(p/'INTENT.json',c.encode({'stage':cfg['stage'],'sourceOnly':True,'oneAttempt':True,'noProductionClock':True}))
root=p/'private'/cfg['stage'];root.mkdir(mode=0o700);c.sync_directory(root.parent)
for name in ('source','source/guest','recipient','journal','inputs'): (root/name).mkdir(mode=0o700)
pins={}
for name in g.SOURCE_NAMES:
 raw=(s/'rpc'/name).read_bytes();pins[name]=c.write_new(root/'source'/name,raw)['sha256']
assert set(x.name for x in (root/'source').iterdir())=={n for n in pins if '/'not in n}|{'guest'}
assert set(x.name for x in (root/'source/guest').iterdir())=={n.split('/')[1]for n in pins if '/'in n}
identity=Path('/home/steven/.ssh/minipc');g.d.endpoint({'host':'192.168.8.238','port':22,'user':'claude','identityFile':str(identity)})
public=' '.join(Path(str(identity)+'.pub').read_text().split()[:2])
original=json.loads((u/'rpc-runtime-guest-seed-r1/CONFIG.json').read_text())['config']['publicKey']
assert public==' '.join(original.split()[:2])
seed=cfg['seedReceipt'];image=cfg['imageReceipt'];credentials=cfg['credentialReceipt']
assert seed['sha256']=='e586a1524df52435a2678f4a2587d2d445071cfcf784e139297b7eed42ba4c2a' and seed['bytes']==13236224
assert image['schema']=='rpc-offline-image/1' and image['sha256']=='a76940c926985b91590ab5916c7996c23d7812ccc2277fe8188bb21f11a0ae2c'
assert credentials['attempt']=='8ee4452b174746c2b606b9b68f0fa623' and seed['instance']==credentials['instance']
g.d.seed_host_key(seed,credentials['instance'],credentials['attempt'])
profile={}
for key in ('seedReceipt','imageReceipt','credentialReceipt'):profile[key]=c.write_new(root/'inputs'/(key+'.json'),c.encode(cfg[key]))
known=c.write_new(root/'inputs/windows-known-hosts',(u/'rpc-files-collect-copy-target-r2/KNOWN-HOST.txt').read_bytes())
profile.update(guestIdentityFile=str(identity),jump={'endpoint':{'host':'192.168.8.238','port':22,'user':'claude','identityFile':str(identity)},'alias':'192.168.8.148','knownHosts':known},sshSha256=hashlib.file_digest(open('/usr/bin/ssh','rb'),'sha256').hexdigest(),journalRoot=str(root/'journal'),ownerBootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),vmAttempt=cfg['vmAttempt'])
binding=c.write_new(root/'inputs/profile.json',c.encode(profile))
# No workflow is called and no new production clock is assigned by staging.
local={'recipientRoot':str(root/'recipient'),'sourceRoot':str(root/'source'),'sourcePins':pins,'profile':binding}
c.write_new(root/'LOCAL-OWNER.json',c.encode(local))
for name,sha in pins.items():assert c.read_pinned({'path':str(root/'source'/name),'sha256':sha})==(s/'rpc'/name).read_bytes()
for v in profile.values():
 if isinstance(v,dict) and set(v)=={'path','sha256'}:c.read_pinned(v)
c.write_new(p/'RESULT.json',c.encode({'stage':cfg['stage'],'sourcePins':pins,'profileSha256':binding['sha256'],'sourceCount':len(pins),'publicSeedSha256':profile['seedReceipt']['sha256'],'publicImageSha256':profile['imageReceipt']['sha256'],'credentialPublicSha256':profile['credentialReceipt']['sha256'],'ownerBootId':profile['ownerBootId'],'uid':os.geteuid(),'publicLoginKeyMatchesSeed':True,'privateIdentityRead':False,'profileStaged':True,'productionClockAssigned':False,'guestSubmitted':False,'rpcReady':False}))
