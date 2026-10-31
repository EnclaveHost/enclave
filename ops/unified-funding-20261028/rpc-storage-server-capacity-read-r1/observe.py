"""ONE bounded local-only metadata observation. No native admission or launch."""
from pathlib import Path
import hashlib, json, os, stat, time

HERE=Path(__file__).resolve().parent
MAX_BYTES=1048576

def bounded(path, limit=8192):
    with Path(path).open('rb') as f: data=f.read(limit+1)
    assert len(data)<=limit, 'metadata-byte-limit'
    return data.decode('utf-8','strict')

def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def memory():
    wanted={'MemTotal','MemAvailable','SwapTotal','SwapFree'}
    rows={line.split(':')[0]:int(line.split()[1])*1024 for line in bounded('/proc/meminfo').splitlines() if line.split(':')[0] in wanted}
    assert set(rows)==wanted
    return rows

def file_metadata(path):
    p=Path(path);s=p.lstat()
    return {'path':str(p),'resolved':str(p.resolve(strict=True)),'device':s.st_dev,'inode':s.st_ino,
            'bytes':s.st_size,'allocatedBytes':s.st_blocks*512,'mode':s.st_mode,'uid':s.st_uid,
            'gid':s.st_gid,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns,'links':s.st_nlink,
            'regular':stat.S_ISREG(s.st_mode),'symlink':stat.S_ISLNK(s.st_mode),
            'readable':os.access(p,os.R_OK),'writable':os.access(p,os.W_OK)}

def processes():
    rows=[];errors=[];groups=set();until=time.monotonic()+6
    with os.scandir('/proc') as entries:
        for entry in entries:
            if not entry.name.isdigit():continue
            assert len(rows)+len(errors)<8192 and time.monotonic()<until, 'process-census-bound'
            p=Path(entry.path)
            try:
                a=bounded(p/'stat',4096).rsplit(')',1)[1].split()
                status=dict(line.split(':',1) for line in bounded(p/'status',16384).splitlines() if ':' in line)
                cg=bounded(p/'cgroup',4096).strip();assert cg.startswith('0::/') and '\n' not in cg
                exe=str((p/'exe').resolve(strict=True))
                b=bounded(p/'stat',4096).rsplit(')',1)[1].split();assert a[19]==b[19], 'process-reused'
                groups.add(cg[3:])
                rows.append({'pid':int(entry.name),'startTicks':int(a[19]),'ppid':int(a[1]),
                             'uid':int(status['Uid'].split()[0]),'executable':exe,'cgroup':cg[3:],
                             'rssBytes':int(status.get('VmRSS','0 kB').split()[0])*1024})
            except FileNotFoundError:continue
            except Exception as e:errors.append({'pid':int(entry.name),'unavailable':type(e).__name__})
    budgets=[]
    for name in sorted(groups):
        assert len(budgets)<512, 'cgroup-count-bound'
        row={'path':name}
        try:
            p=Path('/sys/fs/cgroup'+name);s=p.stat();row['identity']=[s.st_dev,s.st_ino]
            for key in ('memory.current','memory.max','memory.swap.max','pids.current','cpu.max'):
                row[key]=bounded(p/key,4096).strip()
            current=int(row['memory.current']);maximum=row['memory.max']
            row['remainingCapGrowthBytes']=max(0,int(maximum)-current) if maximum.isdigit() else None
            t=p.stat();assert (t.st_dev,t.st_ino)==(s.st_dev,s.st_ino), 'cgroup-replaced'
        except Exception as e:row['unavailable']=type(e).__name__
        budgets.append(row)
    return {'processes':rows,'cgroups':budgets,'unavailable':errors,
            'cgroupGrowthMustNotBeSummedWithGuestdPending':True,'ordinaryOSAndOtherGrowthNeedsRootClassification':True}

