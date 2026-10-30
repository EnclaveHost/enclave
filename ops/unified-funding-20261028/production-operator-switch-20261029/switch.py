"""One explicit operator-authorized cutover, accepting incomplete pending-payment tracking.
No transaction signing, journal reset, old grant change, or automatic resend. Never rerun this operation.
Pre/post private preservation is retained; no observer-coverage claim is made.
"""
import os,sys,json,time,hashlib,subprocess,pathlib,fcntl,urllib.request,types
OP='funding-operator-switch-20261029-r2'
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
pins=c.PRODUCTION_PINS
base=pathlib.Path(L.relay_dir);stage=pathlib.Path(L.stage_dir)
for n,h in pins.protected.items():assert sha((base/n).read_bytes())==h,n
assert sha((base/'sessions.mjs').read_bytes())==pins.original_sessions
for n,h in pins.candidate.items():
    assert not(stage/n).is_symlink() and sha((stage/n).read_bytes())==h,n
    if n!='sessions.mjs':assert not os.path.lexists(base/n),n
assert inst._launch_config(host.show(L.unit))==inst._expected_launch(False)
assert len(host.show(L.unit)['DropInPaths'])==10
ident=inst._live_identity(228946,43738495)
links=inst._state_links()
preflightPaths=inst._baseline_paths()
assert int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))>4096*1024
assert os.statvfs(L.state_dir).f_bavail*os.statvfs(L.state_dir).f_frsize>2*1024**3
config=pathlib.Path('/etc/enclave-funding/activation-20261028-r1')
mpins={'owner-controls.json':'85f760b12491cecffae4a7a9f158d10a590205d05c4039c9d7b7295a5628f3c5','intake-manifest.json':'2fb3fcced1e297e3efe420a127c65b597924c09ac5aaae8958783988fb0e067c','fee-policy.json':'efb44bc31c5a30dfa1078cf4b9a4d9af66e8449fc9167943e410766bad8013e3'}
for n,h in mpins.items():
    assert sha((config/n).read_bytes())==h,n
    d=json.loads((config/n).read_bytes())
    if 'notAfter' in d:assert d['notAfter']>time.time()+3600
env={'SESSIONS_WRITE_QUARANTINE':'0','SESSIONS_FUNDING_OWNER_CONTROLS':'1','SESSIONS_FUNDING_INTAKE':'1','SESSIONS_FUNDING_OWNER_MANIFEST':str(config/'owner-controls.json'),'SESSIONS_FUNDING_MANIFEST':str(config/'intake-manifest.json'),'SESSIONS_FUNDING_FEE_POLICY':str(config/'fee-policy.json'),'SESSIONS_FUNDING_RELAYER':'0xf4B78D91911e1c064A02E4D28C69E2De6056bE57'}
argv=['/usr/bin/env']+[k+'='+v for k,v in env.items()]+list(pins.exec_argv)
assert all(c.ARGV_TOKEN_RE.fullmatch(x) for x in argv)
drop=pathlib.Path(L.dropin_dir)/'zzzzzzzzzz-funding-operator-switch-20261029-r2.conf'
assert not os.path.lexists(drop)
dropbytes=('[Service]\nExecStart=\nExecStart='+' '.join(argv)+'\n').encode()
oldenv=host.environ(ident['pid'])
oldfiles={str(p):sha(p.read_bytes()) for p in [pathlib.Path(L.unit_file),*sorted(pathlib.Path(L.dropin_dir).iterdir()),*[pathlib.Path(p) for p,_ in pins.environment_files]] if p.exists()}
if sys.argv[1:]==['--check']:
    print(json.dumps({'readOnly':True,'oldIdentity':ident,'candidatePins':pins.candidate,'manifestPins':mpins,'environmentFiles':len(pins.environment_files),'unitFiles':11,'preservedLinks':len(links),'pendingTrackingRiskAccepted':True}));sys.exit(0)
assert sys.argv[1:]==['--apply']
state('preflight-passed',oldIdentity=ident)
g=gate_action('gate');save('gate.json',g);state('writes-gated',oldIdentity=ident)
for d in [pathlib.Path('/var/lib/enclave-maintenance/funding-cutover')]:
    if not d.exists():d.mkdir(mode=0o700);fs.fsync_path(str(d.parent))
