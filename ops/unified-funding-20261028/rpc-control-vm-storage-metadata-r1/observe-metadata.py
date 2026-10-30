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

# PREPARED ONLY. Appended after the previously reviewed bounded capture helper.
import json, pathlib, platform, re, resource, shutil, hashlib, sys
from urllib.parse import urlsplit, urlunsplit
P = pathlib.Path
resource.setrlimit(resource.RLIMIT_AS, (384 << 20, 384 << 20))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
deadline = time.monotonic() + 32
out = {'readOnly': True, 'installAdmitted': False, 'errors': []}
def read(p, limit=65536):
    with open(p, 'rb') as f: b=f.read(limit+1)
    if len(b)>limit: raise ValueError('input-size-limit')
    return b.decode('utf-8', 'replace')
def public_uri(m):
    try:
        u=urlsplit(m.group(0)); host=u.hostname or ''
        if u.port: host+=':'+str(u.port)
        return urlunsplit((u.scheme,host,u.path,'',''))
    except Exception: return '[redacted-uri]'
def sanitize(s):
    return re.sub(r'(?:https?|ftp)://[^\s<>]+',public_uri,s)
def command(name, argv, seconds=4, limit=262144, allow_nonzero=False):
    remaining=deadline-time.monotonic()
    if remaining<=0: raise TimeoutError('metadata-deadline')
    r=capture(argv,min(seconds,remaining),limit=limit)
    r['stdout']=sanitize(r['stdout']);r['stderr']=sanitize(r['stderr'])
    out[name]=r
    if r['reason'] or (r['rc'] and not allow_nonzero): out['errors'].append('incomplete:'+name)
    return r
try:
    out['identity']={'hostname':platform.node(),'kernel':platform.release(),
                     'bootId':read('/proc/sys/kernel/random/boot_id').strip()}
    assert out['identity']['hostname']=='enclave-control'
    assert out['identity']['bootId']=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
    available=next(int(l.split()[1]) for l in read('/proc/meminfo').splitlines() if l.startswith('MemAvailable:'))
    assert available>=5632*1024
    out['memAvailableKiB']=available
    out['osRelease']={}
    for line in read('/etc/os-release').splitlines():
        k,sep,v=line.partition('=')
        if sep and k in ('ID','VERSION_ID','VERSION_CODENAME','UBUNTU_CODENAME'): out['osRelease'][k]=v.strip('"')
    command('architecture',['/usr/bin/dpkg','--print-architecture'])
    # No auth.conf, private keys, process environment, or unrestricted apt configuration dump.
    paths=[P('/etc/apt/sources.list')]+sorted(P('/etc/apt/sources.list.d').glob('*.sources'))+sorted(P('/etc/apt/sources.list.d').glob('*.list'))
    assert len(paths)<=24
    out['sources']=[]
    for p in paths:
        if not p.is_file(): continue
        raw=read(p); lines=[]
        for line in raw.splitlines():
            s=line.strip()
            if s.startswith(('deb ','deb-src ')) or re.match(r'^(Types|URIs|Suites|Components|Signed-By|Enabled|Trusted|Check-Valid-Until):',s): lines.append(sanitize(s))
        out['sources'].append({'path':str(p),'sha256':hashlib.sha256(raw.encode()).hexdigest(),'fields':lines})
    # Empty pkgcache paths prevent apt-cache from rebuilding on-disk caches.
    opts=['-o','Dir::Cache::pkgcache=','-o','Dir::Cache::srcpkgcache=']
    command('candidatePolicy',['/usr/bin/apt-cache',*opts,'policy','nbd-client'])
    deps=command('dependencies',['/usr/bin/apt-cache',*opts,'depends','--recurse','--no-recommends','--no-suggests','--no-conflicts','--no-breaks','--no-replaces','--no-enhances','nbd-client'],5,65536)
    packages={'nbd-client'}
    if deps['rc']==0 and not deps['reason']:
        for line in deps['stdout'].splitlines():
            if re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?',line): packages.add(line)
    assert len(packages)<=32
    out['packageNames']=sorted(packages)
    command('candidateRecords',['/usr/bin/apt-cache',*opts,'show','--no-all-versions',*sorted(packages)],5)
    command('installedVersions',['/usr/bin/dpkg-query','-W','-f=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n',*sorted(packages)],3,65536,True)
    command('simulatedInstall',['/usr/bin/apt-get',*opts,'-s','-o','Debug::NoLocking=1','--no-install-recommends','--no-upgrade','install','nbd-client'],5,131072)
    command('indexTargets',['/usr/bin/apt-get',*opts,'indextargets','--format','$(IDENTIFIER)\t$(ORIGIN)\t$(SUITE)\t$(CODENAME)\t$(ARCHITECTURE)\t$(TRUSTED)\t$(FILENAME)\t$(URI)'],3,65536)
    out['releaseFiles']=[]
    files=sorted(P('/var/lib/apt/lists').glob('*InRelease'))+sorted(P('/var/lib/apt/lists').glob('*_Release'))+sorted(P('/var/lib/apt/lists').glob('*_Release.gpg'))
    assert len(files)<=24
    for p in files:
        assert time.monotonic()<deadline
        st=p.stat(); assert st.st_size<=4<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['releaseFiles'].append({'path':str(p),'bytes':st.st_size,'mtimeNs':st.st_mtime_ns,'sha256':h})
    out['tools']={}
    for n in ('dpkg-deb','gpgv','readelf','ldconfig','mke2fs','e2fsck','blkid','modprobe','nbd-client','timeout','python3','ssh'):
        found=shutil.which(n)
        if not found: out['tools'][n]=None;continue
        p=P(found).resolve(); st=p.stat()
        assert st.st_size<=32<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['tools'][n]={'path':found,'realpath':str(p),'bytes':st.st_size,'sha256':h}
    out['ubuntuArchiveKeyring']=None
    p=P('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
    if p.is_file():
        assert p.stat().st_size<=1<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['ubuntuArchiveKeyring']={'path':str(p),'bytes':p.stat().st_size,'sha256':h}
except Exception as e:
    out['errors'].append(type(e).__name__)
out['complete']=not out['errors']
out['signatureChainVerified']=False
out['runtimeDependenciesVerified']=False
out['note']='Cached metadata only; no apt update, download, install, export, mount, or client start. Nonzero dpkg-query is retained for missing packages. No admission or fresh signature verification.'
print(json.dumps(out,sort_keys=True))
sys.exit(0 if out['complete'] else 2)
