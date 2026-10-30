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
import json,ast
p=Path(__file__).resolve().parent/'runtime';M=json.loads((p/'MANIFEST.json').read_text())
with (p/'ROOT-FRESH-ATTEMPT.json').open('x') as f:json.dump({'readOnly':True,'at':time.time()},f)
t=ast.parse((p/'run-body.py').read_text());g={'M':M};exec(compile(ast.Module(body=[next(n for n in t.body if isinstance(n,ast.FunctionDef) and n.name=='sshargs')],type_ignores=[]),'ssh-args','exec'),g)
remote="""from pathlib import Path
import os,json,time,pwd,grp
P=Path
assert os.geteuid()==0
x={'at':time.time(),'boot':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'memory':P('/proc/meminfo').read_text(),'groups':{},'processes':[]}
assert x['boot']==M['bootId']
for name,cap in M['serviceCapsMiB'].items():
 q=P('/sys/fs/cgroup/system.slice')/name;x['groups'][name]={v:(q/v).read_text().strip() for v in ('memory.current','memory.max','memory.swap.max')};assert x['groups'][name]['memory.max']==str(cap<<20)
for q in P('/proc').iterdir():
 if not q.name.isdigit():continue
 assert len(x['processes'])<512
 try:x['processes'].append({'pid':int(q.name),'exe':str((q/'exe').resolve(strict=True)),'cgroup':(q/'cgroup').read_text().strip()})
 except FileNotFoundError:pass
for name,argv in [('jobs',['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager']),('services',['/usr/bin/systemctl','list-units','--type=service','--state=running','--no-legend','--no-pager']),('timers',['/usr/bin/systemctl','list-timers','--all','--no-legend','--no-pager'])]:
 r=capture(argv,4,limit=16384);assert r['rc']==0 and not r['reason'] and not r['truncated'];x[name]=r['stdout']
assert not x['jobs'].strip()
avail=next(int(l.split()[1])*1024 for l in x['memory'].splitlines() if l.startswith('MemAvailable:'));growth=sum(max(0,int(v['memory.max'])-int(v['memory.current'])) for v in x['groups'].values());x['residualAfterTrialAndServiceGrowth']=avail-growth-(2560<<20);assert x['residualAfterTrialAndServiceGrowth']>=1536<<20
print(json.dumps(x))
"""
script=(p/'capture-remote.py').read_text()+'\nM='+repr(M)+'\n'+remote
command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-el-r7-fresh --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=25 /usr/bin/python3 -B -'
r=capture([*g['sshargs'](),M['target'],command],40,stdin=script.encode(),limit=131072)
(p/'ROOT-FRESH-RESULT.json').write_text(json.dumps(r,indent=2)+'\n');assert r['rc']==0 and not r['reason'];x=json.loads(r['stdout']);(p/'ROOT-FRESH-OBSERVATION.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps({'at':x['at'],'boot':x['boot'],'residual':x['residualAfterTrialAndServiceGrowth'],'processes':len(x['processes'])}))
