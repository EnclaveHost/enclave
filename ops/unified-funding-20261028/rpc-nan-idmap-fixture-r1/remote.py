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

TOOLPINS={'/usr/bin/mount': {'realpath': '/usr/bin/mount', 'bytes': 51584, 'sha256': 'fde2b1540ca79ea42df942653bdfd09b9b3e3ff1d4713602bd280f754033957a'}, '/usr/bin/umount': {'realpath': '/usr/bin/umount', 'bytes': 39296, 'sha256': '186774a008ad69cf60bce6af35a850608d1c6ba410d3eca4113ea55b3a8b54d6'}, '/usr/bin/findmnt': {'realpath': '/usr/bin/findmnt', 'bytes': 69280, 'sha256': '08652d0a79159c9d5b73f9181d3436bf044466e8efffecd0feef5c4cbb4e7670'}, '/usr/bin/unshare': {'realpath': '/usr/bin/unshare', 'bytes': 43624, 'sha256': 'a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c'}, '/usr/bin/setpriv': {'realpath': '/usr/bin/setpriv', 'bytes': 39304, 'sha256': '62ec0120791f3afcfb689fed52384ec2b0accc6e118a6b9a1d6fcfa7450aaf37'}, '/usr/sbin/mkfs.ext4': {'realpath': '/usr/sbin/mke2fs', 'bytes': 133752, 'sha256': '07cd24ce58a410cc9cee93c55ae5ac95986df016c5907dc7a49b55389bd41ed2'}, '/usr/sbin/losetup': {'realpath': '/usr/sbin/losetup', 'bytes': 76304, 'sha256': '44ccbcc5573aee3bd40fd3171ec368d62ba373f45263ac1d026c612ed86f0f02'}, '/usr/lib/x86_64-linux-gnu/libmount.so.1': {'realpath': '/usr/lib/x86_64-linux-gnu/libmount.so.1.1.0', 'bytes': 309960, 'sha256': '7472255ae5799059b37ddd544788f5665dbd3e1cb78259f52180293039efc2a5'}}

