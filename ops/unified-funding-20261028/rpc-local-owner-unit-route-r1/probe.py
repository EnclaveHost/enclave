from pathlib import Path
import os,json,hashlib,importlib.util,shlex,time,stat,sys
p=Path(__file__).resolve().parent;cfg=json.loads((p/'private/CONFIG.json').read_text());owner=cfg['owner'];source=Path(owner['sourceRoot'])
for name,sha in owner['sourcePins'].items():
 file=source/name;st=file.lstat();assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600
 assert hashlib.sha256(file.read_bytes()).hexdigest()==sha
assert set(x.name for x in source.iterdir())=={n for n in owner['sourcePins']if '/'not in n}|{'guest'}
assert set(x.name for x in (source/'guest').iterdir())=={n.split('/')[1]for n in owner['sourcePins']if '/'in n}
spec=importlib.util.spec_from_file_location('qualified_owner',source/'run_guest_workflow.py');entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
env=entry.envelope(cfg['qualificationAttempt'],int(sys.argv[1]))
c=entry.c;profile=entry.p.decode(c.read_pinned(owner['profile']));assert profile['ownerBootId']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()
for key in ('seedReceipt','imageReceipt','credentialReceipt'):c.read_pinned(profile[key])
seed=entry.p.decode(c.read_pinned(profile['seedReceipt']));image=entry.p.decode(c.read_pinned(profile['imageReceipt']))
required=dict(entry.prepare_runtime.runtime.required_pins());required.update(entry.guest.FILES);required.update(entry.delivery.FILES)
for name,mode in required.items():
 seeded=name in seed['records'];row=seed['records'].get(name) if seeded else image['installedFiles'].get(name.lstrip('/'),{})
 assert row.get('mode')==(format(mode,'04o')if seeded else mode) and row.get('private')is not True;entry.p.digest(row['sha256'])
jump=profile['jump'];proxy=entry.delivery.ssh_options(Path(jump['knownHosts']['path']),jump['alias'])+['-W',cfg['controlHost']+':22']+entry.delivery.endpoint(jump['endpoint'])
c.read_pinned(jump['knownHosts']);c.read_pinned(cfg['controlKnownHosts'])
remote_code="""from pathlib import Path
import os,json,time,subprocess
p=Path('/proc/330763/stat');exactPresent=False
if p.exists():
 try:exactPresent=p.read_text().rsplit(')',1)[1].split()[19]=='74182370'
 except FileNotFoundError:pass
r=subprocess.run(['/usr/bin/systemctl','show','enclave-rpc-control-workflow-read-r1-20261031.service','-p','MainPID','-p','ExecMainStatus','-p','ActiveState'],capture_output=True,text=True,timeout=2,check=True)
assert len(r.stdout)<8192
print(json.dumps({'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'uid':os.geteuid(),'atUtcNs':time.time_ns(),'priorExactProcessPresent':exactPresent,'priorUnit':dict(line.split('=',1)for line in r.stdout.splitlines()),'memoryAvailableBytes':next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines()if x.startswith('MemAvailable:')),'rpcWorkSubmitted':False,'readOnly':True}))
"""
remote=['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-local-route-read-'+cfg['qualificationAttempt'],*['--property='+v for v in ('User=controladmin','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','RuntimeMaxSec=10','TimeoutStopSec=1','KillMode=control-group','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=read-only')],'/usr/bin/python3','-I','-B','-c',remote_code]
argv=entry.delivery.ssh_options(Path(cfg['controlKnownHosts']['path']),'rpc-control-route')+['-oProxyCommand='+shlex.join(proxy)]+entry.delivery.endpoint({'host':cfg['controlHost'],'port':22,'user':'controladmin','identityFile':profile['guestIdentityFile']})+[shlex.join(remote)]
before=time.time_ns();mono=time.monotonic_ns();reply=entry.delivery.exchange(argv,b'',15);after=time.time_ns();elapsed=time.monotonic_ns()-mono
row=entry.p.decode(reply);assert row['boot']==cfg['controlBoot'] and row['uid']==1000 and row['priorExactProcessPresent']is False
assert row['priorUnit']['MainPID']=='0' and row['priorUnit']['ExecMainStatus']=='0' and row['priorUnit']['ActiveState']=='inactive'
assert abs((after-before)-elapsed)<2_000_000_000
clockBound=max(abs(row['atUtcNs']-before),abs(after-row['atUtcNs']));assert clockBound<=2_000_000_000
for name,sha in owner['sourcePins'].items():assert hashlib.sha256((source/name).read_bytes()).hexdigest()==sha
c.write_new(p/'RESULT.json',c.encode({'qualificationAttempt':cfg['qualificationAttempt'],'envelope':env,'sourceCount':len(owner['sourcePins']),'profileSha256':owner['profile']['sha256'],'runtimePinsCovered':len(required),'clockOffsetUpperBoundNs':clockBound,'roundTripNs':elapsed,'controlRead':row,'actualPinnedJumpToExistingControl':True,'ownedRpcGuestRouteProven':False,'privateIdentityExported':False,'productionClockAssigned':False,'guestWorkflowCalled':False,'rpcReady':False}))
