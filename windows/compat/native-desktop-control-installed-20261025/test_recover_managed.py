#!/usr/bin/env python3
"""Recovery behavior against staged Manager HTTP with simulated host inventory."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('recover_managed',HERE/'recover_managed.py')
rc=importlib.util.module_from_spec(spec);spec.loader.exec_module(rc)


def fixture():
    records=[];host=[]
    for n,app in enumerate([rc.rm.APP,rc.rm.WITNESS],1):
        vmid=f'{n:08x}-0000-0000-0000-000000000001'
        row=dict(id='hv'+str(n)*32,name=rc.rm.NAMES[app],appId=app,instanceId='fixture-'+str(n),
                 launcherVmId=vmid,status='failed',launching=False,recovered=False,
                 physicalMemoryMiB=4096,cpu=dict(grantedUnits=1000),gpuMilli=250,handle=dict(vmId=vmid))
        records.append(row)
        host.append(dict(id=vmid,name='enclave-app-fixture-'+str(n),state='Running',candidate=True,identity=rc.identity(row)))
    host.append(dict(id='ffffffff-0000-0000-0000-000000000001',name='unrelated',state='Running',candidate=False,identity=None))
    return dict(epoch='e'*32,records=records,host=host)


def inspection(data):
    return dict(schema='native-activation-inspection/1',expectedCodeState='after',baselineMatches=True,utc='fixture',
        manager=dict(epoch=data['epoch'],listingEpoch=data['epoch'],inventory=dict(state='ready',unattributed=0)),
        tasks=[dict(name=n,state='Running' if n=='Shield' else 'Disabled',enabled=n=='Shield',system=True,
                    expectedAction=True,actionCount=1) for n in ['Node','Shield','Update']],
        processes=[dict(role='manager',pid=123,creationDate='fixture',parentIsCmd=True)],
        affectedRecords=[dict(r,vmId=r.get('launcherVmId')) for r in data['records']],ownershipInventory=data['host'])


class PlanTests(unittest.TestCase):
    def test_cli_reads_windows_utf8_bom_inspection(self):
        with tempfile.TemporaryDirectory(prefix='recovery-plan-test-') as tmp:
            path=Path(tmp);source=path/'inspection.json';plan=path/'plan.json'
            source.write_text(json.dumps(inspection(fixture())),encoding='utf-8-sig')
            result=subprocess.run([sys.executable,str(HERE/'recover_managed.py'),'prepare','--inspection',str(source),'--plan',str(plan)],
                                  capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(len(json.loads(plan.read_text())['targets']),2)

    def test_requires_after_pins_stopped_admissions_and_consistent_epoch(self):
        for change in [lambda x:x.update(expectedCodeState='before'),lambda x:x.update(baselineMatches=False),
                       lambda x:x['manager'].update(listingEpoch='f'*32),lambda x:x['tasks'][0].update(enabled=True),
                       lambda x:x['processes'].append(dict(role='node'))]:
            with self.subTest(change=change):
                i=inspection(fixture());change(i)
                with self.assertRaises(ValueError):rc.prepare(i)

    def test_launching_recovered_unknown_and_duplicate_records_refused(self):
        for change in [lambda d:d['records'][0].update(launching=True),lambda d:d['records'][0].update(recovered=True),
                       lambda d:d['records'][0].update(appId='a'*64),lambda d:d['records'].append(d['records'][0]),
                       lambda d:d['records'][0].update(instanceId=None),lambda d:d['records'][0].update(instanceId=123)]:
            with self.subTest(change=change):
                d=fixture();change(d)
                with self.assertRaises(ValueError):rc.prepare(inspection(d))

    def test_ambiguous_or_unattributed_host_ownership_refused(self):
        for change in [lambda d:d['host'][0].update(identity=None),
                       lambda d:d['host'][0]['identity'].update(instanceId='different'),
                       lambda d:d['host'].append(dict(d['host'][0],id='dddddddd-0000-0000-0000-000000000001')),
                       lambda d:d['host'][0].update(candidate=False),
                       lambda d:d['records'][0].update(launcherVmId=d['host'][2]['id'])]:
            with self.subTest(change=change):
                d=fixture();change(d)
                with self.assertRaises(ValueError):rc.prepare(inspection(d))

    def test_windows_guard_refuses_running_production_without_mutation(self):
        with self.assertRaisesRegex(RuntimeError,'Windows host|already be disabled and stopped'):
            rc.live_guard(rc.prepare(inspection(fixture())))


@unittest.skipUnless(os.environ.get('NATIVE_RECOVERY_MANAGER') and os.environ.get('NATIVE_RECOVERY_ADMISSION'),
                     'set NATIVE_RECOVERY_MANAGER, NATIVE_RECOVERY_MANAGER_SHA256 and NATIVE_RECOVERY_ADMISSION')
class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='native-recovery-test-');self.home=Path(self.tmp.name)
        self.data=fixture();self.proc=None;self.requests=[];self.journal=self.home/'journal.json'

    def tearDown(self):
        if self.proc:
            if self.proc.poll() is None:
                try:self.proc.stdin.write('shutdown\n');self.proc.stdin.flush()
                except OSError:pass
                try:self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait(timeout=5)
            error=self.proc.stderr.read()
            for stream in [self.proc.stdin,self.proc.stdout,self.proc.stderr]:stream.close()
            self.tmp.cleanup();self.assertEqual(self.proc.returncode,0,error)
        else:self.tmp.cleanup()

    def start(self,scenario='normal'):
        self.plan=rc.prepare(inspection(self.data))
        path=self.home/'fixture.json';path.write_text(json.dumps(self.data))
        self.proc=subprocess.Popen([os.environ.get('NATIVE_RECOVERY_NODE','node'),str(HERE/'qualification/recovery-manager-fixture.mjs'),
            os.environ['NATIVE_RECOVERY_MANAGER'],os.environ['NATIVE_RECOVERY_MANAGER_SHA256'],str(path),
            os.environ['NATIVE_RECOVERY_ADMISSION'],scenario],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        line=self.proc.stdout.readline()
        if not line:raise RuntimeError(self.proc.stderr.read())
        self.port=json.loads(line)['port']

    def host(self):
        self.proc.stdin.write('inventory\n');self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())['host']

    def request(self,method,path):
        self.requests.append((method,path))
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req=urllib.request.Request('http://127.0.0.1:'+str(self.port)+path,method=method)
        try:
            with opener.open(req,timeout=5) as r:return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e:
            code=e.code;e.close();raise RuntimeError('manager HTTP '+str(code)) from None

    def recover(self,**kw):
        return rc.recover(self.plan,self.journal,guard=kw.get('guard',lambda p:None),
                          request_fn=kw.get('request_fn',self.request),host_fn=kw.get('host_fn',self.host))

    def assert_cleared(self):
        state=self.recover();self.assertEqual(state['phase'],'cleared')
        self.assertEqual(state['completed'],self.plan['targets'])
        self.assertEqual([v['id'] for v in self.host()],self.plan['unrelatedVmIds'])
        h=self.request('GET','/health')[1]
        self.assertEqual((h['cpu']['allocatedUnits'],h['physicalMemory']['allocatedMiB'],h['desktop']['allocatedGpuMilli']),(0,0,0))

    def test_two_failed_records_release_all_reservations(self):
        self.start();self.assert_cleared()
        self.assertEqual([p for m,p in self.requests if m=='DELETE'],['/vms/'+t['id'] for t in self.plan['targets']])

    def test_private_vm_handle_without_public_vm_id(self):
        del self.data['records'][0]['launcherVmId'];self.start();self.assert_cleared()

    def test_missing_handle_uses_actual_manager_ownership_survey(self):
        self.data['records'][0]['handle']=None;del self.data['records'][0]['launcherVmId']
        self.start();self.assert_cleared()

    def test_already_absent_vm_with_reported_id(self):
        self.data['host'].pop(0);self.start();self.assert_cleared()

    def test_no_vm_created_and_null_handle(self):
        self.data['host'].pop(0);self.data['records'][0]['handle']=None;del self.data['records'][0]['launcherVmId']
        self.start();self.assert_cleared()

    def test_only_witness_or_no_records(self):
        self.data['records']=self.data['records'][1:];self.data['host']=self.data['host'][1:]
        self.start();self.assert_cleared()

    def test_empty_inventory_is_checked_without_delete(self):
        self.data['records']=[];self.data['host']=self.data['host'][2:]
        self.start();self.assert_cleared();self.assertFalse(any(m=='DELETE' for m,p in self.requests))

    def test_stop_failure_preserves_records_and_reservations(self):
        self.start('stop-failed')
        with self.assertRaisesRegex(RuntimeError,'HTTP 500'):self.recover()
        self.assertEqual(len(self.request('GET','/vms')[1]['vms']),2)
        self.assertEqual(self.request('GET','/health')[1]['desktop']['allocatedGpuMilli'],500)
        self.assertEqual(json.loads(self.journal.read_text())['phase'],'needs-inspection')

    def test_success_without_host_absence_refuses_next_removal(self):
        self.start('host-still-present')
        with self.assertRaisesRegex(ValueError,'unattributed or unreviewed'):self.recover()
        self.assertEqual(len([1 for m,p in self.requests if m=='DELETE']),1)
        self.assertEqual(json.loads(self.journal.read_text())['interruptedAtPhase'],'manager-confirmed')

    def test_cleanup_failure_after_host_removal_retains_record(self):
        self.start('removed-then-failed')
        with self.assertRaisesRegex(RuntimeError,'HTTP 500'):self.recover()
        self.assertEqual(len(self.host()),2);self.assertEqual(len(self.request('GET','/vms')[1]['vms']),2)
        self.assertEqual(json.loads(self.journal.read_text())['completed'],[])

    def test_lost_response_preserves_uncertainty_and_refuses_replay(self):
        self.start()
        def lost(method,path):
            result=self.request(method,path)
            if method=='DELETE':raise TimeoutError('response lost')
            return result
        with self.assertRaises(TimeoutError):self.recover(request_fn=lost)
        self.assertEqual(json.loads(self.journal.read_text())['interruptedAtPhase'],'requesting')
        before=list(self.requests)
        with self.assertRaisesRegex(ValueError,'journal exists'):self.recover()
        self.assertEqual(self.requests,before)

    def test_changed_epoch_prevents_mutation(self):
        self.start()
        def changed(method,path):
            code,b=self.request(method,path)
            if path=='/health':b['managerEpoch']='f'*32
            return code,b
        with self.assertRaisesRegex(RuntimeError,'owning manager'):self.recover(request_fn=changed)
        self.assertFalse(self.journal.exists());self.assertFalse(any(m=='DELETE' for m,p in self.requests))

    def test_unrelated_vm_change_prevents_mutation(self):
        self.start()
        def changed():return [v for v in self.host() if v['candidate']]
        with self.assertRaisesRegex(RuntimeError,'unrelated host inventory changed'):self.recover(host_fn=changed)
        self.assertFalse(self.journal.exists())

    def test_guard_failure_after_first_removal_stops_recovery(self):
        self.start();calls=0
        def guard(p):
            nonlocal calls
            calls+=1
            if calls==3:raise RuntimeError('admissions restarted')
        with self.assertRaisesRegex(RuntimeError,'admissions restarted'):self.recover(guard=guard)
        self.assertEqual(len([1 for m,p in self.requests if m=='DELETE']),1)

    def test_nonzero_final_reservations_refuse_completion(self):
        self.data['records']=[];self.data['host']=self.data['host'][2:];self.start()
        def held(method,path):
            code,b=self.request(method,path)
            if path=='/health':b['desktop']['allocatedGpuMilli']=250
            return code,b
        with self.assertRaisesRegex(RuntimeError,'unreleased reservations'):self.recover(request_fn=held)
        self.assertFalse(self.journal.exists())


if __name__=='__main__':unittest.main(verbosity=2)
