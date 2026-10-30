from pathlib import Path
p=Path(__file__).resolve().parent;s=p/'source'
f=s/'nan-admission.py';t=f.read_text()
t=t.replace('last_pending_check=0', '''last_pending_check=0

def timer_window(rows, admitted, horizon):
    import datetime
    def due(value):
        if value==['-']:return None
        return datetime.datetime.strptime(' '.join(value),'%a %Y-%m-%d %H:%M:%S %Z').replace(tzinfo=datetime.timezone.utc).timestamp()
    before={tuple(r[0]):due(r[1]) for r in admitted};after={tuple(r[0]):due(r[1]) for r in rows}
    assert set(before)==set(after),'timer-set-or-target-changed'
    for key,new in after.items():
        old=before[key]
        # OS work already due inside the reviewed horizon was included in its residual policy.
        # Randomized future timers may move outside this horizon without adding a commitment.
        if new is not None and new<=horizon and (old is None or old>horizon):
            raise AssertionError('timer-work-entered-admitted-window')
''',1)
t=t.replace("    assert timer_rows==a['timerRows'],'timer-set-or-due-window-changed'", """    timer_window(timer_rows,a['timerRows'],a['expiresAt'])
    props=capture(['/usr/bin/systemctl','show',*sorted(a['timerUnitPaths']),'--property=Id,FragmentPath,DropInPaths'],4,limit=32768)
    assert props['rc']==0 and not props['reason'] and not props['truncated'],'timer-config-read'
    rows={}
    for block in props['stdout'].strip().split('\\n\\n'):
        values=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
        if values:rows[values.pop('Id')]=values
    assert rows==a['timerUnitPaths'],'timer-unit-configuration-path-changed'
    for record in a['timerConfigFiles']:
        q=P(record['path']);assert q.is_file() and sha(q)==record['sha256'],'timer-configuration-content-changed'""")
