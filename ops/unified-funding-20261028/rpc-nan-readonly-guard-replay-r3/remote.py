"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

CAPTURE_GUARD=None
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
                                 start_new_session=True, bufsize=0, env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin","LANG":"C","LC_ALL":"C"})
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
import ast,json,hashlib,time,os,shlex
P=Path
mfile=P('/run/enclave-rpc-nan-client-n1/manifest.json');M=json.loads(mfile.read_text());program=P('/run/enclave-rpc-nan-client-n1/program.py');assert hashlib.sha256(program.read_bytes()).hexdigest()==M['programSha256']
M['transportCommands'].append('sudo -n systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-readonly-guard-replay-r3 --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 /usr/bin/python3 -B -');M['transportArgv'].extend([shlex.split('sudo -n systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-readonly-guard-replay-r3 --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 /usr/bin/python3 -B -'),shlex.split('sudo -n systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-readonly-guard-replay-r3 --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=40 /usr/bin/python3 -B -')[2:]])
original=hashlib.sha256(mfile.read_bytes()).hexdigest();out={'readOnly':True,'diagnosticOnly':True,'originalManifestSha256':original,'originalExpired':time.time()>M['admission']['expiresAt'],'explicitDiagnosticSubstitutions':['fresh diagnostic clock and current timer observation','exact self/ancestor identities only; not native approval'],'guard':None}
def read(p):return P(p).read_text().strip()
def sha(p):
 with P(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
a=M['admission'];a['at']=time.time();a['expiresAt']=a['at']+60
r=capture(['/usr/bin/systemctl','list-timers','--all','--no-legend','--no-pager'],3,limit=16384);assert r['rc']==0 and not r['reason']
originalTimerRows=a['timerRows']
a['timerRows']=sorted([line.split()[-2:],line.split()[:4] if line.split()[0]!='-' else ['-']] for line in r['stdout'].splitlines() if line.strip())
out['originalTimerRows']=originalTimerRows;out['currentTimerRows']=a['timerRows'];out['timerRowsChanged']=originalTimerRows!=a['timerRows']
pid=os.getpid();ancestors=[]
for _ in range(16):
 q=P('/proc')/str(pid);fields=(q/'stat').read_text().rsplit(')',1)[1].split();exe=str((q/'exe').resolve(strict=True));identity=str(pid)+':'+fields[19]+':'+exe
 ancestors.append({'pid':pid,'exe':exe,'identity':identity});a['existingOtherProcesses'].append(identity)
 pid=int(fields[1])
 if pid in (0,1):break
out['diagnosticAncestors']=ancestors;last_pending_check=0
fn=next(x for x in ast.parse(program.read_text()).body if isinstance(x,ast.FunctionDef) and x.name=='fresh_nan_policy')
source=ast.unparse(fn)
needle="assert identity in a['existingOtherProcesses'], 'new-unclassified-workload'"
assert needle in source
replacement="""if identity not in a['existingOtherProcesses']:
                raw=(q/'cmdline').read_bytes();argv=[x.decode() for x in raw.split(b'\\0') if x]
                out['rejectedProcess']={'pid':int(q.name),'start':start,'exe':exe,'cgroup':cg,'argv0':argv[0] if argv else '', 'argc':len(argv),'cmdlineSha256':hashlib.sha256(raw).hexdigest(),'exactTransportMatch':argv in M['transportArgv'],'tailTransportMatch':any(argv[1:]==v[1:] for v in M['transportArgv'])}
            assert identity in a['existingOtherProcesses'], 'new-unclassified-workload'"""
source=source.replace(needle,replacement)
exec(compile(source,'observed-fresh_nan_policy','exec'),globals())
try:fresh_nan_policy();out['guard']='PASS'
except Exception as e:out['guard']={'type':type(e).__name__,'message':str(e)}
out['budgetGroups']=[]
for name in M['ownedSlices']:
 q=P('/sys/fs/cgroup')/name;out['budgetGroups'].append({'name':name,'exists':q.exists(),'max':read(q/'memory.max') if q.exists() else None,'current':read(q/'memory.current') if q.exists() else 0})
assert hashlib.sha256(mfile.read_bytes()).hexdigest()==original
print(json.dumps(out))
