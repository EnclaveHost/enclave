#!/usr/bin/env python3
"""Retire only the two reviewed manager-owned instances during a stopped-node handoff.

Does not stop tasks, restart services, release leases, apply files or call Remove-VM.
The installed manager must confirm each removal and Hyper-V must confirm absence.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('handoff_transaction',HERE/'transaction.py')
tx=importlib.util.module_from_spec(spec);spec.loader.exec_module(tx)
APP='10c44a8a81b03e43d91411717be2bb0e477014da322a046e635493c7535d0ea6'
WITNESS='a79db30fdf40b37499c8dbf955728c74541fa140201059158694c841736f5030'
NAMES={APP:'0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33',WITNESS:'shield-readiness-v1'}
UUID=r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'


def validate_plan(plan):
    if plan.get('schema')!='native-managed-retirement/1':raise ValueError('wrong retirement plan schema')
    if not re.fullmatch(r'[0-9a-f]{32}',plan['managerEpoch']):raise ValueError('invalid manager epoch')
    targets=plan['targets']
    if len(targets)!=2 or {r['appId'] for r in targets}!={APP,WITNESS}:raise ValueError('expected only the reviewed app and witness')
    for r in targets:
        if (r['name']!=NAMES[r['appId']] or not re.fullmatch(r'hv[0-9a-f]{30,32}',r['id'])
                or not re.fullmatch(UUID,r['vmId'])):raise ValueError('invalid target identity')
    for field in ['id','vmId']:
        if len({r[field] for r in targets})!=2:raise ValueError('duplicate retirement target')
    manager=plan['managerProcess']
    if not isinstance(manager['pid'],int) or manager['pid']<=0 or not manager['creationDate']:
        raise ValueError('invalid manager process identity')
    return plan


def prepare(inspection):
    if (inspection.get('schema')!='native-activation-inspection/1' or inspection.get('expectedCodeState','before')!='before' or not inspection.get('baselineMatches')
            or inspection['manager']['inventory']['state']!='ready'
            or inspection['manager']['inventory']['unattributed']!=0):raise ValueError('unverified installed baseline or inventory')
    tasks={t['name']:t for t in inspection['tasks']}
    if set(tasks)!={'Node','Shield','Update'}:raise ValueError('unexpected production task set')
    for name,t in tasks.items():
        if not (t['system'] and t['expectedAction'] and t['enabled'] and t['actionCount']==1):raise ValueError('unexpected task configuration')
        if name!='Update' and t['state']!='Running':raise ValueError('expected running node and manager')
        if name=='Update' and t['state']=='Running':raise ValueError('updater is running')
    processes=inspection['processes']
    if len(processes)!=2 or {p['role'] for p in processes}!={'node','manager'}:raise ValueError('unexpected installed process set')
    if not all(p['parentIsCmd'] for p in processes):raise ValueError('unexpected service runner')
    manager=next(p for p in processes if p['role']=='manager')
    targets=[]
    for r in inspection['affectedRecords']:
        if r['status']!='running' or r['appReady'] is not True or r.get('recovered'):
            raise ValueError('reviewed app/witness is not serving')
        matches=[v for v in inspection['vms'] if v['id']==r['vmId']]
        if len(matches)!=1 or matches[0]['state']!='Running' or not matches[0]['managerOwned']:
            raise ValueError('manager/Hyper-V identity mismatch')
        targets.append({k:r[k] for k in ['id','vmId','appId','name']})
    # Retire the app first, keeping the readiness witness until its explicit removal.
    targets.sort(key=lambda r:r['appId']!=APP)
    plan=dict(schema='native-managed-retirement/1',capturedUtc=inspection['utc'],
              managerEpoch=inspection['manager']['epoch'],
              managerProcess={k:manager[k] for k in ['pid','creationDate']},targets=targets)
    return validate_plan(plan)


def live_guard(plan):
    if os.name!='nt':raise RuntimeError('live retirement requires the Windows host')
    # Fixed read-only script: no interpolated process arguments or task operations.
    script=r'''$ErrorActionPreference='Stop'
$tasks=@('Node','Shield','Update')|ForEach-Object{$n=$_;$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $n;@{name=$n;enabled=[bool]$t.Settings.Enabled;state=[string]$t.State}}
$program='C:\Program Files\Enclave';$root=Join-Path $program 'control'
$roles=@{node=(Join-Path $root 'windows\node\agent.mjs');manager=(Join-Path $root 'windows\vbslike\manager\main.mjs');updater=(Join-Path $program 'update-host.ps1')}
$found=@()
foreach($p in Get-CimInstance Win32_Process){foreach($role in $roles.Keys){if($p.CommandLine -and $p.CommandLine.IndexOf($roles[$role],[StringComparison]::OrdinalIgnoreCase)-ge 0){$found+=@{role=$role;pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o')}}}}
@{tasks=$tasks;processes=$found}|ConvertTo-Json -Depth 4 -Compress
'''
    r=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],capture_output=True,text=True,check=True,timeout=20)
    state=json.loads(r.stdout);tasks={t['name']:t for t in state['tasks']}
    for name in ['Node','Update']:
        if tasks[name]['enabled'] or tasks[name]['state']=='Running':raise RuntimeError('node and updater must already be disabled and stopped')
    if tasks['Shield']['state']!='Running':raise RuntimeError('original manager must remain running')
    found=state['processes']
    if len(found)!=1 or found[0]['role']!='manager' or any(found[0][k]!=v for k,v in plan['managerProcess'].items()):
        raise RuntimeError('installed process identity changed or admissions still running')


def hyperv_ids():
    if os.name!='nt':raise RuntimeError('live absence check requires the Windows host')
    r=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
        "$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @((Get-VM -ErrorAction Stop)|ForEach-Object{[string]$_.Id}) -Compress"],
        capture_output=True,text=True,check=True,timeout=20)
    ids=json.loads(r.stdout)
    if not isinstance(ids,list) or any(not isinstance(i,str) or not re.fullmatch(UUID,i) for i in ids):
        raise RuntimeError('Hyper-V did not return a complete ID list')
    return set(i.lower() for i in ids)


def request(method,path):
    # No proxy, redirect or caller-selected origin: mutations target the owning local manager.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    req=urllib.request.Request('http://127.0.0.1:8091'+path,method=method)
    try:
        with opener.open(req,timeout=150) as r:
            return r.status,json.loads(r.read(1024*1024))
    except urllib.error.HTTPError as e:
        # Do not print server bodies, which may carry operational details.
        code=e.code;e.close()
        raise RuntimeError('manager HTTP '+str(code)) from None


def observed(plan,remaining,request_fn,ids_fn):
    code,health=request_fn('GET','/health')
    if (code!=200 or health.get('managerEpoch')!=plan['managerEpoch']
            or health.get('inventory',{}).get('state')!='ready'
            or health.get('inventory',{}).get('unattributed')!=0):
        raise RuntimeError('manager epoch or inventory changed')
    code,listing=request_fn('GET','/vms')
    if code!=200 or listing.get('managerEpoch')!=plan['managerEpoch'] or not isinstance(listing.get('vms'),list):
        raise RuntimeError('invalid manager listing')
    targets={r['id']:r for r in remaining}
    rows=listing['vms']
    if len(rows)!=len(targets) or {r.get('id') for r in rows}!=set(targets):raise RuntimeError('manager target set changed')
    for row in rows:
        expected=targets[row['id']]
        actual={k:row.get('launcherVmId' if k=='vmId' else k) for k in expected}
        if actual!=expected or row.get('launching'):raise RuntimeError('manager target identity changed')
    ids=ids_fn()
    if any(r['vmId'].lower() not in ids for r in remaining):raise RuntimeError('expected VM absent before explicit removal')
    return ids


def retire(plan,journal,*,guard=live_guard,request_fn=request,ids_fn=hyperv_ids):
    validate_plan(plan)
    if journal.exists() or journal.is_symlink():raise ValueError('retirement journal already exists; inspect it before recovery')
    guard(plan);observed(plan,plan['targets'],request_fn,ids_fn)
    state=dict(schema='native-managed-retirement-journal/1',plan=plan,completed=[],phase='prepared',
               serviceActions=False,leaseRelease=False)
    def save():tx.atomic_write(journal,(json.dumps(state,indent=2)+'\n').encode())
    tx.path_in(journal.parent,journal.name)
    with journal.open('xb'):pass
    save()
    try:
        for i,target in enumerate(plan['targets']):
            guard(plan);observed(plan,plan['targets'][i:],request_fn,ids_fn)
            state.update(phase='requesting',requested=target['id']);save()
            code,body=request_fn('DELETE','/vms/'+target['id'])
            if code!=200 or body.get('ok') is not True:raise RuntimeError('manager did not explicitly confirm removal')
            state.update(phase='manager-confirmed');save()
            guard(plan)
            ids=observed(plan,plan['targets'][i+1:],request_fn,ids_fn)
            if any(t['vmId'].lower() in ids for t in [*state['completed'],target]):
                raise RuntimeError('Hyper-V still contains a removed VM')
            state['completed'].append(target);state.update(phase='removing');save()
        state.update(phase='retired');save();return state
    except Exception:
        # The requested VM may have been removed even when a response was lost.
        # Preserve uncertainty; never treat timeout/404 as removal or auto-retry.
        state['interruptedAtPhase']=state['phase'];state['phase']='needs-inspection';save()
        raise


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['prepare','retire'])
    p.add_argument('--inspection',type=Path);p.add_argument('--plan',type=Path,required=True)
    p.add_argument('--journal',type=Path)
    a=p.parse_args()
    if a.action=='prepare':
        if not a.inspection:p.error('--inspection is required')
        plan=prepare(json.loads(a.inspection.read_text()))
        with a.plan.open('x') as out:json.dump(plan,out,indent=2);out.write('\n')
        result={'planSha256':hashlib.sha256(a.plan.read_bytes()).hexdigest(),'targets':len(plan['targets']),'productionMutations':False}
    else:
        if not a.journal:p.error('--journal is required')
        result=retire(json.loads(a.plan.read_text()),a.journal)
    print(json.dumps(result))


if __name__=='__main__':main()
