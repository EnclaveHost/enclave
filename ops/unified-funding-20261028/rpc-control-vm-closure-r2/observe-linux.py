"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

def capture(argv, seconds, stdin=None, limit=1048576):
    started = time.monotonic()
    deadline = started + seconds
    child = None; sel = None; rc = None; reason = None; sent = 0; deadline_exceeded = False
    cleanup_errors = []; group_signal = False; child_reaped = False
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    payload = memoryview(stdin) if stdin is not None else None

    def retain(name, data):
        nonlocal reason
        totals[name] += len(data)
        buffers[name].extend(data[:max(0, limit - len(buffers[name]))])
        if totals[name] > limit: reason = reason or 'output-limit'

    def exited_unreaped():
        # WNOWAIT keeps the child PID reserved. No poll()/wait() precedes group cleanup.
        info = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return info is not None and info.si_pid == child.pid

    def close_registered(stream):
        sel.unregister(stream)
        stream.close()  # unbuffered pipe: close cannot flush unsent stdin

    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, bufsize=0)
        sel = selectors.DefaultSelector()
        for name in buffers:
            stream = getattr(child, name)
            os.set_blocking(stream.fileno(), False)
            sel.register(stream, selectors.EVENT_READ, name)
        if payload is not None:
            os.set_blocking(child.stdin.fileno(), False)
            if len(payload): sel.register(child.stdin, selectors.EVENT_WRITE, 'stdin')
            else: child.stdin.close()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                deadline_exceeded = True; reason = reason or 'timeout'; break
            if exited_unreaped() and not sel.get_map(): break
            for key, _ in sel.select(min(0.1, remaining)):
                if key.data == 'stdin':
                    try:
                        count = os.write(key.fileobj.fileno(), payload[sent:sent+65536])
                    except (BlockingIOError, InterruptedError):
                        continue
                    except BrokenPipeError:
                        # Remote/authentication rejection may close stdin first: still drain its diagnostics.
                        reason = reason or 'stdin-broken-pipe'
                        close_registered(key.fileobj)
                        continue
                    if count <= 0: raise OSError('stdin-write-made-no-progress')
                    sent += count
                    if sent == len(payload): close_registered(key.fileobj)
                else:
                    try: data = os.read(key.fileobj.fileno(), 65536)
                    except (BlockingIOError, InterruptedError): continue
                    if not data:
                        close_registered(key.fileobj); continue
                    retain(key.data, data)
                if any(totals[n] > limit for n in totals): break
            if any(totals[n] > limit for n in totals): break
    except Exception as e:
        reason = reason or ('capture-error:' + type(e).__name__)
    finally:
        if child is not None:
            # Includes stdin/setup/selector failures and normal exit with leftover pipe holders.
            # This routine is the sole reaper; WNOWAIT confirms child ownership before killpg.
            try:
                exited_unreaped()
                try:
                    os.killpg(child.pid, signal.SIGKILL); group_signal = True
                except ProcessLookupError:
                    pass
            except ChildProcessError:
                cleanup_errors.append('child-already-reaped-no-group-signal')
            except Exception as e:
                cleanup_errors.append('group-cleanup:' + type(e).__name__)
            # Drain available public diagnostics even if selector setup failed. Never wait here.
            for name in buffers:
                stream = getattr(child, name, None)
                if stream is None or stream.closed: continue
                try:
                    os.set_blocking(stream.fileno(), False)
                    while totals[name] <= limit:
                        try: data = os.read(stream.fileno(), min(65536, limit+1-totals[name]))
                        except (BlockingIOError, InterruptedError): break
                        if not data: break
                        retain(name, data)
                except Exception as e:
                    cleanup_errors.append('drain-' + name + ':' + type(e).__name__)
            if sel is not None:
                try: sel.close()
                except Exception as e: cleanup_errors.append('selector-close:' + type(e).__name__)
            for name in ('stdin', 'stdout', 'stderr'):
                stream = getattr(child, name, None)
                if stream is not None and not stream.closed:
                    try: stream.close()
                    except Exception as e: cleanup_errors.append('pipe-close:' + type(e).__name__)
            try:
                rc = child.wait(timeout=2); child_reaped = True
            except Exception as e:
                cleanup_errors.append('child-wait:' + type(e).__name__)
        elif sel is not None:
            try: sel.close()
            except Exception as e: cleanup_errors.append('selector-close:' + type(e).__name__)
    if cleanup_errors: reason = reason or 'local-cleanup-incomplete'
    return {'rc': rc, 'reason': reason, 'elapsedSeconds': time.monotonic() - started,
            'stdout': buffers['stdout'].decode('utf-8', 'replace'),
            'stderr': buffers['stderr'].decode('utf-8', 'replace'), 'bytesObserved': totals,
            'stdinBytesWritten': sent, 'stdinBytesRequested': len(payload) if payload is not None else 0,
            'truncated': any(totals[n] > limit for n in totals),
            'localChildReaped': child_reaped, 'ownedGroupKillAttempted': group_signal,
            'cleanupErrors': cleanup_errors, 'deadlineExceeded': deadline_exceeded,
            'localProcessGroupDeathProven': False,
            # Local SSH exit/kill never establishes the lifetime of a remote command.
            'remoteDeathProven': False}

# Sent to python3 -B - through existing strict SSH, never installed remotely.
import json, pathlib, re, shutil, sys, platform
P = pathlib.Path
out = {'readOnly': True, 'capacityAdmitted': False, 'errors': []}
deadline = time.monotonic() + 27
def read(path, limit=8192):
    try:
        with open(path, 'rb') as f: b = f.read(limit + 1)
        if len(b) > limit: raise ValueError('field-too-large')
        return b.decode('utf-8', 'replace').strip()
    except Exception as e:
        return {'unavailable': type(e).__name__}
