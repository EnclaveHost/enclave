#!/usr/bin/env python3
"""Test retirement refusal/recovery against the actual installed Manager HTTP contract."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retire_managed',HERE/'retire_managed.py')
rm=importlib.util.module_from_spec(spec);spec.loader.exec_module(rm)


@unittest.skipUnless(os.environ.get('NATIVE_HANDOFF_INSPECTION') and os.environ.get('NATIVE_HANDOFF_MANAGER'),
                     'set NATIVE_HANDOFF_INSPECTION, NATIVE_HANDOFF_MANAGER and NATIVE_HANDOFF_MANAGER_SHA256')
class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='native-retirement-test-');self.home=Path(self.tmp.name)
        self.inspection=json.loads(Path(os.environ['NATIVE_HANDOFF_INSPECTION']).read_text())
        self.plan=rm.prepare(self.inspection);self.journal=self.home/'journal.json'
        self.proc=None;self.requests=[];self.guards=0

    def tearDown(self):
        if self.proc:
            try:
                if self.proc.poll() is None:
                    try:self.proc.stdin.write('shutdown\n');self.proc.stdin.flush()
                    except OSError:pass
                    try:self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait(timeout=5)
                error=self.proc.stderr.read()
            finally:
                for stream in [self.proc.stdin,self.proc.stdout,self.proc.stderr]:
                    try:stream.close()
                    except OSError:pass
                self.tmp.cleanup()
            self.assertEqual(self.proc.returncode,0,error)
        self.tmp.cleanup()

    def start(self,scenario='normal'):
        plan=self.home/'plan.json';plan.write_text(json.dumps(self.plan))
        self.proc=subprocess.Popen([os.environ.get('NATIVE_HANDOFF_NODE','node'),str(HERE/'qualification/handoff-manager-fixture.mjs'),
            os.environ['NATIVE_HANDOFF_MANAGER'],os.environ['NATIVE_HANDOFF_MANAGER_SHA256'],str(plan),scenario],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        line=self.proc.stdout.readline()
        if not line:raise RuntimeError(self.proc.stderr.read())
        self.port=json.loads(line)['port']

    def guard(self,plan):self.guards+=1;self.assertEqual(plan,self.plan)

    def ids(self):
        self.proc.stdin.write('inventory\n');self.proc.stdin.flush()
        return set(json.loads(self.proc.stdout.readline())['vms'])

    def request(self,method,path):
        self.requests.append((method,path))
        # Explicit fixture-only endpoint; production request() is never called.
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req=urllib.request.Request('http://127.0.0.1:'+str(self.port)+path,method=method)
        try:
            with opener.open(req,timeout=5) as r:return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e:
            code=e.code;e.close();raise RuntimeError('manager HTTP '+str(code)) from None

    def retire(self,**kwargs):
        return rm.retire(self.plan,self.journal,guard=kwargs.get('guard',self.guard),
                         request_fn=kwargs.get('request_fn',self.request),ids_fn=kwargs.get('ids_fn',self.ids))

    def test_exact_app_then_witness_requires_both_confirmations(self):
        self.start();state=self.retire()
        self.assertEqual(state['phase'],'retired');self.assertEqual(state['completed'],self.plan['targets'])
        self.assertEqual(self.ids(),set());self.assertGreaterEqual(self.guards,5)
        self.assertEqual([p for m,p in self.requests if m=='DELETE'],['/vms/'+t['id'] for t in self.plan['targets']])

    def test_manager_epoch_change_refuses_all_removals(self):
        self.start()
        def changed(method,path):
            code,body=self.request(method,path)
            if path=='/health':body['managerEpoch']='f'*32
            return code,body
        with self.assertRaisesRegex(RuntimeError,'epoch'):self.retire(request_fn=changed)
        self.assertFalse(self.journal.exists());self.assertFalse(any(m=='DELETE' for m,p in self.requests))

    def test_replacement_vm_cannot_be_retired_with_old_plan(self):
        self.start()
        def replaced(method,path):
            code,body=self.request(method,path)
            if path=='/vms':body['vms'][0]['launcherVmId']='12345678-1234-1234-1234-123456789abc'
            return code,body
        with self.assertRaisesRegex(RuntimeError,'identity changed'):self.retire(request_fn=replaced)
        self.assertEqual(len(self.ids()),2);self.assertFalse(self.journal.exists())

    def test_new_managed_app_prevents_any_retirement(self):
        self.start()
        def extra(method,path):
            code,body=self.request(method,path)
            if path=='/vms':body['vms'].append(dict(id='unexpected'))
            return code,body
        with self.assertRaisesRegex(RuntimeError,'target set changed'):self.retire(request_fn=extra)
        self.assertFalse(self.journal.exists());self.assertEqual(len(self.ids()),2)

    def test_host_stop_failure_leaves_witness_and_app_present(self):
        self.start('stop-failed')
        with self.assertRaisesRegex(RuntimeError,'HTTP 500'):self.retire()
        state=json.loads(self.journal.read_text());self.assertEqual(state['completed'],[])
        self.assertEqual(state['phase'],'needs-inspection');self.assertEqual(len(self.ids()),2)

    def test_http_success_without_host_absence_does_not_advance(self):
        self.start('host-still-present')
        with self.assertRaisesRegex(RuntimeError,'Hyper-V still contains'):self.retire()
        state=json.loads(self.journal.read_text());self.assertEqual(state['completed'],[])
        self.assertEqual(state['interruptedAtPhase'],'manager-confirmed')
        self.assertEqual(len([1 for m,p in self.requests if m=='DELETE']),1)

    def test_lost_delete_response_keeps_uncertainty_and_refuses_replay(self):
        self.start()
        def lost(method,path):
            result=self.request(method,path)
            if method=='DELETE':raise TimeoutError('fixture lost response after removal')
            return result
        with self.assertRaises(TimeoutError):self.retire(request_fn=lost)
        self.assertEqual(len(self.ids()),1)
        state=json.loads(self.journal.read_text());self.assertEqual(state['completed'],[])
        self.assertEqual(state['interruptedAtPhase'],'requesting')
        before=list(self.requests)
        with self.assertRaisesRegex(ValueError,'journal already exists'):self.retire()
        self.assertEqual(self.requests,before)

    def test_guard_failure_prevents_next_vm_removal(self):
        self.start();calls=0
        def restarted(plan):
            nonlocal calls
            calls+=1
            if calls==4:raise RuntimeError('node unexpectedly running')
        with self.assertRaisesRegex(RuntimeError,'node unexpectedly'):self.retire(guard=restarted)
        self.assertEqual(len(self.ids()),1)
        self.assertEqual(len(json.loads(self.journal.read_text())['completed']),1)

    def test_failed_host_inventory_is_not_absence(self):
        self.start();calls=0
        def failed():
            nonlocal calls
            calls+=1
            if calls==3:raise RuntimeError('host survey failed')
            return self.ids()
        with self.assertRaisesRegex(RuntimeError,'host survey failed'):self.retire(ids_fn=failed)
        self.assertEqual(json.loads(self.journal.read_text())['completed'],[])
        self.assertEqual(len([1 for m,p in self.requests if m=='DELETE']),1)

    def test_unrelated_plan_target_and_unready_capture_refused(self):
        plan=copy.deepcopy(self.plan);plan['targets'][0]['appId']='a'*64
        with self.assertRaisesRegex(ValueError,'reviewed app'):rm.validate_plan(plan)
        inspection=copy.deepcopy(self.inspection);inspection['affectedRecords'][0]['appReady']=False
        with self.assertRaisesRegex(ValueError,'not serving'):rm.prepare(inspection)
        inspection=copy.deepcopy(self.inspection);inspection['baselineMatches']=False
        with self.assertRaisesRegex(ValueError,'baseline'):rm.prepare(inspection)
        inspection=copy.deepcopy(self.inspection);inspection['expectedCodeState']='after'
        with self.assertRaisesRegex(ValueError,'baseline'):rm.prepare(inspection)

    def test_live_guard_refuses_without_stopping_running_production(self):
        # On Linux this checks the platform refusal. On Windows it calls only the
        # read-only production guard, which must refuse the running Node/Update.
        with self.assertRaisesRegex(RuntimeError,'Windows host|already be disabled and stopped'):
            rm.live_guard(self.plan)


if __name__=='__main__':unittest.main(verbosity=2)
