"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

CAPTURE_GUARD=None
def capture(argv, seconds, stdin=None, limit=1048576, on_stdout=None):
    started = time.monotonic()
    deadline = started + seconds
    child = None; sel = None; rc = None; reason = None; sent = 0; deadline_exceeded = False
    cleanup_errors = []; group_signal = False; child_reaped = False
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    payload = memoryview(stdin) if stdin is not None else None

    def retain(name, data):
        nonlocal reason
        if name == "stdout" and on_stdout is not None: on_stdout(data)
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
            if CAPTURE_GUARD is not None: CAPTURE_GUARD()
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

from pathlib import Path
import json,platform,shutil,pwd,grp,hashlib
r={'readOnly':True,'capacityAdmission':False,'pendingCommitments':'UNKNOWN','at':time.time(),'errors':[]}
def read(path,limit=131072):
 b=Path(path).read_bytes();assert len(b)<=limit,path;return b.decode()
def cmd(name,argv,seconds=4,limit=65536):
 x=capture(argv,seconds,limit=limit);r[name]=x
 if x['rc']!=0 or x['reason']:r['errors'].append(name)
 return x['stdout']
r['kernel']=platform.uname()._asdict();r['uid']=os.getuid();r['affinity']=sorted(os.sched_getaffinity(0));r['boot']=read('/proc/sys/kernel/random/boot_id').strip();r['meminfo']=read('/proc/meminfo');r['osRelease']=read('/etc/os-release');r['selfCgroup']=read('/proc/self/cgroup')
cmd('mounts',['/usr/bin/findmnt','-J','-o','TARGET,SOURCE,FSTYPE,OPTIONS'],limit=131072)
cmd('disk',['/usr/bin/df','-B1','-P','/','/var/lib','/run'])
cmd('inodes',['/usr/bin/df','-i','-P','/','/var/lib','/run'])
cmd('jobs',['/usr/bin/systemctl','list-jobs','--no-pager','--no-legend'])
services=cmd('services',['/usr/bin/systemctl','list-units','--all','--type=service','--plain','--no-pager','--no-legend'])
names=[x.split()[0] for x in services.splitlines() if x.strip()];assert len(names)<=200
props=['Id','LoadState','ActiveState','SubState','MainPID','InvocationID','ControlGroup','MemoryCurrent','MemoryPeak','MemoryMax','MemoryHigh','MemorySwapMax','TasksCurrent','TasksMax','CPUQuotaPerSecUSec','AllowedCPUs','User','Group','FragmentPath']
if names:cmd('serviceProperties',['/usr/bin/systemctl','show','--no-pager',*['--property='+x for x in props],*names],seconds=8,limit=262144)
root=Path('/sys/fs/cgroup');rows=[]
for parent,dirs,files in os.walk(root):
 dirs.sort();assert len(rows)<512,'cgroup-bound'
 row={'path':str(Path(parent).relative_to(root))}
 for n in ('memory.current','memory.max','memory.high','memory.swap.max','memory.events','pids.current','pids.max','cgroup.procs','cpuset.cpus.effective'):
  if n in files:
   try:row[n]=read(Path(parent)/n,16384).strip()
   except Exception as e:row[n]={'error':type(e).__name__};r['errors'].append('cgroup-read:'+str(Path(parent)/n))
 rows.append(row)
r['cgroups']=rows
procs=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 assert len(procs)<2048,'process-bound'
 try:
  s=read(p/'status',16384);fields={k:v.strip() for k,v in (x.split(':',1) for x in s.splitlines()) if k in ('Name','Uid','Gid','VmRSS','Threads')}
  st=read(p/'stat',16384);fields['start']=st[st.rfind(')')+2:].split()[19];fields['pid']=int(p.name);fields['cgroup']=read(p/'cgroup',8192).strip();procs.append(fields)
 except FileNotFoundError:procs.append({'pid':int(p.name),'disappeared':True})
 except Exception as e:r['errors'].append('process:'+p.name+':'+type(e).__name__)
r['processes']=procs
r['identities']={'users':[{'name':x.pw_name,'uid':x.pw_uid,'gid':x.pw_gid} for x in pwd.getpwall() if x.pw_uid in (995,997,50001,50002) or x.pw_name.startswith('enclavel1')], 'groups':[{'name':x.gr_name,'gid':x.gr_gid,'members':x.gr_mem} for x in grp.getgrall() if x.gr_gid in (986,987,50001,50002) or x.gr_name.startswith('enclavel1')]}
r['nbdModuleLoaded']=Path('/sys/module/nbd').exists();r['nbdDevices']=[]
for p in sorted(Path('/sys/class/block').glob('nbd*')):
 row={'name':p.name}
 for n in ('size','pid','ro'):
  q=p/n
  if q.exists():row[n]=read(q,8192).strip()
 row['holders']=[x.name for x in (p/'holders').iterdir()];r['nbdDevices'].append(row)
r['tools']={}
for name in ('python3','systemd-run','systemctl','nbd-client','modprobe','modinfo','mount','umount','blkid','findmnt','ss','sshd','ssh'):
 path=shutil.which(name)
 if path:
  h=hashlib.sha256()
  with open(path,'rb') as f:
   while b:=f.read(1048576):h.update(b)
  r['tools'][name]={'path':path,'realpath':str(Path(path).resolve()),'sha256':h.hexdigest()}
 else:r['tools'][name]=None
if shutil.which('modinfo'):cmd('nbdModuleInfo',[shutil.which('modinfo'),'nbd'])
if shutil.which('ldconfig'):cmd('libraryCache',[shutil.which('ldconfig'),'-p'],limit=131072)
if shutil.which('dpkg-query'):cmd('packages',[shutil.which('dpkg-query'),'-W','-f=${Package} ${Version} ${Architecture}\n','libc6','libssl3','libssl3t64','libglib2.0-0','libglib2.0-0t64','libnl-3-200','libnl-genl-3-200','nbd-client','systemd','python3'],limit=16384)
if shutil.which('sshd'):
 x=capture([shutil.which('sshd'),'-T'],4,limit=65536);r['sshdRead']={k:v for k,v in x.items() if k not in ('stdout','stderr')};r['forwardPolicy']=[line for line in x['stdout'].splitlines() if line.split(' ',1)[0] in ('allowtcpforwarding','allowstreamlocalforwarding','disableforwarding','permitopen','permitlisten','gatewayports','streamlocalbindmask')]
 if x['rc']!=0 or x['reason']:r['errors'].append('sshd-read')
cmd('listeners',['/usr/bin/ss','-ltn'],limit=16384)
print(json.dumps(r,sort_keys=True))
