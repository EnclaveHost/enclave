#!/usr/bin/env python3
"""Compose the original Windows/storage/key-owner startup transaction once.

The original clock must already have been begun and authenticated, before any
attempt preparation. Qualified staged binaries, media and Control profile are
prerequisites. This submits production work when explicitly invoked with an
admitted configuration; it neither retries nor proves RPC readiness/adoption.
"""
import importlib.util
import base64
import os
from pathlib import Path
import re
import select
import subprocess
import time

HERE = Path(__file__).resolve().parent


def load(name, path=None):
    spec = importlib.util.spec_from_file_location(name, path or HERE/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


w = load('windows_transition')
f = load('windows_files')
e = load('windows_endpoint')
t = load('transfer_export')
g = load('deliver_guest_workflow')
prepare = load('prepare_export', HERE/'server/prepare_export.py')
c, p = w.c, w.c.protocol
NONCES = (*w.PHASES, 'stage-cut', 'collect', 'stage-definition', 'copy', 'endpoint')


def show(unit):
    keys = ('Id','MainPID','InvocationID','ControlGroup','ActiveState','Type','RuntimeMaxUSec',
            'TimeoutStopUSec','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','TasksMax',
            'KillMode','Restart','SendSIGKILL','FinalKillSignal','NoNewPrivileges',
            'ExecMainStartTimestampMonotonic','WatchdogUSec','WatchdogSignal','NotifyAccess',
            'TimeoutStartUSec','WatchdogTimestampMonotonic','LimitCORE')
    r = subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property='+','.join(keys),'--no-pager'],
                       stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2,check=True)
    if len(r.stdout) > 16384:
        raise ValueError('Bounded unit observation required')
    lines = r.stdout.decode().splitlines()
    row = dict(line.split('=',1) for line in lines)
    if len(row) != len(lines) or set(row) != set(keys):
        raise ValueError('Exact unit properties required')
    return row


