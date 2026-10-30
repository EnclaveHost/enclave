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
import json,hashlib,re,shlex,stat
q=Path('/proc/1281392');raw=(q/'stat').read_text();assert raw.rsplit(')',1)[1].split()[19]=='867080689';assert str((q/'exe').resolve())=='/usr/bin/bash';assert str((q/'cwd').resolve())=='/root/padspill-20261005'
a=(q/'cmdline').read_bytes();assert len(a)<=16384
args=a.rstrip(b'\0').decode().split('\0');out={'at':time.time(),'pid':1281392,'start':'867080689','cmdlineSha256':hashlib.sha256(a).hexdigest(),'argc':len(args),'arguments':[],'scripts':[]}
base=Path('/root/padspill-20261005')
for i,x in enumerate(args):
 if i==0 or x in ('-c','-lc','-l','-x','-e','-u'):out['arguments'].append({'index':i,'literal':x});continue
 path=Path(x) if x.startswith('/') else base/x
 isfile=False
 try:isfile=path.is_file() and path.resolve().is_relative_to(base) and path.suffix in ('.sh','.py')
 except OSError:pass
 if isfile:
  b=path.read_bytes();assert len(b)<=65536;st=path.stat();out['arguments'].append({'index':i,'scriptPath':str(path.resolve()),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
  source=b.decode()
 else:
  out['arguments'].append({'index':i,'bytes':len(x.encode()),'sha256':hashlib.sha256(x.encode()).hexdigest()});source=x if i and args[i-1] in ('-c','-lc') else ''
 if source:
  # Structure and fixed numeric resource settings only, no command strings, data, credentials or environment values.
  commands=re.findall(r'(?:^|[;|&\n])\s*(?:while\s+|do\s+|then\s+|exec\s+|sudo\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s+)*([A-Za-z0-9_./-]+)',source)
  numbers=re.findall(r'(?:sleep|timeout|--max-size|--max-memory|--buffer-size|--transfers|--checkers|--bwlimit|--mib|count=|bs=)\s*[= ]?\s*([0-9]+(?:[KMGTP]i?B?|[smhd])?)',source)
  out['scripts'].append({'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'commands':[Path(x).name for x in commands],'numericResourceLiterals':numbers,'loop':bool(re.search(r'\b(?:while|for|until)\b',source)),'networkToolTokens':[x for x in ('rclone','curl','wget','rsync','ssh','scp','python','node','qemu','docker','systemd-run') if re.search(r'\b'+re.escape(x)+r'\b',source)]})
files=[]
for x in base.iterdir():
 assert len(files)<128
 if x.suffix in ('.sh','.py'):
  st=x.lstat();files.append({'name':x.name,'bytes':st.st_size,'regular':stat.S_ISREG(st.st_mode)})
out['sourceFilenames']=files
fds=[]
for fd in (q/'fd').iterdir():
 assert len(fds)<128
 try:
  target=str(fd.resolve(strict=True))
  if target.startswith(str(base)) and target.endswith(('.sh','.py')):fds.append({'fd':fd.name,'sourcePath':target})
 except FileNotFoundError:pass
out['scriptFds']=fds;assert (q/'stat').read_text().rsplit(')',1)[1].split()[19]=='867080689'
print(json.dumps(out,sort_keys=True))
