# Functions appended after qualified transport, before operations; no mutation on load.
last_pending_check=0

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


def fresh_nan_policy():
    global last_pending_check
    now=time.time();a=M['admission']
    assert a['authorized'] is True and a['nonce']==M['nonce']
    assert a['scope']=='nan-cl-only-4096' and a['observedPendingMiB']>=0
    assert a['osReserveMiB']==2048 and a['creatorClassification']=='two-launches-before-wait-no-repeated-allocator'
    assert a['at']<=now<=a['expiresAt'] and a['expiresAt']-a['at']<=600,'stale-Nan-admission'
    assert read('/proc/sys/kernel/random/boot_id')==M['bootId'],'Nan-boot-changed'
    if now-last_pending_check<5:return
    last_pending_check=now
    creator=P('/proc/1281392')
    assert (creator/'stat').read_text().rsplit(')',1)[1].split()[19]=='867080689','creator-replaced'
    assert str((creator/'exe').resolve(strict=True))=='/usr/bin/bash'
    assert hashlib.sha256((creator/'cmdline').read_bytes()).hexdigest()==a['creatorCmdlineSha256'],'creator-command-changed'
    assert str((creator/'cwd').resolve(strict=True))=='/root/padspill-20261005','creator-directory-changed'
    # Read only public executable identities/cgroup; never environments, pads or logs.
    count=0;until=time.monotonic()+3
    for q in P('/proc').iterdir():
        if not q.name.isdigit():continue
        count+=1;assert count<=512 and time.monotonic()<until,'pending-census-bound'
        try:
            exe=str((q/'exe').resolve(strict=True));cg=(q/'cgroup').read_text()
            if any('/'+x+'/' in cg or cg.strip().endswith('/'+x) for x in M['ownedSlices']):continue
            if any(cg.strip().endswith('/'+unit) for unit in M['ownedBootstrapUnits']):continue
            if cg.strip()=='0::/system.slice/cron.service':continue  # all cron sources pinned below; OS residual accounts this work
            if exe in ('/usr/bin/bash','/usr/bin/dash'):
                argv=(q/'cmdline').read_bytes().split(b'\0')
                if len(argv)==4 and argv[1]==b'-c' and argv[2].decode() in M['transportCommands']:continue
            if exe in ('/usr/bin/sudo','/usr/bin/systemd-run'):
                argv=[x.decode() for x in (q/'cmdline').read_bytes().split(b'\0') if x]
                if argv in M['transportArgv']:continue
            fields=(q/'stat').read_text().rsplit(')',1)[1].split()
            start=fields[19]
            if exe=='/usr/bin/pgrep' and fields[1]=='1281392':continue
            if exe in a['ordinaryOsExecutables']:continue
            identity=str(q.name)+':'+start+':'+exe
            assert identity in a['existingOtherProcesses'],'new-unclassified-workload'
        except FileNotFoundError:continue
    jobs=capture(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager'],3,limit=8192)
    assert jobs['rc']==0 and not jobs['reason'],'pending-job-read'
    for line in jobs['stdout'].splitlines():
        fields=line.split();assert len(fields)>=4 and fields[1] in M['ownedUnits'],'unclassified-pending-job'
    timers=capture(['/usr/bin/systemctl','list-timers','--all','--no-legend','--no-pager'],3,limit=16384)
    assert timers['rc']==0 and not timers['reason'] and not timers['truncated'],'timer-read'
    timer_rows=sorted([line.split()[-2:],line.split()[:4] if line.split()[0]!='-' else ['-']] for line in timers['stdout'].splitlines() if line.strip())
    timer_window(timer_rows,a['timerRows'],a['expiresAt'])
    props=capture(['/usr/bin/systemctl','show',*sorted(a['timerUnitPaths']),'--property=Id,FragmentPath,DropInPaths'],4,limit=32768)
    assert props['rc']==0 and not props['reason'] and not props['truncated'],'timer-config-read'
    rows={}
    for block in props['stdout'].strip().split('\n\n'):
        values=dict(line.split('=',1) for line in block.splitlines() if '=' in line)
        if values:rows[values.pop('Id')]=values
    assert rows==a['timerUnitPaths'],'timer-unit-configuration-path-changed'
    for record in a['timerConfigFiles']:
        q=P(record['path']);assert q.is_file() and sha(q)==record['sha256'],'timer-configuration-content-changed'
    queued=capture(['/usr/bin/atq'],3,limit=4096)
    assert queued['rc']==0 and not queued['reason'] and not queued['stdout'].strip(),'pending-at-job'
    for row in a['scheduleDirectories']:
        names=[]
        with os.scandir(row['path']) as entries:
            for entry in entries:
                names.append(entry.name);assert len(names)<=128,'schedule-directory-bound'
        assert sorted(names)==row['entries'],'scheduled-work-added-or-removed'
    for row in a['scheduleFiles']:
        q=P(row['path']);assert q.is_file() and sha(q)==row['sha256'],'scheduled-work-changed'

def nan_headroom():
    global last_guard
    if cleaning or ACTION in ('verify','wait-cleanup','emergency-cleanup','request-stop','socket-clear'):return
    now=time.monotonic()
    if now-last_guard<.5:return
    last_guard=now;fresh_nan_policy()
    available=next(int(l.split()[1])*1024 for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    pending=M['admission']['observedPendingMiB']<<20;groups=[]
    for name,mib in zip(M['ownedSlices'],(4096,128,128)):
        q=P('/sys/fs/cgroup')/name;current=int(read(q/'memory.current')) if q.exists() else 0
        if q.exists():assert read(q/'memory.max')==str(mib<<20) and read(q/'memory.swap.max')=='0','trial-budget-drift'
        pending+=max(0,(mib<<20)-current);groups.append({'path':str(q),'maximum':mib<<20,'current':current})
    assert available-pending>=2048<<20,'Nan-residual-reserve'
    out['lastHeadroom']={'available':available,'remainingTrialAndPending':pending,'residual':available-pending,'floor':2048<<20,'groups':groups,'policyNotWorstCaseReservation':True}
def checked_headroom():
    try:nan_headroom()
    except Exception as error:
        out['guardFailure']={'type':type(error).__name__,'message':str(error)[:180]}
        raise
headroom=checked_headroom
CAPTURE_GUARD=headroom