def storage(cfg):
    lines=bounded('/proc/self/mountinfo',262144).splitlines();out=[]
    for image in cfg['images']:
        row={'role':image['role']}
        try:
            p=Path(image['path']);row['file']=file_metadata(p)
            resolved=str(p.resolve(strict=True));matching=[]
            for line in lines:
                cols=line.split();sep=cols.index('-');target=cols[4]
                if resolved==target or resolved.startswith(target.rstrip('/')+'/'):
                    matching.append({'target':target,'majorMinor':cols[2],'options':cols[5],
                                     'fstype':cols[sep+1],'source':cols[sep+2]})
            mount=max(matching,key=lambda x:len(x['target']));row['mount']=mount
            v=os.statvfs(p.parent);row['availableBytes']=v.f_bavail*v.f_frsize
            row['floorBytes']=cfg['storageHeadroomBytes'];row['aboveFloor']=row['availableBytes']>=row['floorBytes']
            # Follow only the selected block device's sysfs topology, never disk content.
            pending=[Path('/sys/dev/block')/mount['majorMinor']];seen=set();devices=[]
            while pending:
                q=pending.pop().resolve(strict=True)
                if str(q) in seen:continue
                seen.add(str(q));assert len(seen)<=16, 'block-topology-bound'
                device={'sysfs':str(q)}
                for key in ('dev','size','queue/rotational','queue/logical_block_size','device/model'):
                    f=q/key
                    if f.exists():device[key]=bounded(f,256).strip()
                children=q/'slaves'
                if children.exists():
                    with os.scandir(children) as entries:
                        for e in entries:
                            pending.append(Path(e.path));assert len(pending)<=16
                if (q/'partition').exists():pending.append(q.parent)
                devices.append(device)
            row['devices']=devices
        except Exception as e:row['unavailable']=type(e).__name__
        out.append(row)
    capabilities={}
    for name in ('/dev/kvm','/dev/loop-control','/dev/nbd0','/dev/nbd7'):
        capabilities[name]={'exists':Path(name).exists(),'readWriteAccess':os.access(name,os.R_OK|os.W_OK)}
    devices=[]
    for number in range(16):
        q=Path('/sys/block')/('nbd'+str(number))
        if not q.exists():continue
        row={'device':q.name}
        try:
            row['sectors']=int(bounded(q/'size',64));row['pid']=bounded(q/'pid',64).strip() if (q/'pid').exists() else None
            row['holders']=[]
            with os.scandir(q/'holders') as entries:
                for e in entries:
                    row['holders'].append(e.name);assert len(row['holders'])<=16
        except Exception as e:row['unavailable']=type(e).__name__
        devices.append(row)
    manifests=[]
    for name in cfg['metadataPaths']:
        item={'path':name}
        try:
            m=json.loads(bounded(name,262144))
            item['disks']={role:{k:v for k,v in value.items() if k in ('path','bytes','backing','serial')}
                           for role,value in m['disks'].items()}
            item['backings']={role:{k:v for k,v in value.items() if k in ('mount','source','fstype','guestRotationRate','kind','floorBytes')}
                              for role,value in m.get('backings',{}).items()}
            item['sourceHash']=sha(name)
        except Exception as e:item['unavailable']=type(e).__name__
        manifests.append(item)
    tools={name:{'exists':Path(name).is_file(),'executable':os.access(name,os.X_OK)}
           for name in ('/usr/bin/qemu-system-x86_64','/usr/sbin/qemu-nbd','/usr/bin/qemu-img','/usr/sbin/qemu-img','/usr/bin/mount')}
    return {'images':out,'devicePermissions':capabilities,'nbdMetadata':devices,'installedManifestSummary':manifests,'tools':tools,
            'attachmentExecuted':False,'exclusiveUseProven':False,'originalContentsRead':False}