t=t.replace("headroom=nan_headroom\nCAPTURE_GUARD=headroom", """def checked_headroom():
    try:nan_headroom()
    except Exception as error:
        out['guardFailure']={'type':type(error).__name__,'message':str(error)[:180]}
        raise
headroom=checked_headroom
CAPTURE_GUARD=headroom""")
f.write_text(t)
# All three own caps configured before any guarded module/library work.
f=s/'run-body.py';t=f.read_text()
a=t.index("with unit.open('x') as f:f.write(");b=t.index("print(json.dumps({'root':",a)
t=t[:a]+'''for name,mib in zip(M['ownedSlices'],(4096,128,128)):
 path=P('/run/systemd/system')/name
 with path.open('x') as f:f.write('[Unit]\\nDescription=Nan CL '+M['nonce']+' '+name+'\\n[Slice]\\nMemoryMax='+str(mib)+'M\\nMemorySwapMax=0\\nCPUQuota=100%\\nAllowedCPUs=1\\nTasksMax=1024\\n')
for argv in (['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start',*M['ownedSlices']]):
 r=capture(argv,5,limit=16384);assert r['rc']==0 and not r['reason']
for name,mib in zip(M['ownedSlices'],(4096,128,128)):
 assert (P('/sys/fs/cgroup')/name/'memory.max').read_text().strip()==str(mib<<20)
 assert (P('/sys/fs/cgroup')/name/'memory.swap.max').read_text().strip()=='0'
'''+t[b:]
f.write_text(t)
f=s/'client-operations.py';t=f.read_text();a=t.index('def create_slice():');b=t.index('def description(',a)
t=t[:a]+'''def create_slice():
    # Bootstrap owns and configures all caps before library guard; do not reload timers again.
    for name,mib in zip(M['ownedSlices'],(4096,128,128)):
        info=unit_info(name)
        assert info.get('Description')=='Nan CL '+M['nonce']+' '+name and info.get('ActiveState')=='active','owned-slice-identity'
        q=P('/sys/fs/cgroup')/name
        assert read(q/'memory.max')==str(mib<<20) and read(q/'memory.swap.max')=='0','owned-slice-cap'
'''+t[b:];f.write_text(t)
# Durable preactivation identity exists even when a library check fails.
f=s/'client-main.py';t=f.read_text();t=t.replace("    EXEC.mkdir(mode=0o755);PAYLOAD.mkdir(mode=0o755);(PAYLOAD/'bin').mkdir(mode=0o755)","    EXEC.mkdir(mode=0o755)\n    st=EXEC.stat();s=state();s['execIdentity']=[st.st_dev,st.st_ino];save(s)\n    PAYLOAD.mkdir(mode=0o755);(PAYLOAD/'bin').mkdir(mode=0o755)")
a=t.index("    out['runtimeLibraries']=library_receipt()");b=t.index("    with LOCK.open('x'):pass",a)
t=t[:a]+'''    st=ROOT.stat();socket_path=P(M['remoteSocket']);socket_stat=socket_path.lstat();parent_stat=socket_path.parent.lstat()
    assert stat.S_ISSOCK(socket_stat.st_mode) and socket_stat.st_uid==M['sshUid'] and stat.S_IMODE(socket_stat.st_mode)==0o600
    assert stat.S_ISDIR(parent_stat.st_mode) and parent_stat.st_uid==M['sshUid'] and stat.S_IMODE(parent_stat.st_mode)==0o700
    s={'nonce':M['nonce'],'unitPrefix':M['unitPrefix'],'rootIdentity':[st.st_dev,st.st_ino],
       'execIdentity':None,'claimed':False,'clients':{},'watchStarted':False,'socketIdentity':[socket_stat.st_dev,socket_stat.st_ino],
       'helperPid':os.getpid(),'helperStart':P('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
       'watchdogDeadline':time.time()+300,'moduleInitiallyLoaded':P('/sys/module/nbd').exists(),'moduleLoadedByFixture':False}
    save(s)
    out['runtimeLibraries']=library_receipt()
    seal_payload();MOUNT.parent.mkdir(mode=0o700);MOUNT.mkdir(mode=0o700)
    s=state()
'''+t[b:]
# Error path/stop-post already generate preActivationExit when no watchdog/resources; don't require missing device.
f.write_text(t)
f=s/'transport-helpers.py';t=f.read_text();a=t.index("    st=EXEC.lstat();assert");b=t.index("    return s",a)
t=t[:a]+'''    if s.get('execIdentity') is not None:
        st=EXEC.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o755
        assert s['execIdentity']==[st.st_dev,st.st_ino],'exec-identity-drift'
    else:
        # An interrupted fresh mkdir/seal is retained. No client or NBD can launch before sealing.
        assert not s.get('claimed') and not s.get('clients'),'resources-before-executable-seal'
'''+t[b:];f.write_text(t)
# Fresh read pins full timer+target unit paths/config files; no private file contents emitted.
f=p/'fresh-read-body.py';t=f.read_text();needle="assert not out['atQueue']['stdout'].strip()"
insert='''timer_units=sorted({v for line in out['timers']['stdout'].splitlines() if line.strip() for v in line.split()[-2:]})
assert len(timer_units)<=64
properties=capture(['/usr/bin/systemctl','show',*timer_units,'--property=Id,FragmentPath,DropInPaths'],5,limit=32768)
assert properties['rc']==0 and not properties['reason'] and not properties['truncated']
out['timerUnitPaths']={};paths=set()
for block in properties['stdout'].strip().split('\\n\\n'):
 row=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
 if not row:continue
 name=row.pop('Id');out['timerUnitPaths'][name]=row
 for key,value in row.items():
  if value:paths.update(value.split())
assert len(paths)<=128
out['timerConfigFiles']=[]
for name in sorted(paths):
 q=P(name);st=q.stat();assert q.is_file() and st.st_uid==0 and not st.st_mode&0o022 and st.st_size<=65536
 out['timerConfigFiles'].append({'path':name,'sha256':sha(q)})
'''
assert needle in t;t=t.replace(needle,insert+needle);f.write_text(t)
print('Separate n2 source fixed; no runtime admission')
