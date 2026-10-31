"""Actual owner producers/senders/journals; SSH, PID1 and guest replies mocked.

No guest/source installation, native work, network or production data access.
"""
import base64
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import shlex
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


x = load('guest_workflow', 'rpc/run_guest_workflow.py')
f = load('protocol_fixture', 'test/rpc-server/test_storage_protocol.py')
p = x.p


class Tests(unittest.TestCase):
    def setUp(self):
        os.umask(0o077)
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['RPC_TEST_ROOT'])
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.journal = self.root / 'journal'
        self.journal.mkdir(mode=0o700)
        server, ready, credential, _ = f.fixture()
        self.server = p.decode(server)
        self.server['startupClock'] = {'path': '/original-owner/clock.json', 'sha256': 'c'*64}
        server = x.c.encode(self.server)
        ready = p.decode(ready)
        ready['contractSha256'] = p.sha(server)
        self.attempt = self.server['attempt']
        self.vm = 'ef'*16
        self.boot = f.BOOT
        self.owner_boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        self.process = {'unit': 'enclave-rpc-storage-activation.service', 'invocation': '34'*16,
                        'pid': 42, 'start': '1234', 'cgroup': '/fixture-owner'}
        key = b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + bytes(32)
        seed = {'instance': self.server['instance'], 'readbackVerified': True, 'seedContainsPrivateCredentials': True,
                'credentialPublic': {'attempt': self.attempt, 'sshHostPublicKey': 'ssh-ed25519 ' + base64.b64encode(key).decode(),
                    'sshHostFingerprint': 'SHA256:' + base64.b64encode(bytes.fromhex(p.sha(key))).decode().rstrip('=')}, 'records': {}}
        required = dict(x.prepare_runtime.runtime.required_pins())
        required.update(x.guest.FILES)
        required.update(x.delivery.FILES)
        for module in (x.launch, x.runtime):
            required.update({'/opt/enclave-rpc/' + n: mode for n, mode in module.IMPORTS.items()})
        for name, mode in required.items():
            seed['records'][name] = {'sha256': p.sha(name.encode()), 'mode': format(mode, '04o')}
        endpoint = {'schema': 'owned-rpc-endpoint-observation/1', 'clock': self.server['startupClock'],
                    'startResult': {'path': '/original-owner/windows-start-once/RESULT.json', 'sha256': 'd'*64},
                    'response': {'path': '/original-owner/windows-endpoint/response.json', 'sha256': 'e'*64},
                    'expected': {'vmGuid': '11111111-1111-1111-1111-111111111111',
                      'switchGuid': '22222222-2222-2222-2222-222222222222', 'mac': '02ABCDEF1234',
                      'permitPath': 'C:\\EnclaveRpcVm-'+self.vm+'\\'+self.vm+'\\vm-permit.txt', 'permitSha256': 'f'*64},
                    'endpoint': {'host': '192.0.2.2', 'port': 22}, 'pending': False,
                    'guestAuthenticated': False, 'providerSettlementProven': False, 'rpcReady': False,
                    'remoteDeathProven': False, 'reservationMayRelease': False}
        self.config = {'journalRoot': str(self.journal), 'vmAttempt': self.vm, 'ownerBootId': self.owner_boot,
                       'target': {'host': '192.0.2.2', 'port': 22, 'user': 'rpcadmin', 'identityFile': str(self.root/'identity')},
                       'jump': None, 'sshSha256': p.sha(Path('/usr/bin/ssh').read_bytes())}
        self.put(self.root/'identity', b'not a key; never read or used for authentication')
        for name, data in [('serverContract', server), ('serverReady', ready), ('credentialReceipt', credential),
                           ('seedReceipt', seed), ('imageReceipt', {'schema': 'rpc-offline-image/1', 'installedFiles': {}}),
                           ('endpointReceipt', endpoint)]:
            self.config[name] = self.put(self.root/(name+'.json'), data)
        self.calls = []
        self.mutate = lambda phase, row: None
        self.after = lambda phase: None
        self.bad_envelope = lambda row: None
        self.lost = None
        self.top = self.journal/(self.attempt+'-workflow')
        self.unit_start = time.monotonic_ns()//1000
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'INVOCATION_ID': '78'*16}))
        self.stack.enter_context(patch.object(x.subprocess, 'run', self.systemctl))
        for module in (x.guest.d, x.delivery, x.launch.d, x.activation.d, x.runtime.d):
            self.stack.enter_context(patch.object(module, 'exchange', self.exchange))

    def put(self, path, data):
        raw = data if isinstance(data, bytes) else x.c.encode(data)
        path.write_bytes(raw)
        path.chmod(0o600)
        return {'path': str(path), 'sha256': p.sha(raw)}

    def edit(self, key, change):
        path = Path(self.config[key]['path'])
        value = p.decode(path.read_bytes())
        change(value)
        self.config[key] = self.put(path, value)

    def systemctl(self, argv, **kwargs):
        self.assertEqual(argv[:3], ['/usr/bin/systemctl', '--user', 'show'])
        row = {'Id': argv[3], 'MainPID': str(os.getpid()), 'InvocationID': '78'*16,
               'ControlGroup': Path('/proc/self/cgroup').read_text().strip()[3:],
               'Type': 'exec', 'RuntimeMaxUSec': '4min', 'TimeoutStopUSec': '1s',
               'MemoryMax': str(256<<20), 'MemorySwapMax': '0', 'CPUQuotaPerSecUSec': '1s',
               'KillMode': 'control-group', 'Restart': 'no', 'SendSIGKILL': 'yes', 'FinalKillSignal': '9',
               'TasksMax': '16', 'NoNewPrivileges': 'yes', 'ExecMainStartTimestampMonotonic': str(self.unit_start)}
        self.bad_envelope(row)
        return SimpleNamespace(stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode())

    def exchange(self, argv, raw, seconds):
        remote = shlex.split(argv[-1])
        unit = next(v.split('=',1)[1] for v in remote if v.startswith('--unit='))
        phase = next(n for n, prefix in [('guest-observe','enclave-rpc-guest-observe-'), ('delivery','enclave-rpc-delivery-'),
                   ('launch','enclave-rpc-activation-launch-'), ('activation-observe','enclave-rpc-activation-observe-'),
                   ('runtime-l1','enclave-rpc-runtime-l1.'), ('runtime-base','enclave-rpc-runtime-base.')] if unit.startswith(prefix))
        self.calls.append(phase)
        self.assertTrue((self.top/(phase+'.intent.json')).exists())
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-oForwardAgent=no', argv)
        self.assertLessEqual(seconds, 100)
        if phase == 'guest-observe':
            _, _, pins, binding = x.guest.package(self.config, time.time_ns())
            row = {'schema':'owned-rpc-guest-observation/1','attempt':self.attempt,'instance':self.server['instance'],
                   'guestBootId':self.boot,'createdUtcNs':self.server['createdUtcNs'],'deadlineUtcNs':self.server['deadlineUtcNs'],
                   'bindingSha256':binding,'runtimePins':pins,'unitInvocation':'12'*16,'atUtcNs':time.time_ns(),
                   'seededInstanceObserved':True,'rpcReady':False,'storageAttached':False,'attestationVerified':False,
                   'vmAssociationVerified':False,'writersFenced':False}
        elif phase == 'delivery':
            wire = p.decode(raw)
            self.request = json.dumps(wire['request'],sort_keys=True).encode()+b'\n'
            self.bundle = p.decode(base64.b64decode(wire['files']['RESULT.json']))
            row = {'schema':'owned-rpc-activation-delivery-receipt/1','attempt':self.attempt,'bootId':self.boot,
                   'wireSha256':p.sha(raw),'requestSha256':p.sha(self.request),'installed':True,'activationStarted':False,
                   'rpcReady':False,'unitInvocation':'23'*16,'atUtcNs':time.time_ns()}
        elif phase == 'launch':
            row = {'schema':'owned-rpc-activation-launch-receipt/1','attempt':self.attempt,'bootId':self.boot,
                   'requestSha256':p.sha(self.request),'deliveryReceiptSha256':p.sha(raw),'activationSubmitted':True,
                   'ownerArmed':True,'storageReady':False,'rpcReady':False,'adopted':False,'writersFenced':False,
                   'unitInvocation':'45'*16,'owner':self.process,'atUtcNs':time.time_ns()}
        elif phase == 'activation-observe':
            ready = {'attempt':self.attempt,'bootId':self.boot,'requestSha256':p.sha(self.request),
                     'contractSha256':self.bundle['files']['attachment.json'],'roles':{'l1':{},'base':{}},
                     'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False}
            files = [('activation-request.json',self.request),('activation-ready.json',x.c.encode(ready))]
            row = {'schema':'owned-rpc-activation-observation/1','attempt':self.attempt,'bootId':self.boot,
                   'launchReceiptSha256':p.sha(raw),'owner':self.process,'kernelAttachmentsObserved':True,
                   'rpcReady':False,'adopted':False,'writersFenced':False,'unitInvocation':'56'*16,'atUtcNs':time.time_ns(),
                   'files':[{'name':n,'sha256':p.sha(v),'base64':base64.b64encode(v).decode()} for n,v in files]}
        else:
            side = phase.split('-')[1]
            req = p.decode(raw)
            clients = ('el','cl') if side=='l1' else ('base',)
            result = {'phase':side,'attempt':self.attempt,'bootId':self.boot,'activationReadySha256':req['activationReadySha256'],
                      'owner':self.process,'mount':{'id':'100','device':'43:192','where':'/srv/enclave-l1-pair' if side=='l1' else '/srv/enclave-base-holder'},
                      'clients':{v:dict(self.process,unit='enclave-rpc-'+v+'.service',pid=100+i)for i,v in enumerate(clients)},
                      'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False,'adopted':False}
            row = {'schema':'owned-rpc-runtime-delivery-receipt/1','requestSha256':p.sha(raw),'unitInvocation':'67'*16,'result':result}
        self.mutate(phase, row)
        self.after(phase)
        if self.lost == phase:
            raise TimeoutError('synthetic lost response')
        return x.c.encode(row)

    def test_full_six_transports_actual_preparers_and_original_window(self):
        pin = x.run(self.config)
        result = p.decode(x.c.read_pinned(pin))
        self.assertEqual(self.calls, ['guest-observe','delivery','launch','activation-observe','runtime-l1','runtime-base'])
        self.assertEqual(result['deadlineUtcNs'], self.server['deadlineUtcNs'])
        self.assertEqual(result['guestBootId'], self.boot)
        self.assertEqual(len(result['receipts']), 9)
        self.assertTrue(result['clientProcessesObserved'])
        for key in ('rpcReady','adopted','providerSettlementProven','writersFenced','remoteDeathProven','reservationMayRelease'):
            self.assertIs(result[key], False)
        self.assertFalse((self.top/'HELD.json').exists())

    def test_completed_attempt_cannot_repeat(self):
        x.run(self.config)
        with self.assertRaises(FileExistsError): x.run(self.config)
        self.assertEqual(len(self.calls), 6)

    def test_lost_launch_consumed_no_later_submission_or_retry(self):
        self.lost = 'launch'
        with self.assertRaises(TimeoutError): x.run(self.config)
        with self.assertRaises(FileExistsError): x.run(self.config)
        self.assertEqual(self.calls, ['guest-observe','delivery','launch'])
        self.assertEqual(p.decode((self.top/'HELD.json').read_bytes())['phase'], 'launch')
        self.assertFalse((self.top/'RESULT.json').exists())

    def test_lost_l1_never_submits_base(self):
        self.lost = 'runtime-l1'
        with self.assertRaises(TimeoutError): x.run(self.config)
        self.assertEqual(self.calls[-1], 'runtime-l1')
        self.assertFalse((self.top/'prepare-base').exists())

    def test_replaced_activation_owner_blocks_base(self):
        def mutation(phase, row):
            if phase=='runtime-l1': row['result']['owner'] = dict(self.process, start='1235')
        self.mutate = mutation
        with self.assertRaisesRegex(ValueError, 'owner changed'): x.run(self.config)
        self.assertNotIn('runtime-base', self.calls)

    def test_changed_guest_boot_in_launch_blocks_activation_observer(self):
        self.mutate = lambda phase,row: row.update(bootId=f.SERVER) if phase=='launch' else None
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertNotIn('activation-observe', self.calls)

    def test_source_drift_after_observation_blocks_delivery(self):
        self.after = lambda phase: Path(self.config['seedReceipt']['path']).write_bytes(b'changed') if phase=='guest-observe' else None
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, ['guest-observe'])

    def test_provider_settlement_claim_cannot_be_invented(self):
        self.edit('endpointReceipt', lambda row: row.update(providerSettlementProven=True))
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_pending_address_does_not_guess(self):
        self.edit('endpointReceipt', lambda row: row.update(pending=True,endpoint=None))
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_target_switch_and_original_clock_refused(self):
        self.config['target']['host'] = '192.0.2.3'
        with self.assertRaises(ValueError): x.run(self.config)
        self.config['target']['host'] = '192.0.2.2'
        self.edit('endpointReceipt',lambda row:row['clock'].update(sha256='0'*64))
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_other_vm_attempt_refused(self):
        self.config['vmAttempt'] = 'ed'*16
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_incomplete_runtime_closure_refused_before_guest_contact(self):
        self.edit('seedReceipt',lambda row:row['records'].pop('/opt/enclave-rpc/start_runtime.py'))
        with self.assertRaises((ValueError,KeyError)): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_rebooted_key_owner_refused(self):
        self.config['ownerBootId'] = f.BOOT
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertEqual(self.calls, [])

    def test_relaxed_envelope_refused_before_journal(self):
        self.bad_envelope = lambda row:row.update(MemoryMax=str(512<<20))
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertFalse(self.top.exists())

    def test_envelope_cutoff_cannot_outlive_original_deadline(self):
        with self.assertRaises(TimeoutError): x.envelope(self.attempt,time.time_ns()+242_000_000_000)
        self.assertEqual(self.calls, [])

    def test_envelope_checks_pid_cgroup_invocation_and_start(self):
        for key,value in [('MainPID','1'),('ControlGroup','/foreign'),('InvocationID','99'*16),('ExecMainStartTimestampMonotonic','0'),('Restart','always'),('RuntimeMaxUSec','5min')]:
            self.bad_envelope=lambda row,k=key,v=value:row.update({k:v})
            with self.assertRaises((ValueError,TimeoutError)): x.envelope(self.attempt,self.server['deadlineUtcNs'])

    def test_pinned_jump_reaches_every_stage(self):
        pin = self.put(self.root/'jump-known',b'jump ssh-ed25519 fixture\n')
        self.config['jump']={'endpoint':dict(self.config['target'],host='192.0.2.1',user='owner'), 'alias':'jump','knownHosts':pin}
        original=self.exchange
        def via_jump(argv,*args):
            self.assertTrue(any(v.startswith('-oProxyCommand=')for v in argv))
            return original(argv,*args)
        with ExitStack()as stack:
            for module in (x.guest.d,x.delivery,x.launch.d,x.activation.d,x.runtime.d):stack.enter_context(patch.object(module,'exchange',via_jump))
            x.run(self.config)
        self.assertEqual(len(self.calls),6)

    def test_result_cannot_promote_rpc_readiness(self):
        self.mutate=lambda phase,row:row['result'].update(rpcReady=True)if phase=='runtime-base'else None
        with self.assertRaises(ValueError): x.run(self.config)
        self.assertFalse((self.top/'RESULT.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
