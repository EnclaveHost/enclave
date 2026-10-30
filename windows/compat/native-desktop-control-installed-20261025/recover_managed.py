#!/usr/bin/env python3
"""Clear only reviewed app/witness records before rolling back a failed activation.

No task control, broad VM deletion, lease release or source/configuration writes.
Requires stopped admissions, the updated code pins and the still-owning manager.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retire_managed',HERE/'retire_managed.py')
rm=importlib.util.module_from_spec(spec);spec.loader.exec_module(rm)


def identity(row):return {k:row.get(k) for k in ['id','name','appId','instanceId']}


def valid_identity(row):
    return (row.get('appId') in rm.NAMES and row.get('name')==rm.NAMES[row['appId']]
            and isinstance(row.get('id'),str) and re.fullmatch(r'hv[0-9a-f]{30,32}',row['id'])
            and isinstance(row.get('instanceId'),str) and re.fullmatch(r'[A-Za-z0-9-]{1,96}',row['instanceId']))


def bind_inventory(rows,host):
    if not isinstance(host,list) or len({v['id'].lower() for v in host})!=len(host):raise ValueError('invalid host inventory')
    if any(not re.fullmatch(rm.UUID,v['id']) or type(v.get('candidate')) is not bool for v in host):
        raise ValueError('invalid host VM record')
    targets=[];bound=set()
    for row in rows:
        if not valid_identity(row) or row.get('launching') is not False or row.get('recovered') or row.get('status') not in ['starting','running','failed']:
            raise ValueError('unreviewed, launching or recovered manager record')
        named=[v for v in host if v['candidate'] and v.get('identity',{} ) and v['identity'].get('id')==row['id']]
        if len(named)>1 or any(identity(v['identity'])!=identity(row) for v in named):raise ValueError('ambiguous host ownership')
        reported=row.get('launcherVmId')
        if reported is not None and not re.fullmatch(rm.UUID,reported):raise ValueError('invalid reported VM ID')
        if named:
            vm=named[0];vmid=vm['id'].lower()
            if reported is not None and reported.lower()!=vmid:raise ValueError('reported and owned VM IDs differ')
            bound.add(vmid)
        else:
            vmid=reported.lower() if reported is not None else None
            if vmid is not None and any(v['id'].lower()==vmid for v in host):raise ValueError('reported VM has unverified ownership')
        targets.append(dict(**identity(row),reportedVmId=reported,vmId=vmid,vmPresent=bool(named)))
    if len(rows)>2 or len({r['appId'] for r in rows})!=len(rows) or len({r['id'] for r in rows})!=len(rows):
        raise ValueError('unexpected or duplicate managed targets')
    if any(v['candidate'] and v['id'].lower() not in bound for v in host):raise ValueError('unattributed or unreviewed host VM')
    # Preserve only IDs of unrelated VMs; their Notes are never inspected/exported.
    return targets,sorted(v['id'].lower() for v in host if not v['candidate'])


def validate_plan(plan):
    if plan.get('schema')!='native-managed-recovery/1' or not re.fullmatch(r'[0-9a-f]{32}',plan['managerEpoch']):
        raise ValueError('invalid recovery plan')
    targets=plan['targets']
    if len(targets)>2 or len({t['appId'] for t in targets})!=len(targets) or len({t['id'] for t in targets})!=len(targets):
        raise ValueError('duplicate or unexpected recovery targets')
    for t in targets:
        if not valid_identity(t) or type(t.get('vmPresent')) is not bool:raise ValueError('invalid recovery target')
        for key in ['vmId','reportedVmId']:
            if t[key] is not None and not re.fullmatch(rm.UUID,t[key]):raise ValueError('invalid recovery VM ID')
        if t['vmPresent'] and t['vmId'] is None:raise ValueError('present target lacks VM ID')
        if t['reportedVmId'] is not None and (t['vmId'] is None or t['reportedVmId'].lower()!=t['vmId'].lower()):
            raise ValueError('inconsistent reported and owned VM IDs')
        if not t['vmPresent'] and t['reportedVmId'] is None and t['vmId'] is not None:
            raise ValueError('absent target has an unexplained VM ID')
    ids=[t['vmId'].lower() for t in targets if t['vmId'] is not None]
    if len(set(ids))!=len(ids):raise ValueError('duplicate VM IDs')
    unrelated=plan['unrelatedVmIds']
    if len(set(unrelated))!=len(unrelated) or any(not re.fullmatch(rm.UUID,i) for i in unrelated) or set(ids)&set(unrelated):
        raise ValueError('invalid unrelated VM set')
    process=plan['managerProcess']
    if not isinstance(process['pid'],int) or process['pid']<=0 or not process['creationDate']:raise ValueError('invalid manager process')
    return plan


def prepare(inspection):
    m=inspection['manager']
    if (inspection.get('schema')!='native-activation-inspection/1' or inspection.get('expectedCodeState')!='after'
            or inspection.get('baselineMatches') is not True or m['inventory']['state']!='ready'
            or m['inventory']['unattributed']!=0 or m['listingEpoch']!=m['epoch']):raise ValueError('updated code and consistent inventory required')
    tasks={t['name']:t for t in inspection['tasks']}
    if set(tasks)!={'Node','Shield','Update'} or any(not t['system'] or not t['expectedAction'] or t['actionCount']!=1 for t in tasks.values()):
        raise ValueError('unexpected service tasks')
    if any(tasks[n]['enabled'] or tasks[n]['state']=='Running' for n in ['Node','Update']) or tasks['Shield']['state']!='Running':
        raise ValueError('stop admissions and updater; keep owning manager running')
    procs=inspection['processes']
    if len(procs)!=1 or procs[0]['role']!='manager' or not procs[0]['parentIsCmd']:raise ValueError('unexpected live processes')
    rows=[dict(r,launcherVmId=r.get('vmId')) for r in inspection['affectedRecords']]
    targets,unrelated=bind_inventory(rows,inspection['ownershipInventory'])
    targets.sort(key=lambda t:t['appId']!=rm.APP)
    return validate_plan(dict(schema='native-managed-recovery/1',capturedUtc=inspection['utc'],managerEpoch=m['epoch'],
        managerProcess={k:procs[0][k] for k in ['pid','creationDate']},targets=targets,unrelatedVmIds=unrelated))


def live_guard(plan):
    rm.live_guard(plan)
    root=Path(os.environ.get('ProgramFiles',r'C:\Program Files'))/'Enclave/control'
    manifest=json.loads((HERE/'manifest.json').read_text())
    if any(e['state']!='after' for e in rm.tx.inspect(root,manifest)):raise RuntimeError('updated control code drift')


def host_inventory():
    if os.name!='nt':raise RuntimeError('live recovery requires Windows')
    r=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(HERE/'inspect-managed-inventory.ps1')],
                     capture_output=True,text=True,check=True,timeout=20)
    return json.loads(r.stdout)


def observed(plan,remaining,request_fn,host_fn):
    code,health=request_fn('GET','/health')
    if (code!=200 or health.get('managerEpoch')!=plan['managerEpoch'] or health.get('inventory',{}).get('state')!='ready'
            or health.get('inventory',{}).get('unattributed')!=0):raise RuntimeError('owning manager or inventory changed')
    code,listing=request_fn('GET','/vms')
    if code!=200 or listing.get('managerEpoch')!=plan['managerEpoch'] or not isinstance(listing.get('vms'),list):
        raise RuntimeError('invalid manager listing')
    targets,unrelated=bind_inventory(listing['vms'],host_fn())
    if sorted(targets,key=lambda t:t['id'])!=sorted(remaining,key=lambda t:t['id']) or unrelated!=plan['unrelatedVmIds']:
        raise RuntimeError('recovery target or unrelated host inventory changed')
    if not remaining and (health.get('cpu',{}).get('allocatedUnits')!=0
            or health.get('physicalMemory',{}).get('allocatedMiB')!=0
            or health.get('desktop',{}).get('allocatedGpuMilli')!=0):raise RuntimeError('manager has unreleased reservations')


def recover(plan,journal,*,guard=live_guard,request_fn=rm.request,host_fn=host_inventory):
    validate_plan(plan)
    if journal.exists() or journal.is_symlink():raise ValueError('recovery journal exists; inspect uncertainty before retrying')
    guard(plan);observed(plan,plan['targets'],request_fn,host_fn)
    state=dict(schema='native-managed-recovery-journal/1',plan=plan,phase='prepared',completed=[],serviceActions=False,leaseRelease=False)
    def save():rm.tx.atomic_write(journal,(json.dumps(state,indent=2)+'\n').encode())
    rm.tx.path_in(journal.parent,journal.name)
    with journal.open('xb'):pass
    save()
    try:
        for i,target in enumerate(plan['targets']):
            guard(plan);observed(plan,plan['targets'][i:],request_fn,host_fn)
            state.update(phase='requesting',requested=target['id']);save()
            code,body=request_fn('DELETE','/vms/'+target['id'])
            if code!=200 or body.get('ok') is not True:raise RuntimeError('manager did not confirm recovery removal')
            state.update(phase='manager-confirmed');save()
            guard(plan);observed(plan,plan['targets'][i+1:],request_fn,host_fn)
            state['completed'].append(target);state.update(phase='removing');save()
        guard(plan);observed(plan,[],request_fn,host_fn)
        state['phase']='cleared';save();return state
    except Exception:
        state['interruptedAtPhase']=state['phase'];state['phase']='needs-inspection';save();raise


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','recover']);p.add_argument('--plan',type=Path,required=True)
    p.add_argument('--inspection',type=Path);p.add_argument('--journal',type=Path)
    a=p.parse_args()
    if a.action=='prepare':
        if not a.inspection:p.error('--inspection is required')
        plan=prepare(json.loads(a.inspection.read_text(encoding='utf-8-sig')))
        with a.plan.open('x') as f:json.dump(plan,f,indent=2);f.write('\n')
        result=dict(targets=len(plan['targets']),productionMutations=False)
    else:
        if not a.journal:p.error('--journal is required')
        result=recover(json.loads(a.plan.read_text(encoding='utf-8-sig')),a.journal)
    print(json.dumps(result))


if __name__=='__main__':main()