def envelope(original):
    unit = 'enclave-rpc-startup-'+original['attempt']+'.service'
    row = show(unit)
    expected = {'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'ActiveState':'active','Type':'exec','RuntimeMaxUSec':'10min','TimeoutStopUSec':'1s',
        'MemoryMax':str(256<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'16',
        'KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    if (not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row[k]!=v for k,v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):
        raise ValueError('Independent startup owner envelope differs')
    start = row['ExecMainStartTimestampMonotonic']
    if not re.fullmatch('[0-9]{1,19}',start):
        raise ValueError('Exact owner origin required')
    elapsed = time.monotonic_ns()-int(start)*1000
    if not 0 <= elapsed < 10_000_000_000 or int(start)*1000+603_000_000_000 >= original['deadlineMonotonicNs']:
        raise TimeoutError('Independent startup cutoff does not fit original deadline')
    return {k:row[k] for k in ('Id','MainPID','InvocationID','ControlGroup','ExecMainStartTimestampMonotonic')}


def resource_admission(config):
    cfg = config['export']
    for name in ('floorMiB','reserveMiB'):
        if type(cfg[name]) is not int or cfg[name] < (27648 if name=='floorMiB' else 512):
            raise ValueError('Retained exporter resources required')
    reserve = config['ownerReserveMiB']
    if type(reserve) is not int or not (1280 if 'localGuestOwner' in config else 1024) <= reserve <= 1048576:
        raise ValueError('Explicit full owner/export/bootstrap allowance required')
    reader = str(HERE/'server/observe_resources.mjs')
    for name in ('/usr/bin/node', reader):
        if prepare.digest(name) != cfg['runtimePins'][name]:
            raise ValueError('Authenticated resource reader changed')
    c.read_pinned(cfg['resourceConfig'])
    r = subprocess.run(['/usr/bin/node',reader,cfg['resourceConfig']['path']],stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL,timeout=3,check=True)
    if len(r.stdout)>65536:
        raise ValueError('Resource result bound')
    row = p.decode(r.stdout)
    if (row.get('authenticated') is not True or row.get('unreadUnits') != 0
            or any(type(row.get(k)) is not int or row[k]<0 for k in ('availableMiB','pendingMiB','floorMiB'))
            or row['availableMiB']-row['pendingMiB']-reserve < max(27648,cfg['floorMiB'],row['floorMiB'])):
        raise ValueError('Current authenticated pending-aware owner admission refused')
    return row


class ExportLease:
    """Keep an exact pidfd while composing consumers; never infer death/release."""
    def __init__(self, unit):
        self.unit = unit
        row = show(unit)
        expected = {'Id':unit,'ActiveState':'active','Type':'notify','NotifyAccess':'main',
            'MemoryMax':str(384<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32',
            'WatchdogUSec':'2s','WatchdogSignal':'9','TimeoutStartUSec':'3s','TimeoutStopUSec':'1s',
            'KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','LimitCORE':'0'}
        if any(row[k]!=v for k,v in expected.items()) or not re.fullmatch('[0-9a-f]{32}',row['InvocationID']):
            raise ValueError('Exact independent export unit required')
        if not re.fullmatch('[1-9][0-9]*',row['MainPID']) or not row['ControlGroup'].endswith('/'+unit):
            raise ValueError('Exact export process/cgroup required')
        self.pid = int(row['MainPID'])
        self.expected = expected
        self.invocation = row['InvocationID']; self.group = row['ControlGroup']
        self.start = self.process_start()
        self.fd = os.pidfd_open(self.pid,0)
        try:
            self.poll = select.poll();self.poll.register(self.fd,select.POLLIN)
            self.check()
        except BaseException:
            os.close(self.fd)
            raise

    def process_start(self):
        text = (Path('/proc')/str(self.pid)/'stat').read_text()
        return text[text.rfind(')')+2:].split()[19]

    def check(self):
        if self.poll.poll(0):
            raise ValueError('Held original exporter exited')
        row = show(self.unit)
        ack = row['WatchdogTimestampMonotonic']
        if (any(row[k]!=v for k,v in self.expected.items())
                or row['MainPID']!=str(self.pid) or row['InvocationID']!=self.invocation or row['ControlGroup']!=self.group
                or not re.fullmatch('[1-9][0-9]*',ack) or not 0 <= time.monotonic_ns()-int(ack)*1000 < 2_000_000_000
                or self.process_start()!=self.start
                or (Path('/proc')/str(self.pid)/'cgroup').read_text().strip()!='0::'+self.group):
            raise ValueError('Original exporter identity/watchdog changed')
        return {'unit':self.unit,'pid':self.pid,'start':self.start,'invocation':self.invocation,'cgroup':self.group}

    def close(self):
        os.close(self.fd)  # Closing an observation handle neither stops nor adopts the export.


def start_export(clock, contract):
    original = c.validate(clock)
    raw = c.read_pinned(contract); value = p.decode(raw)
    if value['startupClock']!=clock or value['attempt']!=original['attempt']:
        raise ValueError('Original prepared export required')
    unit = 'enclave-rpc-export-'+original['attempt']+'.service'
    props = ['Type=notify','NotifyAccess=main','MemoryMax=384M','MemorySwapMax=0','CPUQuota=100%',
             'TasksMax=32','LimitCORE=0','WatchdogSec=2','WatchdogSignal=SIGKILL','TimeoutStartSec=3',
             'TimeoutStopSec=1','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','UMask=0077']
    # No automatic stop/retry if registration or its acknowledgment is ambiguous.
    subprocess.run(['/usr/bin/systemd-run','--user','--quiet','--unit='+unit,*['--property='+v for v in props],
                    '/usr/bin/python3','-B',str(HERE/'server/guarded_export.py'),contract['path']],
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=True)
    if c.read_pinned(contract)!=raw:
        raise ValueError('Export contract changed during submission')
    c.validate(clock)
    return ExportLease(unit)


def await_ready(clock, contract, lease):
    value = p.decode(c.read_pinned(contract))
    path = Path(value['stateParent'])/value['attempt']/'ready.json'
    until = time.monotonic()+min(30,c.remaining(clock))
    while True:
        c.validate(clock);lease.check()
        if path.exists():
            raw = c.read(path)
            t.validate_files({'serverContract':c.read_pinned(contract),'serverReady':raw},time.time_ns())
            if p.decode(raw)['invocation'] != lease.invocation:
                raise ValueError('Readiness belongs to another exporter')
            lease.check()
            return {'path':str(path),'sha256':p.sha(raw)}
        if time.monotonic()>=until:
            raise TimeoutError('Original export readiness observation bound')
        time.sleep(.1)


def preflight(config):
    owner_field = 'localGuestOwner' if 'localGuestOwner' in config else 'control'
    w.exact(config, ('clock','windows','observation','handoff','media','network','nonces','export',owner_field,'ownerReserveMiB'))
    original = c.validate(config['clock'])
    win = config['windows']
    w.exact(win, ('transport','binaries','filesHelper','endpointHelper','requiredFreeBytes'))
    w.exact(win['binaries'], w.PHASES);w.exact(config['nonces'], NONCES)
    nonces = list(config['nonces'].values())
    for nonce in nonces:c.hex32(nonce)
    if len(set(nonces+[original['attempt'],original['vmAttempt']])) != len(nonces)+2:
        raise ValueError('Distinct original worker nonces required')
    for phase in w.PHASES:
        binaries = win['binaries'][phase]
        w.exact(binaries, ('controller','entry','cleanup') if phase=='start-once' else ('controller','entry'))
        for key,name in zip(('controller','entry'),w.IMAGES[phase]):w.image(binaries[key],name)
    w.image(win['binaries']['start-once']['cleanup'],'cleanup-controller.exe')
    w.image(win['filesHelper'],'transition-files.exe');w.image(win['endpointHelper'],'vm-endpoint.exe')
    if c.integer(win['requiredFreeBytes']) < e.MINIMUM_FREE:raise ValueError('Native endpoint floor weakened')
    journal = Path(config['clock']['path']).parent
    w.transport(win['transport'],journal/'startup')
    observed = w.observation(c.read_pinned(config['observation']),original)
    if any(key in observed for key in ('legacyCutSeed','sharedPhysicalPool','bootNetwork','startupCleanup')):
        raise ValueError('Original bare observation required before any work')
    manifest = p.decode(w.staged(config['handoff'],'handoff.json'))
    if manifest.get('schema')!='legacy-memory-handoff/2' or manifest['boot']!=original['windowsBoot']:
        raise ValueError('Original protected handoff manifest required')
    media = p.decode(c.read_pinned(config['media']))
    if (media.get('schema')!='rpc-staged-client-media-binding/1' or media['instance']!=original['instance']
            or type(media.get('files')) is not list or len(media['files'])!=2):
        raise ValueError('Original private media required')
    if not re.fullmatch(r'C:\\EnclaveRpcPrivateMedia-([0-9a-f]{32})\\\1', media.get('root','')):
        raise ValueError('Protected original private media namespace required')
    names = set()
    for row in media['files']:
        w.exact(row,('name','bytes','sha256','privateAcl'))
        if row['name'] not in ('boot.vhdx','seed.iso') or row['name'] in names or row['privateAcl'] is not True:
            raise ValueError('Complete private media pair required')
        names.add(row['name']);p.digest(row['sha256'])
        if not 1 <= c.integer(row['bytes']) <= (4294967296 if row['name']=='boot.vhdx' else 67108864):
            raise ValueError('Media growth limit exceeded')
    network = config['network'];w.exact(network,('schema','switchGuid','mac'))
    if network['schema']!='owned-rpc-boot-network/1' or not re.fullmatch('02[0-9A-F]{10}',network['mac']):
        raise ValueError('Reviewed boot network required')
    w.guid(network['switchGuid'])
    w.exact(config['export'],('credentialReceipt','resourceConfig','runtimePins','roles','stateParent','output','floorMiB','reserveMiB'))
    control = config[owner_field]
    fields = ('recipientRoot','sourceRoot','sourcePins','profile')
    if owner_field=='control':fields += ('target','knownHosts','hostAlias','sshSha256','recipientUid','recipientBootId')
    w.exact(control,fields)
    if set(control['sourcePins'])!=set(g.SOURCE_NAMES):raise ValueError('Complete Control source required')
    for name,sha in control['sourcePins'].items():
        p.digest(sha)
        if p.sha((HERE/name).read_bytes())!=sha:raise ValueError('Control source pin differs')
    if owner_field=='control':
        d = g.d
        d.endpoint(control['target']);d.ssh_options(journal/'unused',control['hostAlias'])
        known = c.read_pinned(control['knownHosts']);parts = known.decode('ascii').strip().split()
        if len(parts)!=3 or parts[:2]!=[control['hostAlias'],'ssh-ed25519'] or known.count(b'\n')>1:
            raise ValueError('One pinned Control host key required')
        key = base64.b64decode(parts[2],validate=True)
        if len(key)!=51 or key[:19]!=b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
            raise ValueError('Control host key differs')
        p.boot(control['recipientBootId']);p.digest(control['sshSha256'])
        if p.sha(Path('/usr/bin/ssh').read_bytes())!=control['sshSha256']:
            raise ValueError('Control SSH client changed')
        if type(control['recipientUid']) is not int or not 0 <= control['recipientUid'] <= 2147483647:
            raise ValueError('Admitted Control UID required')
    for key in ('recipientRoot','sourceRoot'):t.path_text(control[key])
    w.exact(control['profile'],('path','sha256'));t.path_text(control['profile']['path']);p.digest(control['profile']['sha256'])
    if owner_field=='localGuestOwner':
        profile = p.decode(c.read_pinned(control['profile']))
        w.exact(profile,g.PROFILE_FIELDS)
        if profile['ownerBootId']!=original['bootId'] or profile['vmAttempt']!=original['vmAttempt']:
            raise ValueError('Original local guest-key owner required')
        g.d.endpoint({'host':'127.0.0.1','port':22,'user':'rpcadmin','identityFile':profile['guestIdentityFile']})
        c.directory(control['recipientRoot']);c.directory(profile['journalRoot'])
    # The actual receiver checks the complete protected source tree before import.
    # Preparation must happen inside this same original clock; no begin/finish
    # call exists in this driver and no static candidate can reset the window.
    return original


def run(config):
    config = p.decode(c.encode(config))
    original = preflight(config)
    process = envelope(original)
    parent = c.directory(Path(config['clock']['path']).parent);root = parent/'startup'
    root.mkdir(mode=0o700);c.sync_directory(parent)
    c.write_new(root/'intent.json',c.encode({'configurationSha256':p.sha(c.encode(config)),'owner':process,
        'clock':config['clock'],'outcome':'consumed-no-automatic-retry'}))
    static = {k:c.read_pinned(config[k]) for k in ('observation','media')}
    handoff_raw = w.staged(config['handoff'],'handoff.json')
    local_profile = c.read_pinned(config['localGuestOwner']['profile']) if 'localGuestOwner' in config else None
    lease = None;phase = 'admission';receipts = {}

    def current():
        c.validate(config['clock'])
        if any(c.read_pinned(config[k])!=raw for k,raw in static.items()):raise ValueError('Original startup inputs changed')
        if w.staged(config['handoff'],'handoff.json')!=handoff_raw:raise ValueError('Original handoff changed')
        if local_profile is not None and c.read_pinned(config['localGuestOwner']['profile'])!=local_profile:raise ValueError('Local owner profile changed')
        if lease is not None:lease.check()

    def step(name, function, arguments):
        nonlocal phase
        phase = name;current()
        c.write_new(root/(name+'.intent.json'),c.encode(arguments))
        result = function(arguments);current()
        receipts[name] = c.write_new(root/(name+'.result.json'),c.encode(result))
        return result

    def decoded(binding):return p.decode(c.read_pinned(binding))

    try:
        step('admission',resource_admission,config)
        prepared_export = step('prepare-export',prepare.prepare,dict(config['export'],clock=config['clock']))
        phase = 'export-start';current()
        c.write_new(root/'export-start.intent.json',c.encode(prepared_export['contract']))
        lease = start_export(config['clock'],prepared_export['contract'])
        receipts['export-start'] = c.write_new(root/'export-start.result.json',c.encode(lease.check()))
        ready = step('export-ready',lambda _:await_ready(config['clock'],prepared_export['contract'],lease),{})
        win = config['windows'];nonces = config['nonces']
        base = {'clock':config['clock'],'transport':win['transport']}
        files = dict(base,helper=win['filesHelper'])
        staged_cut = decoded(step('stage-cut',f.stage_inputs,dict(files,nonce=nonces['stage-cut'],phase='cut-seed',files={'observation.json':config['observation']})))
        cut = step('cut-seed',w.execute,dict(base,phase='cut-seed',nonce=nonces['cut-seed'],binaries=win['binaries']['cut-seed'],
                 observation=staged_cut['result']['files']['observation.json'],input=config['handoff'],previous=None))
        collected = decoded(step('collect',f.collect_cut,dict(files,nonce=nonces['collect'],cutResult=cut)))
        prepared = step('prepare-definition',w.prepare_definition,{'clock':config['clock'],'cutResult':cut,
            'cutEvidence':collected['result']['cutEvidence'],'observation':config['observation'],'media':config['media'],
            'providerSha256':win['binaries']['start-once']['entry']['sha256'],
            'cleanupSha256':win['binaries']['start-once']['cleanup']['sha256'],'network':config['network']})
        definition = decoded(prepared)
        staged = decoded(step('stage-definition',f.stage_inputs,dict(files,nonce=nonces['stage-definition'],phase='define',
                         files={'observation.json':definition['admission'],'definition-plan.txt':definition['plan']})))['result']['files']
        defined = step('define',w.execute,dict(base,phase='define',nonce=nonces['define'],binaries=win['binaries']['define'],
                       observation=staged['observation.json'],input=staged['definition-plan.txt'],previous=cut))
        step('copy',f.copy_media,dict(files,nonce=nonces['copy'],definitionResult=defined,preparedDefinition=prepared))
        previous = defined
        for name in ('boot','start-once'):
            previous = step(name,w.execute,dict(base,phase=name,nonce=nonces[name],binaries=win['binaries'][name],
                observation=staged['observation.json'],input={'path':definition['vmRoot']+'\\definition-plan.txt','binding':definition['plan']},previous=previous))
        endpoint = step('endpoint',e.observe,dict(base,helper=win['endpointHelper'],nonce=nonces['endpoint'],
                       startResult=previous,requiredFreeBytes=win['requiredFreeBytes']))
        if decoded(endpoint)['pending'] is not False:raise ValueError('Original endpoint remains pending')
        public = {'clock':config['clock'],'serverContract':prepared_export['contract'],'serverReady':ready}
        if 'localGuestOwner' in config:
            control = config['localGuestOwner']
            imported = step('transfer-export',t.transfer_local,dict(public,recipientRoot=control['recipientRoot']))
            result = step('guest-workflow',g.send_local,dict(public,**control,exportReceipt=imported['receipt'],endpointReceipt=endpoint))
        else:
            control = config['control']
            imported = step('transfer-export',t.transfer,dict(public,**{k:control[k]for k in
                       ('target','knownHosts','hostAlias','sshSha256','recipientRoot','recipientUid','recipientBootId')}))
            result = step('guest-workflow',g.send,dict(public,**control,exportReceipt=imported['receipt'],endpointReceipt=endpoint))
        current()
        return c.write_new(root/'RESULT.json',c.encode({'schema':'owned-rpc-startup-workflow/1','clock':config['clock'],
            'attempt':original['attempt'],'vmAttempt':original['vmAttempt'],'receipts':receipts,'guestWorkflow':result,
            'exporter':lease.check(),'clientProcessesObserved':True,'rpcReady':False,'adopted':False,
            'providerSettlementProven':False,'writersFenced':False,'remoteDeathProven':False,'reservationMayRelease':False}))
    except Exception as error:
        c.write_new(root/'HELD.json',c.encode({'phase':phase,'errorType':type(error).__name__,
            'automaticRetry':False,'rpcReady':False,'reservationMayRelease':False}))
        raise
    finally:
        if lease is not None:lease.close()


if __name__ == '__main__':
    import json,sys
    os.umask(0o077)
    print(json.dumps(run(p.decode(c.read(sys.argv[1])))))