def main():
    os.umask(0o077)
    pins=json.loads((HERE/'PREPARED-PINS.json').read_text())
    assert all(sha(HERE/name)==value for name,value in pins.items()), 'preparation-drift'
    cfg=json.loads((HERE/'CONFIG.json').read_text())
    assert sha(cfg['installedControlClient'])==cfg['installedControlClientSha256'], 'installed-control-client-drift'
    for row in json.loads((HERE/'HOST-TOOL-PINS.json').read_text()):
        q=Path(row['path']);assert str(q.resolve())==row['resolved'] and q.stat().st_size==row['bytes'] and sha(q)==row['sha256'], 'host-tool-drift'
    for row in cfg['installedGuestdUnitFiles']:
        assert sha(row['path'])==row['sha256'], 'guestd-installed-unit-drift'
    assert sha(cfg['installedGuestdExecutable'])==cfg['installedGuestdExecutableSha256'], 'guestd-binary-drift'
    assert os.sched_getaffinity(0)=={1}, 'CPU-affinity'
    before=memory();assert before['MemAvailable']>=cfg['hostFloorMiB']<<20, 'host-floor'
    g={};exec(compile((HERE/'capture-local.py').read_text(),'qualified-capture','exec'),g)
    def command(argv,seconds,limit=65536):
        value=g['capture'](argv,seconds,limit=limit)
        assert value['rc']==0 and not value['reason'] and not value['truncated'], 'bounded-command-failed'
        return value['stdout']
    props='Id,MainPID,InvocationID,ActiveState,SubState,ControlGroup,MemoryCurrent,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TasksCurrent,FragmentPath,DropInPaths'
    def units():
        return command(['/usr/bin/systemctl','--user','show','enclave-guestd.service','enclave-rpc-production-vm.service','enclave-rpc-production-guard.service','--property='+props],3)
    out={'at':time.time(),'bootId':bounded('/proc/sys/kernel/random/boot_id',64).strip(),
         'readOnly':True,'nativeAdmitted':False,'beforeMemory':before,'unitBefore':units()}
    with (HERE/'ATTEMPT.json').open('x') as f:json.dump({'at':out['at'],'localReadOnly':True,'nativeAdmitted':False},f)
    out['guestd']=json.loads(command(['/usr/bin/node',str(HERE/'guestd-read.mjs')],20,262144))
    assert out['guestd']['ok'] and out['guestd']['authenticated'], 'authoritative-status-unavailable'
    out['baseline']=processes();out['storage']=storage(cfg)
    out['jobs']=command(['/usr/bin/systemctl','--user','list-jobs','--no-legend','--no-pager'],3)
    out['timers']=command(['/usr/bin/systemctl','--user','list-timers','--all','--no-legend','--no-pager'],3)
    out['systemJobs']=command(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager'],3)
    out['unitAfter']=units();out['afterMemory']=memory()
    def guestd_unit(raw):
        records=[dict(line.split('=',1) for line in block.splitlines() if '=' in line) for block in raw.strip().split('\n\n')]
        rows=[r for r in records if r.get('Id')=='enclave-guestd.service'];assert len(rows)==1
        return rows[0]
    a=guestd_unit(out['unitBefore']);b=guestd_unit(out['unitAfter'])
    assert all(a[k]==b[k] for k in ('MainPID','InvocationID','ControlGroup')), 'guestd-incarnation-changed'
    assert b['ActiveState']=='active' and int(b['MainPID'])>0, 'guestd-not-active'
    identity=next(r for r in out['baseline']['processes'] if r['pid']==int(b['MainPID']))
    assert identity['executable']==cfg['installedGuestdExecutable'] and identity['cgroup']==b['ControlGroup'], 'guestd-process-binding'
    out['guestd']['installedProcessIdentity']=identity
    out['pressure']={name:bounded('/proc/pressure/'+name,4096) for name in ('memory','io','cpu')}
    # /proc/locks only describes locks. Do not acquire queue, image or application locks.
    out['queueLockFiles']=[file_metadata(Path('/home/steven/Documents/Codex/2026-10-18/wo/work')/name)
                          for name in ('claude-test-queue.lock','claude-test-small-queue.lock')]
    out['kernelLocks']=bounded('/proc/locks',65536)
    available=min(out['beforeMemory']['MemAvailable'],out['afterMemory']['MemAvailable'],out['guestd']['memAvailableLowerMiB']<<20)
    pending=out['guestd']['pendingUpperMiB'];out['conditionalScenarios']=[]
    for native in cfg['futureClientMiB']:
        planned=native+cfg['futureAttachMiB']+cfg['futureGuardianMiB']+cfg['futureToolingMiB']+cfg['futureOuterMiB']
        out['conditionalScenarios'].append({'clientMiB':native,'nativePlusToolingMiB':planned,
            'guestdPendingMiB':pending,'activeNanCoordinatorConservativeMiB':cfg['knownActiveNanCoordinatorReserveMiB'],
            'knownResidualMiB':available//(1<<20)-pending-planned-cfg['knownActiveNanCoordinatorReserveMiB'],
            'requiredFloorMiB':cfg['hostFloorMiB'],'otherExistingRemainingGrowthMiB':None,
            'pendingSchedulesAndQueuedWorkMiB':None,'admitted':False})
    out['limitations']=['No active Nan client inspection or remote calls.',
        'Guestd pool snapshots are authoritative authenticated observations, not reservations for this trial.',
        'Unbounded or unreadable process/cgroup growth, schedules and queued work require root classification.',
        'Do not double count guestd reservation growth in cgroup sums.',
        'Nan coordinator reserve stays640MiB until terminal and cleanup proof; no new native trial concurrently.',
        'Device permissions and topology establish candidate feasibility, not exclusive attachment or data integrity.']
    assert out['afterMemory']['MemAvailable']>=cfg['hostFloorMiB']<<20, 'host-floor-after'
    assert all(sha(HERE/name)==value for name,value in pins.items()), 'preparation-drift-after'
    raw=json.dumps(out,indent=2)+'\n';assert len(raw.encode())<=MAX_BYTES, 'evidence-output-bound'
    with (HERE/'RESULT.json').open('x') as f:f.write(raw)
    print(json.dumps({'localReadCompleted':True,'nativeAdmitted':False,'resultBytes':len(raw.encode()),
                      'guestdReservationsStable':out['guestd']['reservationsStable']}))

if __name__=='__main__':main()
