#!/usr/bin/env python3
"""Isolated Windows task + pinned file + manager-removal integration rehearsal.

Runs only disposable fixture runners. Admissions and Hyper-V are simulated;
production task/process/VM inventories are read before and after, never mutated.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import queue
import shutil
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request

HERE=Path(__file__).resolve().parent
PACKAGE=HERE.parent
ROOT=Path(r'C:\Users\claude\kvm-box-combined-v9-1025')
NODE=r'C:\Program Files\Enclave\runtime\node\node.exe'


def module(name):
    spec=importlib.util.spec_from_file_location('combined_'+name,PACKAGE/(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


tx=module('transaction');runner=module('runner_config');retire=module('retire_managed');recovery=module('recover_managed')


def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def save(p,value):tx.atomic_write(p,(json.dumps(value,indent=2)+'\n').encode())


class Rehearsal:
    def __init__(self):
        if os.name!='nt':raise RuntimeError('Windows qualification only')
        if ROOT.exists():raise RuntimeError('new fixture directory required')
        ROOT.mkdir();self.result=dict(schema='native-combined-rehearsal/1',steps=[],success=False,
            productionMutations=False,vmBoundary='simulated',admissionBoundary='fixture records',taskBoundary='real isolated SYSTEM tasks')
        self.pipe=None;self.registered=False;self.ready=None
        self.control=ROOT/'control';self.data=ROOT/'data';self.inputs=PACKAGE/'inputs'
        self.manifestRaw=(PACKAGE/'manifest.json').read_bytes();self.manifest=json.loads(self.manifestRaw)
        self.codePayload=self.inputs/'payload';self.journals=ROOT/'journals';self.journals.mkdir()
        self.phase='before';self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def note(self,name,**data):
        item=dict(name=name,utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**data)
        self.result['steps'].append(item);save(ROOT/'progress.json',self.result)
        print(json.dumps(item),flush=True)

    def setup(self):
        shutil.copytree(self.inputs/'installed',self.control)
        assert all(r['state']=='before' for r in tx.inspect(self.control,self.manifest))
        for source,target in [('combined-manager.mjs','manager-worker.mjs'),('combined-admission.mjs','admission-worker.mjs')]:
            shutil.copyfile(HERE/source,ROOT/target)
        shutil.copyfile(self.inputs/'admission.json',ROOT/'admission.json')
        pin=next(f for f in self.manifest['modified'] if f['path']=='windows/vbslike/manager/server.mjs')
        save(ROOT/'fixture.json',dict(beforeSha256=pin['beforeSha256'],afterSha256=pin['afterSha256'],
            identities=[dict(appId=a,name=n) for a,n in retire.NAMES.items()],
            unrelated=[dict(id=f'ffffffff-0000-0000-0000-{n:012d}',name='unrelated-fixture-'+str(n),candidate=False,identity=None,state='Running') for n in [1,2]]))
        self.data.mkdir();(self.data/'logs').mkdir()
        # Only these isolated runner copies execute. The real agent/main entrypoints
        # are replaced by explicit fixture workers; all production data paths move.
        runner.DATA=PureWindowsPath(str(self.data))
        capture=load(self.inputs/'runners.json');normalizations=[]
        for record in capture['runners']:
            original=base64.b64decode(record['bytes']);assert tx.sha(original)==record['sha256']
            changed=original.replace(b'C:\\ProgramData\\Enclave',str(self.data).encode()).replace(b'C:\\Program Files\\Enclave\\control',str(self.control).encode())
            role='node' if record['name']=='run-node.cmd' else 'manager'
            entry=self.control/('windows/node/agent.mjs' if role=='node' else 'windows/vbslike/manager/main.mjs')
            worker=ROOT/('admission-worker.mjs' if role=='node' else 'manager-worker.mjs')
            assert changed.count(str(entry).encode())==1
            changed=changed.replace(str(entry).encode(),str(worker).encode())
            assert b'C:\\ProgramData\\Enclave' not in changed and b'C:\\Program Files\\Enclave\\control' not in changed
            (self.data/record['name']).write_bytes(changed)
            normalizations.append(dict(name=record['name'],productionSha256=record['sha256'],fixtureSha256=tx.sha(changed)))
            record.update(bytes=base64.b64encode(changed).decode(),sha256=tx.sha(changed))
        clear=b'@echo off\r\n'+b''.join(('set "'+n+'="\r\n').encode() for n in ['ENCLAVE_DESKTOP_CONFIG','ENCLAVE_DESKTOP_CONFIG_SHA256','ENCLAVE_DESKTOP_RELEASE_FILE','ENCLAVE_DESKTOP_RELEASE_SHA256','NODE_VM_RAM_GB'])+b'exit /b 0\r\n'
        pins=[]
        for n in runner.BASE_CONFIGS:
            (self.data/n).write_bytes(clear);pins.append(dict(path=n,sha256=tx.sha(clear),bytes=len(clear)))
        (self.data/'run-update.cmd').write_bytes(b'@echo off\r\nexit /b 0\r\n')
        release=load(self.inputs/'release.json');originalTarget=release['target']
        relative='native-desktop/releases/'+release['imageSha256'];release['target']=str(runner.DATA.joinpath(*relative.split('/')))
        directory=self.data/relative;directory.mkdir(parents=True)
        for name in ['desktop-config.json','desktop-release.json']:shutil.copyfile(self.inputs/name,directory/name)
        environment=(self.inputs/'native-desktop-env.cmd').read_bytes().replace(originalTarget.encode(),release['target'].encode())
        release['environmentSha256']=tx.sha(environment);(directory/'native-desktop-env.cmd').write_bytes(environment)
        self.runnerPrepared=ROOT/'runner-prepared'
        runner.prepare(capture,dict(files=pins),release,environment,self.runnerPrepared)
        self.runnerRaw=(self.runnerPrepared/'manifest.json').read_bytes();self.runnerManifest=json.loads(self.runnerRaw)
        save(ROOT/'runner-normalizations.json',normalizations)
        self.taskErr=(ROOT/'tasks.stderr').open('w')
        self.pipe=subprocess.Popen(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(HERE/'combined-tasks.ps1'),'-Root',str(ROOT)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.taskErr,text=True)
        self.answers=queue.Queue()
        def collect():
            for line in self.pipe.stdout:self.answers.put(line)
            self.answers.put(None)
        threading.Thread(target=collect,daemon=True).start()
        self.result['productionBefore']=self.rpc('production')
        self.rpc('register');self.registered=True
        self.note('fixture-prepared',runtimeFiles=109,runnerNormalizations=normalizations)

    def rpc(self,action,role=None):
        if self.pipe.poll() is not None:raise RuntimeError('task helper exited')
        self.pipe.stdin.write(json.dumps(dict(action=action,role=role))+'\n');self.pipe.stdin.flush()
        line=self.answers.get(timeout=45)
        if not line:raise RuntimeError('task helper ended without response')
        answer=json.loads(line)
        if not answer['ok']:raise RuntimeError(answer['error'])
        return answer['result']

    def probe(self):
        p=self.rpc('probe')
        if len(p['tasks'])!=3 or any(not t['system'] or not t['expectedAction'] or t['actionCount']!=1 for t in p['tasks']):raise RuntimeError('fixture task configuration drift')
        return p

    def wait(self,check):
        until=time.monotonic()+30
        while time.monotonic()<until:
            result=check()
            if result:return result
            time.sleep(.15)
        raise RuntimeError('fixture transition timed out')

    def stopped(self,root):
        if root not in [self.control,self.data]:raise RuntimeError('unexpected transaction destination')
        p=self.probe()
        if p['processes'] or any(t['enabled'] or t['state']=='Running' for t in p['tasks']):raise RuntimeError('fixture services not quiescent')

    def stop(self,role):
        self.rpc('stop',role)
        mapped={'Shield':'manager','Node':'node','Update':'unknown'}[role]
        def gone():
            p=self.probe();t=next(t for t in p['tasks'] if t['name']==role)
            return not t['enabled'] and t['state']!='Running' and not any(x['role']==mapped for x in p['processes'])
        self.wait(gone)

    def start_manager(self,failure=None):
        for name in ['Shield.ready.json','Shield.failed.json','admit.json','admitted.json']:(ROOT/name).unlink(missing_ok=True)
        save(ROOT/'phase.json',dict(failure=failure))
        self.rpc('start','Shield')
        if failure=='manager-start':
            failed=self.wait(lambda:load(ROOT/'Shield.failed.json') if (ROOT/'Shield.failed.json').exists() else None)
            assert failed['injected'] and not (ROOT/'Shield.ready.json').exists()
            p=self.probe();assert not next(t for t in p['tasks'] if t['name']=='Node')['enabled']
            self.note('injected-start-failure-keeps-node-disabled',failure=failed);return
        def ready():
            if not (ROOT/'Shield.ready.json').exists():return None
            r=load(ROOT/'Shield.ready.json');p=self.probe()
            return r if any(x['pid']==r['pid'] and x['role']=='manager' and x['kind']=='node.exe' for x in p['processes']) else None
        self.ready=self.wait(ready)
        h=self.request('GET','/health')[1]
        assert h['canStart'] and h['inventory']['state']=='ready' and h['cpu']['allocatedUnits']==0
        assert self.ready['native']==(self.phase=='after')
        if self.phase=='after':
            assert h['desktop']['ready'] and h['desktop']['allocatedGpuMilli']==0 and h['physicalMemory']['allocatedMiB']==0
            assert h['physicalMemory']['poolMiB']==84992
        self.note('manager-ready-before-admissions',codeState=self.phase,ready=self.ready,health=h)

    def start_node(self):
        (ROOT/'Node.ready.json').unlink(missing_ok=True);self.rpc('start','Node')
        def admitted():
            if not (ROOT/'Node.ready.json').exists() or not (ROOT/'admitted.json').exists():return None
            n=load(ROOT/'Node.ready.json');a=load(ROOT/'admitted.json');p=self.probe()
            if a['epoch']!=self.ready['epoch'] or n['epoch']!=self.ready['epoch']:return None
            return n if any(x['pid']==n['pid'] and x['role']=='node' for x in p['processes']) else None
        n=self.wait(admitted);assert n['started']>=self.ready['started']
        self.note('fixture-admissions-started',node=n,records=self.request('GET','/vms')[1]['vms'])

    def request(self,method,path):
        request=urllib.request.Request('http://127.0.0.1:'+str(self.ready['port'])+path,method=method)
        try:
            with self.opener.open(request,timeout=5) as r:return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e:
            code=e.code;e.close();raise RuntimeError('fixture HTTP '+str(code)) from None

    def host(self):
        snapshot=load(ROOT/'host.json')
        assert snapshot['epoch']==self.ready['epoch'] and snapshot['pid']==self.ready['pid']
        return snapshot['host']

    def inspection(self):
        p=self.probe();h=self.request('GET','/health')[1];listing=self.request('GET','/vms')[1];host=self.host()
        return dict(schema='native-activation-inspection/1',expectedCodeState=self.phase,
            utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
            baselineMatches=all(r['state']==self.phase for r in tx.inspect(self.control,self.manifest)),
            manager=dict(epoch=h['managerEpoch'],listingEpoch=listing['managerEpoch'],inventory=h['inventory']),
            tasks=p['tasks'],processes=[r for r in p['processes'] if r['kind']=='node.exe'],
            affectedRecords=[dict(r,vmId=r.get('launcherVmId')) for r in listing['vms']],ownershipInventory=host,
            vms=[dict(v,managerOwned=v['candidate']) for v in host])

    def owning(self,plan,state):
        p=self.probe();tasks={t['name']:t for t in p['tasks']}
        assert all(not tasks[n]['enabled'] and tasks[n]['state']!='Running' for n in ['Node','Update'])
        assert tasks['Shield']['state']=='Running'
        assert p['processes'] and all(r['role']=='manager' for r in p['processes'])
        managers=[r for r in p['processes'] if r['kind']=='node.exe'];assert len(managers)==1
        assert all(managers[0][k]==v for k,v in plan['managerProcess'].items())
        assert all(r['state']==state for r in tx.inspect(self.control,self.manifest))

    def retire_baseline(self,name):
        inspection=self.inspection();save(ROOT/(name+'-inspection.json'),inspection)
        plan=retire.prepare(inspection)
        self.stop('Update');self.stop('Node')
        result=retire.retire(plan,self.journals/(name+'-retirement.json'),guard=lambda p:self.owning(p,'before'),
                             request_fn=self.request,ids_fn=lambda:{v['id'] for v in self.host()})
        self.note('baseline-instances-retired',cycle=name,result=result)
        self.stop('Shield');self.stopped(self.control)

    def cycle(self,name,failure=None):
        self.retire_baseline(name)
        codeJournal=self.journals/(name+'-code');runnerJournal=self.journals/(name+'-runners')
        tx.apply(self.control,self.codePayload,self.manifestRaw,codeJournal,guard=self.stopped)
        runner.apply(self.data,self.runnerPrepared/'payload',self.runnerRaw,runnerJournal,guard=self.stopped)
        self.phase='after';self.note('code-and-runners-applied',cycle=name,codeJournal=str(codeJournal),runnerJournal=str(runnerJournal))
        self.start_manager(failure)
        if failure!='manager-start':
            self.start_node()
            listing=self.request('GET','/vms')[1]['vms']
            assert len(listing)==2
            if failure=='partial-launch':
                app=next(r for r in listing if r['appId']==retire.APP)
                assert app['status']=='failed' and 'launcherVmId' not in app
                assert self.request('GET','/health')[1]['desktop']['allocatedGpuMilli']==500
            else:assert all(r['appReady'] for r in listing)
            self.stop('Node')
            inspection=self.inspection();save(ROOT/(name+'-recovery-inspection.json'),inspection)
            plan=recovery.prepare(inspection)
            result=recovery.recover(plan,self.journals/(name+'-recovery.json'),guard=lambda p:self.owning(p,'after'),request_fn=self.request,host_fn=self.host)
            self.note('updated-instances-cleared',cycle=name,result=result,health=self.request('GET','/health')[1])
        self.stop('Shield');self.stopped(self.control)
        runner.rollback(self.data,runnerJournal,guard=self.stopped)
        tx.rollback(self.control,codeJournal,guard=self.stopped)
        assert all(r['state']=='before' for r in tx.inspect(self.control,self.manifest))
        assert all(r['state']=='before' for r in runner.tx.inspect(self.data,self.runnerManifest))
        self.phase='before';self.start_manager();self.start_node();self.rpc('enable-update')
        assert all(r['appReady'] for r in self.request('GET','/vms')[1]['vms'])
        self.note('baseline-restored-and-serving-fixture-records',cycle=name)

    def run(self):
        try:
            self.setup();self.start_manager();self.start_node()
            for name,failure in [('healthy-switch',None),('failed-manager-start','manager-start'),('partial-launch','partial-launch')]:self.cycle(name,failure)
            self.retire_baseline('final-cleanup');self.result['success']=True
        except Exception:
            self.result['error']=traceback.format_exc();print(self.result['error'],flush=True)
        finally:
            if self.pipe and self.pipe.poll() is None:
                try:
                    self.result['cleanup']=self.rpc('cleanup')
                    self.result['productionAfter']=self.rpc('production')
                    self.result['productionUnchanged']=all(self.result['productionBefore'][k]==self.result['productionAfter'][k] for k in ['processes','tasks','vms'])
                except Exception:self.result['cleanupError']=traceback.format_exc()
                self.pipe.stdin.close()
                try:self.pipe.wait(timeout=10)
                except subprocess.TimeoutExpired:self.pipe.kill();self.pipe.wait(timeout=5)
                self.pipe.stdout.close();self.taskErr.close()
            save(ROOT/'result.json',self.result)
        clean=self.result.get('cleanup',{}).get('remaining',{})
        if not self.result['success'] or clean.get('processes') or clean.get('tasks') or self.result.get('cleanupError'):raise SystemExit(1)


if __name__=='__main__':Rehearsal().run()
