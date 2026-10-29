"""One explicit operator-authorized cutover, accepting incomplete pending-payment tracking.
No transaction signing, journal reset, old grant change, or automatic resend. Never rerun this operation.
Pre/post private preservation is retained; no observer-coverage claim is made.
"""
import os,sys,json,time,hashlib,subprocess,pathlib,fcntl,urllib.request,types
OP='funding-gas-envelope-20261029-r1'
ROOT=pathlib.Path('/var/lib/enclave-maintenance')/OP
CORE=ROOT/'quarantine_install_r2.py'
CORE_SHA='0a5d2918da0fa1dbd8f8526981846b4a361638d12be8f000d78cd2b5dd3fc6a4'
sha=lambda b:hashlib.sha256(b).hexdigest()
assert os.geteuid()==0
assert sha(CORE.read_bytes())==CORE_SHA
c=types.ModuleType('reviewed_core');sys.modules[c.__name__]=c
exec(compile(CORE.read_bytes(),str(CORE),'exec'),c.__dict__)
fs=c.FS('/',0);L=c.Layout();host=c.SystemdHost(L,c.PRODUCTION_PINS)
class SnapshotInstaller(c.Installer):
    def _baseline_paths(self):
        names=self.fs.listdir(self.L.dropin_dir)
        for n in names:
            st=self.fs.lstat(self.L.dropin_dir+'/'+n)
            c.need(__import__('stat').S_ISREG(st.st_mode) and (c.CONF_RE.fullmatch(n) or n=='zzzzzzzz-retire-budget-20261028.conf.disabled'),'unexpected-unit-entry')
        return ([self.L.relay_dir+'/'+n for n in sorted(self.pins.candidate)]
                +[self.L.relay_dir+'/'+n for n in sorted(self.pins.protected)]
                +[self.L.unit_file]+[self.L.dropin_dir+'/'+n for n in names]
                +[p for p,_ in self.pins.environment_files]+self._state_files())
inst=SnapshotInstaller(fs,host)
gate=pathlib.Path(L.gate_helper)
assert sha(gate.read_bytes())==c.PRODUCTION_PINS.gate_helper
lock=os.open(ROOT/'operator.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
def save(name,obj):
    p=ROOT/name;t=ROOT/(name+'.tmp')
    with t.open('xb') as f:
        os.chmod(t,0o600);f.write(c.canon(obj));f.flush();os.fsync(f.fileno())
    os.replace(t,p);fs.fsync_path(str(ROOT))
def state(phase,**kw):
    save('state.json',{'op':OP,'phase':phase,'at':int(time.time()),'pendingTrackingRiskAccepted':True,'coverageVerified':False,**kw})
def run(argv,timeout=30):
    return subprocess.check_output(argv,text=True,timeout=timeout)
def gate_action(action):
    info=json.loads(run(['python3',str(gate),'inspect']))
    argv=['python3',str(gate),action,'--op',OP]
    if action in ('gate','restore'):argv+=['--apply','--expected-hash',info['routesSha256'],'--expected-etag',info['etag']]
    return json.loads(run(argv))
assert not (ROOT/'state.json').exists(),'never rerun: inspect prior outcome'
base=pathlib.Path(L.relay_dir);pins=c.PRODUCTION_PINS
for n,h in {**pins.candidate,**pins.protected}.items():assert sha((base/n).read_bytes())==h,n
ident=inst._live_identity(256324,49472391)
assert ident['invocationId']=='049812f4b72645c09e891a09350d97c9'
s=host.show(L.unit);launch=s['ExecStart'];assert s['EnvironmentFiles']==[[p,o] for p,o in pins.environment_files]
assert len(s['DropInPaths'])==11
links=inst._state_links();inst._baseline_paths()
config=pathlib.Path('/etc/enclave-funding/activation-20261028-r1/fee-policy.json')
oldbytes=config.read_bytes();assert sha(oldbytes)=='efb44bc31c5a30dfa1078cf4b9a4d9af66e8449fc9167943e410766bad8013e3'
newbytes=(ROOT/'fee-policy.json').read_bytes();old=json.loads(oldbytes);new=json.loads(newbytes)
assert old['tx']['gasLimit']==1000000 and new['tx']['gasLimit']==1200000
expected=json.loads(oldbytes);expected['tx']['gasLimit']=1200000;assert new==expected
assert new['pricing']['maxFee6']=='80000' and new['notAfter']>time.time()+3600
assert int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))>4096*1024
assert os.statvfs(L.state_dir).f_bavail*os.statvfs(L.state_dir).f_frsize>2*1024**3
oldenv=host.environ(ident['pid'])
oldfiles={str(p):sha(p.read_bytes()) for p in [pathlib.Path(L.unit_file),*sorted(pathlib.Path(L.dropin_dir).iterdir()),*[pathlib.Path(p) for p,_ in pins.environment_files],*base.glob('*.mjs')] if p.is_file()}
jpath=pathlib.Path(L.state_dir)/'sessions-relayer.json';jd=json.loads(jpath.read_bytes())
assert all(x.get('status')=='mined' for x in jd['txs'])
assert all(x.get('status')=='done' for x in jd.get('intents',{}).values())
assert max(x['nonce'] for x in jd['txs'])==97
if sys.argv[1:]==['--check']:
 print(json.dumps({'readOnly':True,'identity':ident,'oldGasLimit':1000000,'newGasLimit':1200000,'feeCapMicroUSDC':80000,'onlyConfigFieldChanges':True,'journalLastNonce':97,'journalCoverageClaim':False}));sys.exit(0)
