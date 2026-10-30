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
import json,hashlib,os,time,stat
P=Path;root=P('/run/enclave-rpc-nan-client-n1');m=json.loads((root/'manifest.json').read_text());out={'at':time.time(),'boot':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'unknown':[],'knownTransport':[],'paths':{},'readOnly':True}
assert out['boot']==m['bootId'];a=m['admission'];count=0
for q in P('/proc').iterdir():
 if not q.name.isdigit():continue
 count+=1;assert count<=512
 try:
  exe=str((q/'exe').resolve(strict=True));cg=(q/'cgroup').read_text().strip();fields=(q/'stat').read_text().rsplit(')',1)[1].split();start=fields[19]
  if any('/'+x+'/' in cg or cg.endswith('/'+x) for x in m['ownedSlices']):continue
  if exe in a['ordinaryOsExecutables']:continue
  if str(q.name)+':'+start+':'+exe in a['existingOtherProcesses']:continue
  raw=(q/'cmdline').read_bytes();argv=[x.decode() for x in raw.split(b'\0') if x]
  row={'pid':int(q.name),'start':start,'exe':exe,'cgroup':cg,'argv0':argv[0] if argv else '', 'argc':len(argv),'cmdlineSha256':hashlib.sha256(raw).hexdigest()}
  if exe in ('/usr/bin/sudo','/usr/bin/systemd-run'):
   row['exactTransportMatch']=argv in m['transportArgv'];row['tailTransportMatch']=any(argv[1:]==v[1:] for v in m['transportArgv']);out['knownTransport'].append(row)
  else:out['unknown'].append(row)
 except FileNotFoundError:continue
for name in ('/run/enclave-rpc-nan-client-n1/state.json','/var/lib/enclave-rpc-nan-client-n1','/srv/enclave-nan-cl-n1','/sys/module/nbd','/root/rpc-nan-client-n1/export.sock'):
 q=P(name);out['paths'][name]={'exists':q.exists()}
 if q.exists():s=q.lstat();out['paths'][name].update({'device':s.st_dev,'inode':s.st_ino,'mode':s.st_mode,'uid':s.st_uid})
for name,args in [('units',['/usr/bin/systemctl','show',*m['ownedUnits'],'--property=Id,LoadState,ActiveState,MainPID,InvocationID,ControlGroup,Description,FragmentPath']),('mounts',['/usr/bin/findmnt','-rn','-o','TARGET,SOURCE,FSTYPE']),('accounts',['/usr/bin/getent','passwd','enclavenancl'])]:
 r=capture(args,6,limit=32768);out[name]=r;assert not r['reason']
print(json.dumps(out))
