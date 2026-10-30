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


LIBS=[{'bytes': 2065824, 'installedMd5Matched': True, 'package': 'libgnutls30t64:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libgnutls.so.30.37.1', 'sha256': 'ddbae2995750875c07bc218d12a062d73f8250678f54dedda7e9be5068781c98', 'version': '3.8.3-1.1ubuntu3.6'}, {'bytes': 27984, 'installedMd5Matched': True, 'package': 'libnl-genl-3-200:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libnl-genl-3.so.200.26.0', 'sha256': '0757db7e6c5fbc4d2a8bbedbac7061fbb8ebb6196b4d2954d3a321e9ff76933c', 'version': '3.7.0-0.3build1.1'}, {'bytes': 133944, 'installedMd5Matched': True, 'package': 'libnl-3-200:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libnl-3.so.200.26.0', 'sha256': 'afcb69e2ef0b46c2ce7b7483848332fa9462776d33163f64209acf01f86eddd7', 'version': '3.7.0-0.3build1.1'}, {'bytes': 2129424, 'installedMd5Matched': True, 'package': 'libc6:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libc.so.6', 'sha256': '3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf', 'version': '2.39-0ubuntu8.9'}, {'bytes': 1714008, 'installedMd5Matched': True, 'package': 'libp11-kit0:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libp11-kit.so.0.3.1', 'sha256': 'a59efd4792d3343dedea1d26a28f5597abfe3369082deb504c4802a31b014897', 'version': '0.25.3-4ubuntu2.2'}, {'bytes': 133192, 'installedMd5Matched': True, 'package': 'libidn2-0:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libidn2.so.0.4.0', 'sha256': '6e632fd9a3125db60bbc623719bbc17b0470330321c5b1c57f1ff7190e5551ad', 'version': '2.3.7-2build1.1'}, {'bytes': 1755312, 'installedMd5Matched': True, 'package': 'libunistring5:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libunistring.so.5.0.0', 'sha256': '7bcf825cd449892db5105ad2aed91dcf94a27b796426600c765720c584c54dd1', 'version': '1.1-2build1.1'}, {'bytes': 88216, 'installedMd5Matched': True, 'package': 'libtasn1-6:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libtasn1.so.6.6.3', 'sha256': '59994414d0cdec4f678ef91eaaafc44b26b00bca507e4cc7978caaf79f584173', 'version': '4.19.0-3ubuntu0.24.04.2'}, {'bytes': 342280, 'installedMd5Matched': True, 'package': 'libnettle8t64:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libnettle.so.8.8', 'sha256': 'a245ed916229583d6fe0b07657b3ed945bc148c28cc08b5266295f620d2b91cc', 'version': '3.9.1-2.2build1.1'}, {'bytes': 288920, 'installedMd5Matched': True, 'package': 'libhogweed6t64:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libhogweed.so.6.8', 'sha256': 'c3c606139d4f7776efa4dbd4a6b62e30c916b07a0cafd8c3ef173d6f093607e3', 'version': '3.9.1-2.2build1.1'}, {'bytes': 534896, 'installedMd5Matched': True, 'package': 'libgmp10:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libgmp.so.10.5.0', 'sha256': '0ccdfb6d6f5c039465f6d002cf7e4c072d48ac6a2cffc8dd6c748dec31592804', 'version': '2:6.3.0+dfsg-2ubuntu6.1'}, {'bytes': 236616, 'installedMd5Matched': True, 'package': 'libc6:amd64', 'path': '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', 'sha256': 'c20a2dc8917c755f02b94049356320fe1f62ac7d9f8994731f807d9df39302da', 'version': '2.39-0ubuntu8.9'}, {'bytes': 47672, 'installedMd5Matched': True, 'package': 'libffi8:amd64', 'path': '/usr/lib/x86_64-linux-gnu/libffi.so.8.1.4', 'sha256': '00f593fe192f2851b8ce23b25cec2488d769beb5a8f63e8c9e563071e1075153', 'version': '3.4.6-1build1'}]
from pathlib import Path
import json,hashlib,stat,shlex,re,platform
p=Path;out={'at':time.time(),'readOnly':True,'errors':[],'boot':p('/proc/sys/kernel/random/boot_id').read_text().strip()}
def rd(q,n=65536):
 b=p(q).read_bytes();assert len(b)<=n,'read-limit';return b
def cmd(key,args,t=5,lim=32768):
 r=capture(args,t,limit=lim);out[key]=r
 if r['rc'] or r['reason']:out['errors'].append(key)
 return r['stdout']
