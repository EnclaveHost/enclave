"""Actual Windows producers/journals; native, exporter and Control replies mocked.

These composition tests do not authorize production startup. ExportLease tests
use a real held pidfd for this test process with only systemd properties mocked.
"""
import copy
import os
from pathlib import Path
import time
import unittest
from unittest import mock
import test_windows_transition as transition
import test_windows_files as files
import test_windows_endpoint as endpoint
import run_startup as r

w, c = transition.w, transition.c
resource_admission, start_export = r.resource_admission, r.start_export


class Startup(unittest.TestCase):
    def setUp(self):
        self.x = transition.Transition('runTest');self.x.setUp()
        self.addCleanup(self.x.tearDown);self.addCleanup(mock.patch.stopall)
        for module in (r,files.f,endpoint.e):
            mock.patch.object(module,'w',w).start();mock.patch.object(module,'c',c).start()
        mock.patch.object(r,'f',files.f).start();mock.patch.object(r,'e',endpoint.e).start()
        self.f = files.Files('runTest');self.f.x=self.x;self.f.change=lambda row:row
        self.e = endpoint.Endpoint('runTest');self.e.x=self.x;self.e.change=lambda row:None
        self.e.origin=self.x.original['windowsDeadlineMilliseconds']-15000
        initial=self.x.config('cut-seed')
        observed=c.protocol.decode(c.read_pinned(initial['observation']['binding']));del observed['startupCleanup']
        media={'schema':'rpc-staged-client-media-binding/1','instance':self.x.original['instance'],
               'root':'C:\\EnclaveRpcPrivateMedia-'+'9'*32+'\\'+'9'*32,
               'files':[{'name':'boot.vhdx','bytes':2301624320,'sha256':'6'*64,'privateAcl':True},
                        {'name':'seed.iso','bytes':13236224,'sha256':'7'*64,'privateAcl':True}]}
        network={'schema':'owned-rpc-boot-network/1','switchGuid':self.x.guid,'mac':'021122334455'}
        self.e.network=network;self.f.media=media
        binaries={phase:{k:self.x.image(name)for k,name in zip(('controller','entry'),w.IMAGES[phase])}for phase in w.PHASES}
        binaries['start-once']['cleanup']=self.x.image('cleanup-controller.exe','f'*64)
        control=dict(target=self.x.transport['target'],knownHosts=self.x.transport['knownHosts'],hostAlias='windows-phase',
            sshSha256=self.x.transport['sshSha256'],recipientRoot='/home/control/receiver',recipientUid=1000,
            recipientBootId=self.x.boot,sourceRoot='/home/control/source',
            sourcePins={name:c.protocol.sha((r.HERE/name).read_bytes())for name in r.g.SOURCE_NAMES},
            profile={'path':'/home/control/profile.json','sha256':'d'*64})
        self.cfg=dict(clock=self.x.clock,windows=dict(transport=self.x.transport,binaries=binaries,
            filesHelper=self.x.image('transition-files.exe'),endpointHelper=self.x.image('vm-endpoint.exe'),
            requiredFreeBytes=r.e.MINIMUM_FREE),observation=self.x.bound('bare-observation',c.encode(observed)),
            handoff=initial['input'],media=self.x.bound('media',c.encode(media)),network=network,
            nonces={name:format(i+1,'032x')for i,name in enumerate(r.NONCES)},ownerReserveMiB=1024,
            export=dict(credentialReceipt={},resourceConfig=self.x.bound('resource-config',b'{}'),
                        runtimePins={},roles={},stateParent=str(self.x.root/'state'),output=str(self.x.root/'export'),floorMiB=27648,reserveMiB=512),control=control)
        self.lease=mock.Mock(invocation='d'*32);self.lease.check.return_value={'held':True}
        self.contract=self.x.bound('contract',c.encode({'startupClock':self.x.clock,'attempt':'a'*32,'stateParent':str(self.x.root/'state')}))
        self.ready=self.x.bound('ready',b'{"test":"export fixture"}')
        self.imported=self.x.bound('imported',b'{"test":"Control fixture"}')
        self.owner=mock.patch.object(r,'envelope',return_value={'test':'owner envelope'}).start()
        self.admit=mock.patch.object(r,'resource_admission',return_value={'authenticated':True}).start()
        self.prepare=mock.patch.object(r.prepare,'prepare',return_value={'contract':self.contract}).start()
        self.start=mock.patch.object(r,'start_export',return_value=self.lease).start()
        self.ready_call=mock.patch.object(r,'await_ready',return_value=self.ready).start()
        self.transfer=mock.patch.object(r.t,'transfer',side_effect=self.import_public).start()
        self.guest=mock.patch.object(r.g,'send',side_effect=self.guest_workflow).start()
        self.x.call.side_effect=self.exchange
        self.native_calls=[];self.fail=None;self.after=lambda phase:None

    def current_phase(self):
        root=self.x.journal/'startup'
        return next(name for name in ('stage-cut','cut-seed','collect','stage-definition','define','copy','boot','start-once','endpoint')
                    if (root/(name+'.intent.json')).exists() and not (root/(name+'.result.json')).exists())

    def exchange(self,argv,raw,seconds):
        phase=self.current_phase()
        cfg=c.protocol.decode(c.read(self.x.journal/'startup'/(phase+'.intent.json')))
        self.assertEqual(cfg['clock'],self.x.clock)
        if 'clock-sample.exe' not in argv[-1]:
            self.native_calls.append(phase)
            if self.fail==phase:raise TimeoutError('ambiguous native '+phase)
        if phase in w.PHASES:
            self.x.phase=phase;self.x.nonce=cfg['nonce'];self.x.current=cfg
            answer=self.x.exchange(argv,raw,seconds)
        elif phase=='endpoint':
            self.e.cfg=cfg;answer=self.e.exchange(argv,raw,seconds)
        else:
            self.f.config=cfg
            self.f.operation,self.f.journal={'stage-cut':('stage-inputs','stage-cut-seed'),
                'collect':('collect-cut','collect-cut'),'stage-definition':('stage-inputs','stage-define'),
                'copy':('copy-media','copy-media')}[phase]
            if phase=='collect':
                native=c.protocol.decode(c.read_pinned(cfg['cutResult']))['native']
                request=c.protocol.decode(c.read(self.x.journal/'windows-cut-seed/request.json'))
                contract='\n'.join(['owned-rpc-legacy-handoff-v1',request['nonce'],'c'*32,str(native['origin']),
                    str(native['deadline']),request['binaries']['entry']['sha256'],'legacy-memory-cut-seed-v1',native['manifest'],'']).encode()
                activation=c.encode(native['inventory']['seed'])
                self.f.cut_files={'contract.txt':contract,'pool.activation':activation,'pool.complete':c.protocol.sha(activation).encode()}
            answer=self.f.exchange(argv,raw,seconds)
        if 'clock-sample.exe' not in argv[-1]:self.after(phase)
        return answer

    def import_public(self,cfg):
        self.assertEqual(cfg['serverContract'],self.contract);self.assertEqual(cfg['serverReady'],self.ready)
        self.assertEqual(cfg['clock'],self.x.clock)
        self.assertTrue((self.x.journal/'startup/transfer-export.intent.json').is_file())
        return {'receipt':self.imported}

    def guest_workflow(self,cfg):
        self.assertEqual(cfg['exportReceipt'],self.imported)
        actual=c.protocol.decode(c.read_pinned(cfg['endpointReceipt']))
        self.assertFalse(actual['pending']);self.assertEqual(actual['expected']['vmGuid'],self.x.guid)
        self.assertEqual(cfg['clock'],self.x.clock)
        self.assertTrue((self.x.journal/'startup/guest-workflow.intent.json').is_file())
        return {'workflow':{'clientProcessesObserved':True,'rpcReady':False}}

    def held(self,phase):
        result=c.protocol.decode(c.read(self.x.journal/'startup/HELD.json'))
        self.assertEqual(result['phase'],phase);self.assertFalse(result['automaticRetry'])
        self.assertFalse(result['reservationMayRelease']);self.assertFalse((self.x.journal/'startup/RESULT.json').exists())

    def test_complete_actual_windows_chain_feeds_public_handoff(self):
        result=c.protocol.decode(c.read_pinned(r.run(self.cfg)))
        self.assertEqual(self.native_calls,['stage-cut','cut-seed','collect','stage-definition','define','copy','boot','start-once','endpoint'])
        self.assertEqual(result['clock'],self.x.clock)
        for key in ('rpcReady','adopted','providerSettlementProven','writersFenced','remoteDeathProven','reservationMayRelease'):
            self.assertFalse(result[key])
        self.assertTrue(result['clientProcessesObserved']);self.lease.close.assert_called_once()
        start=c.protocol.decode(c.read(self.x.journal/'windows-start-once/RESULT.json'))
        self.assertIn('response-lost-held',start['native']['result'])
        self.assertEqual(self.transfer.call_count,1);self.assertEqual(self.guest.call_count,1)

    def test_consumed_whole_attempt_prevents_even_changed_nonce_retry(self):
        r.run(self.cfg);before=self.x.call.call_count
        self.cfg['nonces']['cut-seed']='f'*32
        with self.assertRaises(FileExistsError):r.run(self.cfg)
        self.assertEqual(self.x.call.call_count,before);self.start.assert_called_once()

    def test_lost_definition_never_copies_boots_or_submits_guest(self):
        self.fail='define'
        with self.assertRaises(TimeoutError):r.run(self.cfg)
        self.held('define');self.assertEqual(self.native_calls[-1],'define');self.guest.assert_not_called()
        self.lease.close.assert_called_once()

    def test_lost_export_registration_never_cuts_or_retries(self):
        self.start.side_effect=TimeoutError('lost systemd acknowledgment')
        with self.assertRaises(TimeoutError):r.run(self.cfg)
        self.held('export-start');self.x.call.assert_not_called()
        with self.assertRaises(FileExistsError):r.run(self.cfg)
        self.start.assert_called_once()

    def test_lost_control_reply_is_held_after_one_submission(self):
        self.guest.side_effect=TimeoutError('lost Control reply')
        with self.assertRaises(TimeoutError):r.run(self.cfg)
        self.held('guest-workflow');self.guest.assert_called_once()
        with self.assertRaises(FileExistsError):r.run(self.cfg)
        self.guest.assert_called_once()

    def test_pending_endpoint_does_not_contact_control(self):
        self.e.change=lambda row:row.update(ipv4=None)
        with self.assertRaisesRegex(ValueError,'pending'):r.run(self.cfg)
        self.held('endpoint');self.transfer.assert_not_called();self.guest.assert_not_called()

    def test_exporter_loss_after_cut_stops_before_collect(self):
        def after(phase):
            if phase=='cut-seed':self.lease.check.side_effect=ValueError('original exporter died')
        self.after=after
        with self.assertRaisesRegex(ValueError,'exporter died'):r.run(self.cfg)
        self.held('cut-seed');self.assertEqual(self.native_calls,['stage-cut','cut-seed'])

    def test_mutated_static_media_cannot_advance_after_copy(self):
        def after(phase):
            if phase=='copy':Path(self.cfg['media']['path']).write_bytes(b'{}')
        self.after=after
        with self.assertRaises(ValueError):r.run(self.cfg)
        self.held('copy');self.assertEqual(self.native_calls[-1],'copy');self.guest.assert_not_called()

    def test_expiry_after_preparation_never_starts_export(self):
        def prepare(cfg):
            self.x.wall+=900_000_000_000;self.x.mono+=900_000_000_000
            return {'contract':self.contract}
        self.prepare.side_effect=prepare
        with self.assertRaises(ValueError):r.run(self.cfg)
        self.held('prepare-export');self.start.assert_not_called();self.x.call.assert_not_called()

    def test_preflight_rejects_bad_media_network_and_recipient_before_work(self):
        for kind in ('media','network','uid','source','nonces'):
            cfg=copy.deepcopy(self.cfg)
            if kind=='media':
                media=c.protocol.decode(c.read_pinned(cfg['media']));media['files'][0]['bytes']=4294967297
                cfg['media']=self.x.bound('large',c.encode(media))
            elif kind=='network':cfg['network']['mac']='FF1122334455'
            elif kind=='uid':cfg['control']['recipientUid']=True
            elif kind=='source':cfg['control']['sourcePins']['run_guest_workflow.py']='0'*64
            else:cfg['nonces']['copy']=cfg['nonces']['boot']
            with self.assertRaises(ValueError):r.run(cfg)
        self.start.assert_not_called();self.x.call.assert_not_called();self.owner.assert_not_called()

    def test_original_handoff_change_after_admission_stops_preparation(self):
        def changed(cfg):
            Path(cfg['handoff']['binding']['path']).write_bytes(b'{}');return {'authenticated':True}
        self.admit.side_effect=changed
        with self.assertRaises(ValueError):r.run(self.cfg)
        self.held('admission');self.prepare.assert_not_called();self.start.assert_not_called()

    def test_authenticated_pending_floor_is_not_replaced_by_free_ram(self):
        cfg=copy.deepcopy(self.cfg)
        cfg['export']['runtimePins']={name:'e'*64 for name in ('/usr/bin/node',str(r.HERE/'server/observe_resources.mjs'))}
        row={'authenticated':True,'unreadUnits':0,'availableMiB':31965,'pendingMiB':5948,'floorMiB':18432}
        with mock.patch.object(r.prepare,'digest',return_value='e'*64),mock.patch.object(r.subprocess,'run') as run:
            run.return_value.stdout=c.encode(row)
            with self.assertRaisesRegex(ValueError,'admission refused'):resource_admission(cfg)
            row['availableMiB']=40000;run.return_value.stdout=c.encode(row)
            self.assertEqual(resource_admission(cfg),row)
            row['unreadUnits']=1;run.return_value.stdout=c.encode(row)
            with self.assertRaises(ValueError):resource_admission(cfg)
            cfg['ownerReserveMiB']=512
            with self.assertRaises(ValueError):resource_admission(cfg)

    def test_export_submission_has_independent_watchdog_and_original_contract(self):
        with mock.patch.object(r.subprocess,'run') as run,mock.patch.object(r,'ExportLease',return_value=self.lease):
            self.assertIs(start_export(self.x.clock,self.contract),self.lease)
            argv=run.call_args.args[0]
            self.assertIn('--property=MemoryMax=384M',argv);self.assertIn('--property=WatchdogSec=2',argv)
            self.assertIn('--property=Restart=no',argv);self.assertEqual(argv[-1],self.contract['path'])
            self.assertNotIn('--collect',argv);self.assertEqual(run.call_args.kwargs['timeout'],5)