assert sys.argv[1:]==['--apply']
state('preflight-passed',oldIdentity=ident,oldPolicySha=sha(oldbytes),newPolicySha=sha(newbytes))
save('old-fee-policy.json',old)
with (ROOT/'old-fee-policy.raw.json').open('xb') as f:f.write(oldbytes);f.flush();os.fsync(f.fileno())
os.chmod(ROOT/'old-fee-policy.raw.json',0o600);fs.fsync_path(str(ROOT))
g=gate_action('gate');save('gate.json',g)
pre=inst.snapshot(OP,'pre-stop',ident['pid'],ident['startTicks']);save('pre-stop.json',pre)
assert inst._live_identity(ident['pid'],ident['startTicks'])==ident
state('stop-requested',oldIdentity=ident)
host.stop(L.unit);inst._require_stopped(ident)
stop={'op':OP,'oldIdentity':ident,'observedStopped':True,'at':int(time.time()),'coverageVerified':False,'pendingTrackingRiskAccepted':True}
save('stop.json',stop)
post=inst.snapshot(OP,'post-stop',stop_record_sha256=sha(c.canon(stop)));save('post-stop.json',post)
assert config.read_bytes()==oldbytes
for p,h in oldfiles.items():assert sha(pathlib.Path(p).read_bytes())==h,p
st=config.stat();temp=config.parent/(config.name+'.'+OP)
with temp.open('xb') as f:f.write(newbytes);f.flush();os.fsync(f.fileno())
os.chmod(temp,st.st_mode&0o777);os.chown(temp,st.st_uid,st.st_gid);os.replace(temp,config);fs.fsync_path(str(config.parent))
assert json.loads(config.read_bytes())==new
state('policy-written-start-requested',oldIdentity=ident)
host.start(L.unit)
s=host.show(L.unit);assert s['ActiveState']=='active' and s['MainPID']>0 and s['ExecStart']==launch
newident=inst._live_identity(s['MainPID'],host.start_ticks(s['MainPID']));save('new-identity.json',newident)
parse=lambda b:dict(x.split(b'=',1) for x in b.split(b'\0') if b'=' in x)
a=parse(oldenv);b=parse(host.environ(newident['pid']));volatile=c.VOLATILE_ENV|{b'CREDENTIALS_DIRECTORY'}
assert {k:v for k,v in a.items() if k not in volatile}=={k:v for k,v in b.items() if k not in volatile}
for p,h in oldfiles.items():assert sha(pathlib.Path(p).read_bytes())==h,p
assert inst._state_links()==links
last=None
for attempt in range(4):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8100/v1/sessions/funding/config',timeout=55) as r:fund=json.loads(r.read(1024*1024));assert r.status==200
  assert fund['enabled'] and fund['open']['enabled'] and fund['owner']['enabled'] and fund['chainId']==8453
  save('funding-config.json',fund);last=None;break
 except Exception as e:last=type(e).__name__;time.sleep(3)
assert last is None,'health failed:'+str(last)
assert inst._live_identity(newident['pid'],newident['startTicks'])==newident
save('gate-restored.json',gate_action('restore'))
gs=json.loads(run(['python3',str(gate),'status','--op',OP]));assert gs['gateAbsent'] and gs['matchesBefore'];save('gate-final.json',gs)
state('healthy-public-writes-open',oldIdentity=ident,newIdentity=newident,environmentPreserved=True,gasLimit=1200000,feeCapMicroUSDC=80000,journalsRestored=False)
print(json.dumps({'op':OP,'phase':'healthy-public-writes-open','oldPid':ident['pid'],'newPid':newident['pid'],'gasLimit':1200000,'feeCapMicroUSDC':80000}))