assert out['boot']=='4b84b9bd-a89d-4b37-94cb-26334dbf4666','boot-changed'
cmd('timers',['/usr/bin/systemctl','list-timers','--all','--no-pager','--no-legend'],lim=65536)
cmd('jobs',['/usr/bin/systemctl','list-jobs','--no-pager','--no-legend'])
if p('/usr/bin/atq').exists():cmd('atQueue',['/usr/bin/atq'])
else:out['atQueue']={'absentExecutable':True}
cron=[]
paths=[p('/etc/crontab')]+sorted(p('/etc/cron.d').glob('*'))+sorted(p('/var/spool/cron/crontabs').glob('*'))
assert len(paths)<=80,'cron-file-limit'
for q in paths:
 if not q.exists() or not q.is_file():continue
 st=q.lstat();assert stat.S_ISREG(st.st_mode),'cron-not-regular'
 data=rd(q);rows=[]
 for line in data.decode().splitlines():
  text=line.strip()
  if not text or text.startswith('#'):continue
  if re.match(r'^[A-Za-z_][A-Za-z0-9_]*\s*=',text):rows.append({'environmentAssignmentName':text.split('=',1)[0].strip()});continue
  bits=text.split();count=1 if text.startswith('@') else 5
  if str(q).startswith('/etc/'):count+=1
  rows.append({'scheduleAndUser':bits[:count],'commandSha256':hashlib.sha256(' '.join(bits[count:]).encode()).hexdigest()})
 cron.append({'path':str(q),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'rows':rows})
out['cronSchedules']=cron
out['periodicDirectories']={}
for directory in ('/etc/cron.hourly','/etc/cron.daily','/etc/cron.weekly','/etc/cron.monthly'):
 rows=[]
 for q in sorted(p(directory).glob('*')):
  assert len(rows)<80,'periodic-file-limit'
  st=q.lstat()
  if stat.S_ISREG(st.st_mode):rows.append({'name':q.name,'bytes':st.st_size,'sha256':hashlib.sha256(rd(q,262144)).hexdigest(),'executable':bool(st.st_mode&0o111)})
  else:rows.append({'name':q.name,'kind':'nonregular'})
 out['periodicDirectories'][directory]=rows
# Read complete public service path identities without serializing private argv/environment.
svc=cmd('loadedServices',['/usr/bin/systemctl','list-units','--all','--type=service','--plain','--no-pager','--no-legend'],lim=65536)
names=[x.split()[0] for x in svc.splitlines() if x.strip()];assert len(names)<=200
x=capture(['/usr/bin/systemctl','show','--no-pager','--property=Id,ExecStart,ActiveState,MainPID,MemoryMax',*names],8,limit=262144);assert x['rc']==0 and not x['reason']
services=[]
for block in x['stdout'].strip().split('\n\n'):
 row=dict(l.split('=',1) for l in block.splitlines() if '=' in l);execspec=row.pop('ExecStart','');row['executablePaths']=re.findall(r'path=([^ ;}]+)',execspec);row['execSpecSha256']=hashlib.sha256(execspec.encode()).hexdigest();services.append(row)
out['serviceExecutables']=services
out['usersAndGroups']={}
for file in ('/etc/passwd','/etc/group'):
 rows=[]
 for l in rd(file).decode().splitlines():
  bits=l.split(':');rows.append({'name':bits[0],'numericId':bits[2],'primaryGid':bits[3] if file.endswith('passwd') else None})
 out['usersAndGroups'][file]=rows
out['processExecutablePaths']=[]
for q in p('/proc').iterdir():
 if not q.name.isdigit():continue
 assert len(out['processExecutablePaths'])<2048
 try:
  st=rd(q/'stat',16384).decode();status=rd(q/'status',16384).decode();uid=next(l for l in status.splitlines() if l.startswith('Uid:')).split()[1:]
  out['processExecutablePaths'].append({'pid':int(q.name),'start':st.rsplit(')',1)[1].split()[19],'uid':uid,'exe':str((q/'exe').resolve(strict=True)),'cwd':str((q/'cwd').resolve(strict=True))})
 except FileNotFoundError:continue
 except PermissionError:out['errors'].append('process-executable-permission:'+q.name)
out['libraryClosure']=[]
for expected in LIBS:
 q=p(expected['path']);row={'path':str(q)}
 try:
  resolved=q.resolve(strict=True);st=resolved.stat();assert st.st_uid==0 and not st.st_mode&0o022
  with resolved.open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
  row.update({'realpath':str(resolved),'bytes':st.st_size,'sha256':sha,'matchesControlReceipt':sha==expected['sha256']})
 except Exception as e:row['error']=type(e).__name__;out['errors'].append('library:'+str(q))
 out['libraryClosure'].append(row)
out['meminfo']=rd('/proc/meminfo').decode()
print(json.dumps(out,sort_keys=True))
