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
import ast,json,time
p=Path(__file__).resolve().parent
r=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-control-vm-l1-client-root-r8/runtime')
M=json.loads((r/'MANIFEST.json').read_text());t=ast.parse((r/'run-body.py').read_text());g={'M':M};exec(compile(ast.Module(body=[next(n for n in t.body if isinstance(n,ast.FunctionDef) and n.name=='sshargs')],type_ignores=[]),'sshargs','exec'),g)
remote="from pathlib import Path\nimport json,os,time\nP=Path\nassert os.geteuid()==0 and P('/proc/sys/kernel/random/boot_id').read_text().strip()=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'\ns=json.loads(P('/run/enclave-rpc-l1-client-r8/state.json').read_text());assert s['nonce']=='13adb8b1-d469-4e0d-923b-0582681c9d37'\ni=s['clients']['el'];q=P('/sys/fs/cgroup'+i['ControlGroup']);st=q.stat();assert [st.st_dev,st.st_ino]==i['cgroupIdentity']\nr=capture(['/usr/bin/systemctl','show','enclave-rpc-l1-el-trial-r8.service','--property=MainPID,InvocationID,ActiveState,SubState'],3,limit=4096);assert r['rc']==0 and not r['reason'];v=dict(l.split('=',1) for l in r['stdout'].splitlines());assert v['InvocationID']==i['InvocationID']\ninv=i['InvocationID'];assert len(inv)==32 and all(c in '0123456789abcdef' for c in inv)\nr=capture(['/usr/bin/journalctl','--no-pager','-o','json','-n','100','_SYSTEMD_INVOCATION_ID='+inv],3,limit=131072);assert r['rc']==0 and not r['reason'] and not r['truncated']\nmarkers=[]\nfor line in r['stdout'].splitlines():\n row=json.loads(line);msg=row.get('MESSAGE','')\n assert row.get('_SYSTEMD_INVOCATION_ID')==inv\n if type(msg) is list:\n  if len(msg)>8192 or not all(type(b) is int and 0<=b<=255 for b in msg):continue\n  try:msg=bytes(msg).decode('utf-8',errors='strict')\n  except UnicodeDecodeError:continue\n if not isinstance(msg,str) or len(msg)>8192:continue\n for marker in ('Merkle','unwind','Unwind','RPC','HTTP','Database','database','stage','Stage','healing','recovery','error','Error'):\n  if marker in msg:markers.append({'marker':marker,'time':row.get('__REALTIME_TIMESTAMP')});break\nout={'at':time.time(),'sameInvocation':True,'unit':v,'memory':{n:(q/n).read_text().strip() for n in ('memory.current','memory.peak','memory.events')},'markers':markers,'readOnly':True}\nprint(json.dumps(out))\n"
script=(r/'capture-remote.py').read_text()+'\n'+remote
cmd='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-el-r8-progress-read-r1 --property=MemoryMax=64M --property=MemorySwapMax=0 --property=CPUQuota=50% --property=RuntimeMaxSec=15 --property=TimeoutStopSec=5 /usr/bin/python3 -B -'
z=capture([*g['sshargs'](),M['target'],cmd],25,stdin=script.encode(),limit=32768)
(p/'RESULT.json').write_text(json.dumps(z,indent=2));print(json.dumps(z));assert z['rc']==0 and not z['reason']