pre=inst.snapshot(OP,'pre-stop',ident['pid'],ident['startTicks']);save('pre-stop.json',pre)
assert inst._live_identity(ident['pid'],ident['startTicks'])==ident
state('stop-requested',oldIdentity=ident)
host.stop(L.unit);inst._require_stopped(ident)
stop={'op':OP,'oldIdentity':ident,'observedStopped':True,'at':int(time.time()),'coverageVerified':False,'pendingTrackingRiskAccepted':True}
save('stop.json',stop)
post=inst.snapshot(OP,'post-stop',stop_record_sha256=sha(c.canon(stop)));save('post-stop.json',post)
state('old-stopped-preserved',oldIdentity=ident,pre=pre,post=post)
assert inst._state_links()==links
for p,h in oldfiles.items():assert sha(pathlib.Path(p).read_bytes())==h,p
inst._require_stopped(ident)
for n,h in pins.candidate.items():
    temp=base/('.'+n+'.'+OP)
    with temp.open('xb') as f:f.write((stage/n).read_bytes());f.flush();os.fsync(f.fileno())
    os.chmod(temp,0o644);assert sha(temp.read_bytes())==h
    os.replace(temp,base/n)
fs.fsync_path(str(base))
with drop.open('xb') as f:f.write(dropbytes);f.flush();os.fsync(f.fileno())
os.chmod(drop,0o644);fs.fsync_path(str(drop.parent))
host.daemon_reload()
s=host.show(L.unit)
assert s['MainPID']==0 and s['ExecStart'][0]['argv']==argv
assert s['EnvironmentFiles']==[[p,o] for p,o in pins.environment_files]
state('candidate-start-requested',oldIdentity=ident,candidatePins=pins.candidate)
host.start(L.unit)
s=host.show(L.unit);assert s['ActiveState']=='active' and s['MainPID']>0 and s['MainPID']!=ident['pid']
newident=inst._live_identity(s['MainPID'],host.start_ticks(s['MainPID']))
save('new-identity.json',newident)
parse=lambda b:dict(x.split(b'=',1) for x in b.split(b'\0') if b'=' in x)
a=parse(oldenv);b=parse(host.environ(newident['pid']))
volatile=c.VOLATILE_ENV|{b'CREDENTIALS_DIRECTORY'};added={k.encode() for k in env}
assert {k:v for k,v in a.items() if k not in volatile|added}=={k:v for k,v in b.items() if k not in volatile|added},'environment changed'
assert all(b[k.encode()]==v.encode() for k,v in env.items())
for p,h in oldfiles.items():assert sha(pathlib.Path(p).read_bytes())==h,p
for n,h in {**pins.candidate,**pins.protected}.items():assert sha((base/n).read_bytes())==h,n
assert inst._state_links()==links
state('candidate-running-gate-retained',oldIdentity=ident,newIdentity=newident,environmentPreserved=True)
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8100'+path,timeout=55) as r:
        assert r.status==200
        return json.loads(r.read(1024*1024))
last=None
for attempt in range(5):
    try:
        legacy=get('/v1/sessions/config');fund=get('/v1/sessions/funding/config')
        assert fund['enabled'] and fund['chainId']==8453 and fund['open']['enabled'] and fund['owner']['enabled'] and int(fund['action'])==10
        assert fund['factory'].lower()=='0x83616b7fa62f8a43cfc634a25c0acf b0ccab76e8'.replace(' ','')
        save('funding-config.json',fund);save('legacy-config.json',legacy);last=None;break
    except Exception as e:last=type(e).__name__;time.sleep(3)
assert last is None,'health check failed: '+str(last)
assert inst._live_identity(newident['pid'],newident['startTicks'])==newident
g=gate_action('restore');save('gate-restored.json',g)
state('switched-healthy-public-writes-open',oldIdentity=ident,newIdentity=newident,environmentPreserved=True,journalsRestored=False,originalSessionChanged=False)
print(json.dumps({'op':OP,'phase':'switched-healthy-public-writes-open','oldPid':ident['pid'],'newPid':newident['pid'],'fundingEnabled':True,'pendingTrackingRiskAccepted':True,'coverageVerified':False,'oldSessionUnchanged':True}))