from pathlib import Path
import json,hashlib,stat,sys
P=Path;ROOT=P('/var/lib/enclave-rpc-nan-idmap-fixture-r1');IMAGE=ROOT/'synthetic.ext4';MOUNT=ROOT/'mount';cleaning=False;created=False
out={'fixtureOnly':True,'errors':[],'commands':{},'ok':False,'mountNamespace':os.readlink('/proc/self/ns/mnt')}
def guard():
 if cleaning:return
 assert P('/proc/sys/kernel/random/boot_id').read_text().strip()=='4b84b9bd-a89d-4b37-94cb-26334dbf4666'
 available=next(int(l.split()[1]) for l in P('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
 assert available>=6400*1024,'remote-memory-floor'
 assert os.statvfs('/var/lib').f_bavail*os.statvfs('/var/lib').f_frsize>=8<<30,'remote-disk-floor'
CAPTURE_GUARD=guard
def cmd(name,args,seconds=8,allowed=(0,)):
 r=capture(args,seconds,limit=16384);out['commands'][name]=r;assert r['rc'] in allowed and not r['reason'] and not r['truncated'],name
 return r['stdout'].strip()
def mounted():
 return [l for l in P('/proc/self/mountinfo').read_text().splitlines() if l.split()[4]==str(MOUNT)]
def unmount(label):
 if mounted():cmd(label,['/usr/bin/umount',str(MOUNT)],8)
 assert not mounted()
def check_seed(mapped):
 st=(MOUNT/'cl/seed').stat();assert (st.st_uid,st.st_gid)==((50011,50011) if mapped else (995,986)),'ownership-direction'
 assert (MOUNT/'cl/seed').read_bytes()==b'synthetic-idmap-fixture\n','content-changed'
 out['mappedSeed' if mapped else 'plainSeed']={'uid':st.st_uid,'gid':st.st_gid,'sha256':hashlib.sha256((MOUNT/'cl/seed').read_bytes()).hexdigest()}
try:
 os.umask(0o077);guard();assert os.geteuid()==0
 assert out['mountNamespace']!=os.readlink('/proc/1/ns/mnt'),'private-mount-namespace-required'
 cg=P('/proc/self/cgroup').read_text().strip();assert cg.endswith('/enclave-rpc-nan-idmap-fixture-r1.service')
 control=P('/sys/fs/cgroup'+cg[3:]);assert (control/'memory.max').read_text().strip()==str(128<<20) and (control/'memory.swap.max').read_text().strip()=='0'
 for name,row in TOOLPINS.items():
  q=P(name);assert str(q.resolve(strict=True))==row['realpath'] and q.stat().st_size==row['bytes'] and hashlib.sha256(q.read_bytes()).hexdigest()==row['sha256'],'tool-drift'
 assert not ROOT.exists();ROOT.mkdir(mode=0o700);created=True;rootIdentity=(ROOT.stat().st_dev,ROOT.stat().st_ino);MOUNT.mkdir(mode=0o700)
 with IMAGE.open('xb') as f:f.truncate(64<<20);f.flush();os.fsync(f.fileno())
 st=IMAGE.stat();out['imageIdentity']={'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size}
 cmd('mkfs',['/usr/sbin/mkfs.ext4','-q','-F','-E','lazy_itable_init=0,lazy_journal_init=0',str(IMAGE)],15)
 cmd('plainMount',['/usr/bin/mount','-t','ext4','-o','loop,nosuid,nodev,noexec,nosymfollow',str(IMAGE),str(MOUNT)],10)
 rows=mounted();assert len(rows)==1;out['plainMount']=rows[0]
 (MOUNT/'cl').mkdir(mode=0o750);os.chown(MOUNT/'cl',995,986)
 with (MOUNT/'cl/seed').open('xb') as f:f.write(b'synthetic-idmap-fixture\n');f.flush();os.fsync(f.fileno())
 os.chown(MOUNT/'cl/seed',995,986);(MOUNT/'cl/seed').chmod(0o640);check_seed(False)
 (MOUNT/'root-only').write_bytes(b'fixture-root');(MOUNT/'root-only').chmod(0o600)
 (MOUNT/'cl/link').symlink_to('/etc/hostname')
 unmount('plainUnmount')
 cmd('idmapMount',['/usr/bin/mount','-t','ext4','-o','loop,nosuid,nodev,noexec,nosymfollow,X-mount.idmap=u:995:50011:1 g:986:50011:1',str(IMAGE),str(MOUNT)],10)
 rows=mounted();assert len(rows)==1;out['idmapMount']=rows[0];check_seed(True)
 assert {'nosuid','nodev','noexec','nosymfollow'}.issubset(set(rows[0].split()[5].split(','))),'idmap-flags'
 assert (MOUNT/'root-only').stat().st_uid!=50011,'root-mapped-to-client'
 os.chown(ROOT,0,50011);ROOT.chmod(0o710)
 code="from pathlib import Path;import os,sys;p=Path(sys.argv[1]);assert (p/'seed').read_bytes()==b'synthetic-idmap-fixture\\n';f=(p/'created').open('xb');f.write(b'owned-by-mapped-user\\n');f.flush();os.fsync(f.fileno());f.close()"
 # Pass real newline escapes to the child source; no shell substitution.
 code=code.replace('\\\\n','\\n')
 cmd('mappedWrite',['/usr/bin/setpriv','--reuid=50011','--regid=50011','--clear-groups','--no-new-privs','/usr/bin/python3','-B','-c',code,str(MOUNT/'cl')],8)
 denied="from pathlib import Path;import sys\ntry:Path(sys.argv[1]).read_bytes()\nexcept PermissionError:sys.exit(0)\nraise SystemExit(9)"
 cmd('oldHostIdentityDenied',['/usr/bin/setpriv','--reuid=995','--regid=986','--clear-groups','--no-new-privs','/usr/bin/python3','-B','-c',denied,str(MOUNT/'cl/seed')],8)
 refused="from pathlib import Path;import sys,errno\nfor name in sys.argv[1:]:\n try:Path(name).read_bytes()\n except OSError as e:assert e.errno in (errno.EACCES,errno.ELOOP)\n else:raise SystemExit(9)"
 cmd('unmappedRootAndSymlinkDenied',['/usr/bin/setpriv','--reuid=50011','--regid=50011','--clear-groups','--no-new-privs','/usr/bin/python3','-B','-c',refused,str(MOUNT/'root-only'),str(MOUNT/'cl/link')],8)
 ROOT.chmod(0o700);unmount('idmapUnmount')
 cmd('plainReopen',['/usr/bin/mount','-t','ext4','-o','loop,ro,noload,nosuid,nodev,noexec,nosymfollow',str(IMAGE),str(MOUNT)],10)
 check_seed(False);st=(MOUNT/'cl/created').stat();assert (st.st_uid,st.st_gid)==(995,986);assert (MOUNT/'cl/created').read_bytes()==b'owned-by-mapped-user\n'
 out['newFileDiskOwner']=[st.st_uid,st.st_gid];out['ok']=True
except Exception as e:out['errors'].append(type(e).__name__+':'+str(e)[:180])
finally:
 cleaning=True
 if created:
  assert (ROOT.stat().st_dev,ROOT.stat().st_ino)==rootIdentity,'fixture-root-drift'
  ROOT.chmod(0o700)
  try:unmount('finalUnmount')
  except Exception as e:out['errors'].append('cleanup:'+type(e).__name__+':'+str(e)[:180])
  out['remainingMounts']=mounted()
  if IMAGE.exists():
   try:out['remainingLoop']=cmd('loopCheck',['/usr/sbin/losetup','-j',str(IMAGE)],5);assert not out['remainingLoop']
   except Exception as e:out['errors'].append('loop-cleanup:'+type(e).__name__)
print(json.dumps(out));sys.exit(0 if out['ok'] and not out['errors'] else 2)
