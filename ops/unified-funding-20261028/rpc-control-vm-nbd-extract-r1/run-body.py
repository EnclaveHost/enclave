from pathlib import Path
import json, hashlib, base64, sys
P=Path(__file__).resolve().parent
def sha(p):
    with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def write(n,v):
    with (P/n).open('x') as f:
        os.fchmod(f.fileno(),0o600);json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def verify():
    for n,h in json.loads((P/'PINS.json').read_text()).items():
        assert sha(P/n)==h, 'package drift: '+n
    for row in json.loads((P/'EXTERNAL-PINS.json').read_text()):
        q=Path(row['path']);assert str(q.resolve())==row['realpath'] and q.stat().st_size==row['bytes'] and sha(q)==row['sha256'], 'external drift'
def main():
    os.umask(0o077)
    assert os.sched_getaffinity(0)=={1}
    verify()
    admit=json.loads((P/'ROOT-ADMISSION.json').read_text())
    assert admit['authorized'] is True and admit['scope']=='private-control-vm-nbd-extract-r1' and admit['pinsSha256']==sha(P/'PINS.json')
    assert 0<=time.time()-admit['at']<=300
    cg=Path('/proc/self/cgroup').read_text().strip();assert cg.startswith('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-') and cg.endswith('.scope')
    c=Path('/sys/fs/cgroup'+cg[3:]);assert (c/'memory.max').read_text().strip()==str(256<<20) and (c/'memory.swap.max').read_text().strip()=='0'
    available=next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
    assert available>=27648*1024
    write('ATTEMPT.json',{'at':time.time(),'readOnly':False,'scope':cg,'pinsSha256':sha(P/'PINS.json'),'noRetry':True})
    results={};error=None
    try:
        common=['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5',
                '-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2']
        args=[*common,'-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc',
              '-oHostKeyAlias=[127.0.0.1]:32423',
              '-oUserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts',
              'controladmin@172.17.28.159','/usr/bin/timeout -k 2s 80s /usr/bin/python3 -B -']
        script=(P/'extract-remote.py').read_bytes();assert len(script)<=32768
        results['linux']=capture(args,86,stdin=script,limit=1048576)
        write('LINUX-RESULT.json',results['linux'])
    except Exception as e:
        error=type(e).__name__
    integrity=False
    try:verify();integrity=True
    except Exception as e:error=error or type(e).__name__
    ok=integrity and not error and len(results)==1 and all(r['rc']==0 and not r['reason'] and not r['truncated'] for r in results.values())
    value={'status':'PRIVATE_TOOL_PREPARED_NOT_ATTACHED' if ok else 'EXTRACTION_INCOMPLETE_NO_RETRY',
           'at':time.time(),'error':error,'results':results,'inputsUnchanged':integrity,
           'productionChanged':False,'capacityAdmitted':False,'allocationChanged':False,
           'clientsStarted':False,'remoteDeathProvenOnTimeout':False}
    write('RESULT.json',value)
    print(json.dumps({'status':value['status'],'inputsUnchanged':integrity,'capacityAdmitted':False,'resultPath':str(P/'RESULT.json')}))
    return 0 if ok else 2
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:
        print(json.dumps({'status':'REFUSED_BEFORE_READ','error':type(e).__name__}));sys.exit(2)