class ProcessEnvelope(unittest.TestCase):
    def setUp(self):
        self.unit='enclave-rpc-export-'+'a'*32+'.service'
        self.row=dict(Id=self.unit,ActiveState='active',Type='notify',NotifyAccess='main',MemoryMax=str(384<<20),
            MemorySwapMax='0',CPUQuotaPerSecUSec='1s',TasksMax='32',WatchdogUSec='2s',WatchdogSignal='9',
            TimeoutStartUSec='3s',TimeoutStopUSec='1s',KillMode='control-group',Restart='no',SendSIGKILL='yes',
            FinalKillSignal='9',LimitCORE='0',InvocationID='d'*32,MainPID=str(os.getpid()),
            ControlGroup='/test/'+self.unit,WatchdogTimestampMonotonic=str(time.monotonic_ns()//1000))
        self.original_read=Path.read_text
        def read(path,*args,**kw):
            if str(path)==f'/proc/{os.getpid()}/cgroup':return '0::'+self.row['ControlGroup']
            return self.original_read(path,*args,**kw)
        mock.patch.object(r,'show',side_effect=lambda unit:dict(self.row)).start()
        mock.patch.object(Path,'read_text',read).start();self.addCleanup(mock.patch.stopall)

    def test_real_pidfd_observation_does_not_terminate_or_adopt_owner(self):
        lease=r.ExportLease(self.unit)
        self.assertEqual(lease.check()['pid'],os.getpid());self.assertGreater(int(lease.start),0)
        lease.close();self.assertTrue(Path(f'/proc/{os.getpid()}').is_dir())

    def test_replacement_stale_watchdog_and_limit_drift_refused(self):
        lease=r.ExportLease(self.unit);self.addCleanup(lease.close)
        for key,value in [('InvocationID','e'*32),('MainPID',str(os.getpid()+1)),('MemoryMax',str(512<<20)),
                          ('WatchdogTimestampMonotonic',str(time.monotonic_ns()//1000-3_000_000))]:
            old=self.row[key];self.row[key]=value
            with self.assertRaises(ValueError):lease.check()
            self.row[key]=old

    def test_signaled_pidfd_is_refused_even_matching_systemd(self):
        lease=r.ExportLease(self.unit);self.addCleanup(lease.close)
        lease.poll=mock.Mock();lease.poll.poll.return_value=[(lease.fd,1)]
        with self.assertRaisesRegex(ValueError,'exited'):lease.check()

    def test_startup_deadline_cannot_be_extended_by_unit(self):
        attempt='a'*32;unit='enclave-rpc-startup-'+attempt+'.service'
        row=dict(self.row,Id=unit,Type='exec',RuntimeMaxUSec='10min',MemoryMax=str(256<<20),TasksMax='16',
                 NoNewPrivileges='yes',ControlGroup='/test/'+unit,ExecMainStartTimestampMonotonic=str(time.monotonic_ns()//1000))
        with mock.patch.object(r,'show',return_value=row),mock.patch.dict(os.environ,INVOCATION_ID='d'*32),mock.patch.object(Path,'read_text',return_value='0::'+row['ControlGroup']):
            with self.assertRaises(TimeoutError):r.envelope({'attempt':attempt,'deadlineMonotonicNs':time.monotonic_ns()+600_000_000_000})
            self.assertEqual(r.envelope({'attempt':attempt,'deadlineMonotonicNs':time.monotonic_ns()+900_000_000_000})['Id'],unit)


if __name__=='__main__':unittest.main(verbosity=2)
