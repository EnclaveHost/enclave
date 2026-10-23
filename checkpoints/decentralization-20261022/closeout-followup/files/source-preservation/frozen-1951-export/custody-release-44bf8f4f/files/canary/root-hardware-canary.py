#!/usr/bin/env python3
"""One disposable, quote-only SNP guest; never a production activation.

Root allocation: 5120 MiB, both shared queue lanes exclusively, 16 GiB reserve.
The guest gets no registry or submitter key, committee, genesis or existing state.
"""
import datetime, fcntl, hashlib, json, os, pathlib, shutil, signal, subprocess, sys, time, urllib.request

BASE = pathlib.Path(__file__).resolve().parents[2]
CANARY = pathlib.Path(__file__).resolve().parent
RUN = CANARY / 'root-hardware-20261023'
DIST = CANARY.parent / 'out/A-custodian'
REPO = CANARY.parent / 'repo'
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(name, value):
    with (RUN / name).open('x') as f: json.dump(value, f, indent=2)
def available():
    return next(int(l.split()[1]) // 1024 for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
def qemus():
    out = {}
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if not (p/'comm').read_text().startswith('qemu'): continue
            st = (p/'stat').read_text(); out[p.name] = st[st.rfind(')')+2:].split()[19]
        except (OSError, IndexError): pass
    return out
def child():
    def interrupted(signum, frame): raise KeyboardInterrupt('canary interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    before = qemus(); save('protected-before.json', before)
    state = RUN / 'state'
    state.mkdir(mode=0o700)
    cfg = dict(dist=str(DIST), ovmf='/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd',
               sevDevice='/dev/sev', cpus=2, memMiB=3072, tunnelName='custody-release-canary',
               endpoint='https://custody-release-canary.invalid', registryEndpoint='https://custody-release-canary.invalid',
               hostPort=18970, mgmtPort=18971, stateDir=str(state), genesis=False,
               vault='0xe48699b8401564aace7a814ae4569b67a3f7eef5', rpc='https://mainnet.base.org',
               submitterKeyEnv='ENCLAVE_QUOTE_ONLY_NO_KEY')
    save('config.json', cfg)
    # A strict allowlist environment prevents accidental ambient signer/Node injection.
    env = dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8')
    result = dict(startedAt=now(), quoteOnly=True, noRegistryKey=True, noSubmitterKey=True,
                  noCommittee=True, genesis=False, productionActivated=False)
    process = None
    try:
        with (RUN/'serial.log').open('x') as log:
            process = subprocess.Popen(['node', str(REPO/'custody/v2/host.mjs'), str(RUN/'config.json')],
                                       env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            save('launcher.json', dict(pid=process.pid, startedAt=now()))
            deadline = time.monotonic()+240
            info = None
            while time.monotonic() < deadline:
                if process.poll() is not None: raise RuntimeError('host launcher exited: '+str(process.returncode))
                try:
                    with urllib.request.urlopen('http://127.0.0.1:18971/v2/custody/info', timeout=2) as r:
                        if r.status == 200: info=json.load(r); break
                except Exception: pass
                time.sleep(2)
            if info is None: raise RuntimeError('guest evidence service did not become ready within 240 seconds')
            save('guest-info.json', info)
            with (RUN/'verify.log').open('x') as log:
                verified = subprocess.run(['node', str(CANARY/'verify-custodian-quote.mjs'), '--manifest', str(DIST/'manifest.json'),
                    '--source', str(REPO), '--url', 'http://127.0.0.1:18971', '--out', str(RUN/'verdict.json')],
                    env=env, stdout=log, stderr=subprocess.STDOUT, timeout=65)
            result['verifierExit']=verified.returncode
            if (RUN/'verdict.json').exists(): result['verdict']=json.loads((RUN/'verdict.json').read_text())
            result['ok']=verified.returncode==0 and result.get('verdict',{}).get('ok') is True
    except Exception as e:
        result.update(ok=False, error=str(e))
    finally:
        if process is not None:
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=3)
            # A successful host exit is not sufficient to prove its guest exited.
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        after=qemus(); save('protected-after.json',after)
        result['protectedQemuIdentitiesUnchanged']=before==after
        result['finishedAt']=now()
        # Only this run's fresh sealed identity and fw_cfg are disposable.
        shutil.rmtree(state)
        result['freshStateRemoved']=not state.exists()
        save('result.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='verdict'},indent=2),flush=True)
    return 0 if result.get('ok') and result['protectedQemuIdentitiesUnchanged'] else 1

def main():
    if sys.argv[1:]==['--child']: return child()
    locks=[]
    for name in ['claude-test-queue.lock','claude-test-small-queue.lock']:
        f=(BASE/name).open('a+')
        try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print('NOT STARTED: shared test lane busy',flush=True); return 98
        locks.append(f)
    if available()<16384+5120+1024:
        print('NOT STARTED: reserve unavailable',flush=True); return 98
    RUN.mkdir(mode=0o700) # Never silently repeat a prior attempt.
    pre=subprocess.run(['bash',str(CANARY/'headroom-check.sh'),str(DIST),'3072','18970','18971',str(RUN)],capture_output=True,text=True)
    (RUN/'preflight.log').write_text(pre.stdout+pre.stderr)
    if pre.returncode: return pre.returncode
    paths=[DIST/'manifest.json',DIST/'vmlinuz',DIST/'initramfs.cpio.gz',DIST/'cmdline',REPO/'custody/v2/host.mjs',CANARY/'verify-custodian-quote.mjs',pathlib.Path(__file__),
           pathlib.Path('/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd')]
    save('attempt.json',dict(at=now(),memoryCapMiB=5120,reserveMiB=16384,exclusiveBothQueueLanes=True,
        hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}))
    cmd=['systemd-run','--user','--scope','--quiet','--unit=enclave-custody-quote-canary-20261023',
         '-p','MemoryMax=5120M','-p','MemorySwapMax=0','node',str(BASE/'enclave/test/helpers/memory-guard.mjs'),
         '--max-rss-mib','5120','--floor-available-mib','16384','--log',str(RUN/'memory.log'),'--',
         'timeout','--signal=TERM','--kill-after=20s','330s','python3',str(pathlib.Path(__file__).resolve()),'--child']
    with (RUN/'execution.log').open('x') as out:
        p=subprocess.Popen(cmd,stdout=out,stderr=subprocess.STDOUT)
        code=p.wait()
    # The scope's cgroup holds every process this run started (host launcher, QEMU, verifier), whatever its session:
    # stop it (kills any survivor; a no-op when empty), then prove no QEMU of THIS run's state dir remains.
    stop=subprocess.run(['systemctl','--user','stop','enclave-custody-quote-canary-20261023.scope'],capture_output=True,text=True,timeout=30)
    survivors=[]
    for d in pathlib.Path('/proc').iterdir():
        if not d.name.isdigit(): continue
        try: cl=(d/'cmdline').read_bytes().replace(b'\0',b' ').decode('utf8','replace')
        except OSError: continue
        if str(RUN) in cl and d.name!=str(os.getpid()): survivors.append(d.name)
    if survivors and code==0: code=1
    save('terminal.json',dict(at=now(),exitCode=code,scopeStop=stop.returncode,survivors=survivors))
    print('CANARY TERMINAL',code,str(RUN),flush=True)
    return code
if __name__=='__main__': sys.exit(main())