def command(name, argv, seconds=5):
    if time.monotonic() >= deadline:
        out['errors'].append('observer-deadline:' + name); return None
    r = capture(argv, min(seconds, max(0.1, deadline-time.monotonic())), limit=524288)
    out[name] = r
    if r['rc'] or r['reason']: out['errors'].append('command-incomplete:' + name)
    return r
out['identity'] = {'bootId': read('/proc/sys/kernel/random/boot_id'),
                   'hostname': platform.node(), 'kernel': platform.release(),
                   'machine': platform.machine(), 'cpuOnline': os.cpu_count(),
                   'observerCgroup': read('/proc/self/cgroup')}
mem = read('/proc/meminfo')
out['memory'] = {l.split(':',1)[0]: l.split(':',1)[1].strip() for l in mem.splitlines()
                 if l.split(':',1)[0] in ('MemTotal','MemAvailable','SwapTotal','SwapFree','Unevictable','Mlocked','Slab','SUnreclaim','PageTables')} if isinstance(mem,str) else mem
out['memoryPressure'] = read('/proc/pressure/memory')
command('rootDisk', ['/bin/df','-B1','-P','/'])
listed = command('activeServiceNames', ['/usr/bin/systemctl','list-units','--type=service','--state=active',
                                      '--all','--no-legend','--plain','--no-pager'])
units = []
if listed and listed['rc']==0 and not listed['reason']:
    for line in listed['stdout'].splitlines():
        name = line.split()[0] if line.split() else ''
        if not re.fullmatch(r'[A-Za-z0-9_.:@\\-]+\.service', name):
            out['errors'].append('unsupported-unit-name'); continue
        units.append(name)
    if len(units)>256: out['errors'].append('unit-count-limit')
    elif units:
        command('activeServices', ['/usr/bin/systemctl','show',*units,'--no-pager',
               '--property=Id,ActiveState,SubState,ControlGroup,MemoryCurrent,MemoryPeak,MemoryHigh,MemoryMax,MemoryLow,MemoryMin,MemorySwapMax,TasksCurrent,TasksMax,CPUQuotaPerSecUSec,OOMScoreAdjust,ManagedOOMMemoryPressure'],8)
# Read the full cgroup tree (including ancestors and user service subtrees) without reading process environments.
root=P('/sys/fs/cgroup'); groups=[]
attrs=('cgroup.type','cgroup.controllers','memory.current','memory.peak','memory.max','memory.high',
       'memory.min','memory.low','memory.swap.current','memory.swap.max','memory.events','cpu.max','pids.current','pids.max')
for here, dirs, files in os.walk(root, followlinks=False,
                                onerror=lambda e: out['errors'].append('cgroup-walk-unreadable:'+type(e).__name__)):
    dirs.sort()
    if time.monotonic()>=deadline or len(groups)>=384:
        out['errors'].append('cgroup-enumeration-incomplete'); break
    q=P(here)
    if len(q.relative_to(root).parts)>24:
        dirs[:]=[];out['errors'].append('cgroup-depth-limit');continue
    row={'path':'/'+str(q.relative_to(root)) if q!=root else '/', 'values':{}}
    for a in attrs:
        if a in files:
            row['values'][a]=read(q/a,4096)
            if isinstance(row['values'][a],dict): out['errors'].append('cgroup-field-unreadable')
    groups.append(row)
out['cgroups']=groups
out['rootMemoryMaxPresent']=(root/'memory.max').exists()
out['tools']={}
for name in ('python3','ssh','qemu-nbd','qemu-img','nbd-client','nbdfuse','findmnt','mount','umount',
             'lsblk','systemctl','timeout','sha256sum','flock','readelf','e2fsck'):
    found=shutil.which(name)
    if not found: out['tools'][name]=None; continue
    q=P(found).resolve();s=q.stat()
    out['tools'][name]={'path':found,'realpath':str(q),'bytes':s.st_size,'mtimeNs':s.st_mtime_ns,
                         'device':s.st_dev,'inode':s.st_ino,'executable':os.access(q,os.X_OK)}
out['nbd']={'loaded':P('/sys/module/nbd').is_dir(),
            'devices':[p.name for p in sorted(P('/sys/class/block').glob('nbd*'))][:64],
            'moduleCandidates':[str(p) for p in sorted((P('/lib/modules')/platform.release()/'kernel/drivers/block').glob('nbd.ko*'))][:8],
            'sysParameters':{n:read('/sys/module/nbd/parameters/'+n) for n in ('nbds_max','max_part')}}
command('blockMetadata',['/usr/bin/lsblk','--json','--bytes','--output','NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,RO'],4)
# Capability text only. These options exit without starting any connection/export/client attachment.
for name,args in [('ssh',['-V']),('nbd-client',['-h']),('qemu-nbd',['--help'])]:
    found=shutil.which(name)
    if found: command('capability-'+name,[found,*args],3)
    else: out['capability-'+name]={'available':False}
out['streamLocalServerPolicyVerified']=False
out['streamLocalNote']='Version/help evidence is not proof of sshd AllowStreamLocalForwarding or per-key/Match policy. No socket or forwarding attempted.'
out['complete'] = not out['errors']
print(json.dumps(out,sort_keys=True))
sys.exit(0 if out['complete'] else 2)
