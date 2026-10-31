"""Submit the four existing Windows startup controllers once, in order.

Inputs must already be staged in qualified protected Windows namespaces. This
module does not stage credentials, invent admission/seed receipts, or authorize
readiness. Run inside an admitted independently bounded owner process. SSH exit
is not remote death; native watchdogs and original VM cleanup remain necessary.
"""
import base64
import hashlib
import importlib.util
from pathlib import Path
import re
import time
import uuid


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('startup_clock')
delivery = load('deliver_activation')
PHASES = ('cut-seed', 'define', 'boot', 'start-once')
IMAGES = {
    'cut-seed': ('handoff-controller.exe', 'handoff-entry.exe'),
    'define': ('definition-controller.exe', 'definition-entry.exe'),
    'boot': ('definition-controller.exe', 'definition-entry.exe'),
    'start-once': ('startup-controller.exe', 'provider-entry.exe'),
}


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('Exact transition fields required')


def windows_path(value, filename):
    if (not isinstance(value, str) or len(value) > 220
            or not re.fullmatch(r'C:\\(?:[A-Za-z0-9_-]+\\)+[A-Za-z0-9_.-]+', value)
            or value.split('\\')[-1] != filename):
        raise ValueError('Fixed canonical Windows path required')
    return value


def image(value, filename):
    exact(value, ('path', 'sha256'))
    c.protocol.digest(value['sha256'])
    windows_path(value['path'], filename)


def staged(value, filename):
    exact(value, ('path', 'binding'))
    windows_path(value['path'], filename)
    return c.read_pinned(value['binding'])


def guid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value or uuid.UUID(value).int == 0:
        raise ValueError('Exact nonempty GUID required')
    return value


def transport(config, root):
    exact(config, ('target', 'knownHosts', 'hostAlias', 'sshSha256', 'samplerPath', 'samplerSha256'))
    c.protocol.digest(config['sshSha256'])
    c.protocol.digest(config['samplerSha256'])
    if hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest() != config['sshSha256']:
        raise ValueError('SSH binary changed')
    endpoint = delivery.endpoint(config['target'])  # Never reads identity bytes.
    alias = config['hostAlias']
    if not isinstance(alias, str) or not re.fullmatch('[a-zA-Z0-9_.-]{1,100}', alias):
        raise ValueError('Fixed host alias required')
    known = c.read_pinned(config['knownHosts'])
    fields = known.decode('ascii').strip().split()
    if len(fields) != 3 or fields[:2] != [alias, 'ssh-ed25519'] or known.count(b'\n') > 1:
        raise ValueError('One previously trusted Ed25519 host key required')
    key = base64.b64decode(fields[2], validate=True)
    if len(key) != 51 or key[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
        raise ValueError('Host key encoding differs')
    windows_path(config['samplerPath'], 'clock-sample.exe')
    return delivery.ssh_options(root / 'known-hosts', alias) + endpoint, known


def definition(raw, clock):
    fields = raw.decode('ascii').split('\n')
    if (len(fields) != 12 or fields[0] != 'owned-rpc-definition/1' or fields[11] != ''
            or fields[10] != 'generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false'):
        raise ValueError('Exact native definition plan required')
    if (fields[1] != clock['vmAttempt'] or fields[2] != clock['windowsBoot']
            or fields[5] != 'C:\\EnclaveRpcVm-' + fields[1] + '\\' + fields[1]
            or fields[6] != str(clock['windowsOriginMilliseconds'])
            or fields[7] != str(clock['windowsDeadlineMilliseconds'])):
        raise ValueError('Definition changed the original attempt/window')
    for index in (3, 4, 8, 9):
        c.protocol.digest(fields[index])
    return fields


def observation(raw, clock):
    row = c.protocol.decode(raw)
    if row.get('rc') != 0 or row.get('failure') is not None or row.get('readOnly') is not True:
        raise ValueError('Successful read-only host observation required')
    obs = row['observation']
    if (obs['bootNative'] != clock['windowsBoot'] or obs['before'] != obs['after']
            or obs['nodeExit'] != 0 or obs['manager']['completeTransport'] is not True
            or obs['manager']['errors']):
        raise ValueError('Host observation lineage differs')
    # Native controllers independently re-read host state and enforce their own
    # 300s age, full budgets and namespace admission. No fabricated freshness.
    return row


def validate_previous(config, clock, journal):
    phase = config['phase']
    index = PHASES.index(phase)
    if index == 0:
        if config['previous'] is not None:
            raise ValueError('First phase cannot adopt an unrelated predecessor')
        return None
    previous = config['previous']
    if phase == 'define' and isinstance(previous, dict) and previous.get('path') == str(journal / 'retained-cut' / 'RESULT.json'):
        return validate_retained_cut(previous, config['clock'], config['transport'], config['nonce'])
    expected = journal / ('windows-' + PHASES[index - 1]) / 'RESULT.json'
    if not isinstance(previous, dict) or previous.get('path') != str(expected):
        raise ValueError('Exact original predecessor receipt required')
    row = c.protocol.decode(c.read_pinned(previous))
    if (row.get('schema') != 'owned-rpc-windows-transition/1'
            or row['phase'] != PHASES[index - 1] or row['clock'] != config['clock']
            or row['attempt'] != clock['attempt'] or row['vmAttempt'] != clock['vmAttempt']
            or row['completed'] is not True or row['rpcReady'] is not False
            or row['reservationMayRelease'] is not False):
        raise ValueError('Predecessor is not completed within this original clock')
    # Re-read its consumed request and exact authenticated response. A RESULT
    # file by itself never substitutes for the transport's retained evidence.
    folder = expected.parent
    request = c.read(folder / 'request.json')
    submit = c.protocol.decode(c.read(folder / 'submit.intent'))
    reply = c.read(folder / 'response.json')
    if (c.protocol.sha(request) != row['requestSha256'] or c.protocol.sha(reply) != row['responseSha256']
            or submit['requestSha256'] != row['requestSha256']
            or c.protocol.decode(reply) != row['native']):
        raise ValueError('Predecessor evidence changed')
    prior_config = c.protocol.decode(request)
    if prior_config['transport'] != config['transport'] or prior_config['nonce'] == config['nonce']:
        raise ValueError('Original transport changed or worker nonce reused')
    return row


def validate_reply(row, phase, config, original, origin, deadline):
    if (row.get('origin') != origin or row.get('deadline') != deadline
            or row.get('failures') != [] or row.get('reservationMayRelease') is not False):
        raise ValueError('Native phase result does not bind the submitted lease')
    root_kind = {'cut-seed': 'LegacyHandoff', 'define': 'Definition', 'boot': 'Definition', 'start-once': 'Startup'}[phase]
    expected_root = 'C:\\EnclaveRpc' + root_kind + '-' + config['nonce'] + '\\' + config['nonce']
    if row.get('root') != expected_root:
        raise ValueError('Native phase namespace differs')
    if phase == 'start-once':
        if (row.get('schema') != 'owned-rpc-startup-controller/1'
                or row.get('localWorkerCompleted') is not True or row.get('rpcReadinessProven') is not False
                or row.get('independentTasksRetained') != 2
                or row.get('vmRoot') != 'C:\\EnclaveRpcVm-' + original['vmAttempt'] + '\\' + original['vmAttempt']):
            raise ValueError('Startup controller outcome incomplete')
        # Completion means a local native worker returned. Its provider result
        # remains explicit; it is never promoted to running/adopted/RPC ready.
        if not isinstance(row.get('result'), str) or len(row['result']) > 4096:
            raise ValueError('Bounded provider result required')
        return
    if row.get('passed') is not True:
        raise ValueError('Native phase did not pass')
    if phase == 'cut-seed':
        if (row.get('schema') != 'owned-rpc-target-legacy-handoff/1'
                or row.get('operation') != 'legacy-memory-cut-seed-v1'
                or row.get('manifest') != config['input']['binding']['sha256']
                or row.get('providerFenced') is not False or row.get('vmsChanged') is not False):
            raise ValueError('Cut/seed result differs')
        seed = row['inventory']['seed']
        if (seed.get('schema') != 'legacy-pool-seed/2' or seed.get('boot') != original['windowsBoot']
                or seed.get('manifest') != row['manifest']
                or seed.get('creationMode') != 'retained-fenced-rpc-only/1'
                or any(seed.get(k) is not False for k in ('providerSettled', 'capacityAdmitted', 'reservationMayRelease'))):
            raise ValueError('Actual seed completion absent')
    else:
        if (row.get('schema') != 'owned-rpc-target-definition/1' or row.get('operation') != phase
                or row.get('plan') != config['input']['binding']['sha256'] or row.get('startAuthorized') is not False):
            raise ValueError('Definition/boot result differs')
        result = row['result']
        guid(result['guid'])
        if (result.get('startAuthorized') is not False
                or result.get('state') != ('defined-owned-off' if phase == 'define' else 'configured-owned-off')
                or result.get('definitionSettled' if phase == 'define' else 'bootConfigured') is not True):
            raise ValueError('Unsettled provider outcome remains held')


def execute(config):
    exact(config, ('clock', 'transport', 'phase', 'nonce', 'binaries', 'observation', 'input', 'previous'))
    phase = config['phase']
    if phase not in PHASES:
        raise ValueError('Only fixed one-shot startup phases are supported')
    original = c.validate(config['clock'])
    journal = c.directory(Path(config['clock']['path']).parent)
    c.hex32(config['nonce'])
    if config['nonce'] in (original['attempt'], original['vmAttempt']):
        raise ValueError('Separate one-shot worker nonce required')
    previous = validate_previous(config, original, journal)
    binaries = config['binaries']
    exact(binaries, ('controller', 'entry', 'cleanup') if phase == 'start-once' else ('controller', 'entry'))
    for key, filename in zip(('controller', 'entry'), IMAGES[phase]):
        image(binaries[key], filename)
    if phase == 'start-once':
        image(binaries['cleanup'], 'cleanup-controller.exe')
    obs_raw = staged(config['observation'], 'observation.json')
    observation(obs_raw, original)
    raw = staged(config['input'], 'handoff.json' if phase == 'cut-seed' else 'definition-plan.txt')
    if phase == 'cut-seed':
        manifest = c.protocol.decode(raw)
        if manifest.get('schema') != 'legacy-memory-handoff/2' or manifest['boot'] != original['windowsBoot']:
            raise ValueError('Original boot handoff required')
    else:
        plan = definition(raw, original)
        if phase == 'define':
            if plan[3] != config['observation']['binding']['sha256']:
                raise ValueError('Original definition admission differs')
            # Admission must identify the actual preceding cut/seed namespace.
            admission = c.protocol.decode(obs_raw)
            cut = admission['legacyCutSeed']
            native = cut_native(previous)
            seed = native['inventory']['seed']
            if (cut['contractPath'] != native['root'] + '\\contract.txt'
                    or cut['manifestHash'] != native['manifest']
                    or admission['sharedPhysicalPool']['configPath'] != seed['configPath']
                    or admission['sharedPhysicalPool']['configHash'] != seed['poolHash']
                    or admission['sharedPhysicalPool']['capacityBytes'] != seed['capacityBytes']):
                raise ValueError('Definition admission belongs to a different cut/seed')
            if previous.get('schema') == 'owned-rpc-retained-cut/1' and admission.get('unsubmittedPredecessor') != previous['unsubmittedPredecessor']:
                raise ValueError('Successor omitted or changed native predecessor guard')
        else:
            request = c.protocol.decode(c.read(Path(config['previous']['path']).parent / 'request.json'))
            if request['input']['binding']['sha256'] != config['input']['binding']['sha256']:
                raise ValueError('Original definition plan changed between phases')
            vm_root = plan[5]
            if config['input']['path'] != vm_root + '\\definition-plan.txt':
                raise ValueError('Existing exact VM plan required after definition')
        if phase == 'start-once' and (plan[4] != binaries['entry']['sha256']
                or c.protocol.decode(obs_raw)['startupCleanup']['imageHash'] != binaries['cleanup']['sha256']):
            raise ValueError('Provider or independent cleanup image differs')
    root = journal / ('windows-' + phase)
    argv, known = transport(config['transport'], root)
    if c.remaining(config['clock']) < 5:
        raise TimeoutError('Insufficient original startup time')
    # A fixed phase directory prevents replay with a different nonce/config,
    # even if the first response or local publication was lost.
    root.mkdir(mode=0o700)
    c.sync_directory(journal)
    request = c.write_new(root / 'request.json', c.encode(config))
    c.write_new(root / 'known-hosts', known)
    c.write_new(root / 'sample.intent', c.encode({'requestSha256': request['sha256']}))
    t = config['transport']
    # Canonical path validation excludes whitespace/metacharacters; do not turn
    # the executable into a PowerShell string expression with unnecessary quotes.
    sample_command = t['samplerPath'] + ' ' + config['nonce'] + ' ' + original['vmAttempt'] + ' ' + t['samplerSha256']
    began = time.monotonic_ns()
    sample_raw = exchange_recorded(root, 'sample', argv + [sample_command], min(3, c.remaining(config['clock'])))
    sample = c.protocol.decode(sample_raw)
    exact(sample, ('schema', 'attempt', 'vmAttempt', 'windowsBoot', 'monotonicMilliseconds'))
    if (sample['schema'] != 'owned-rpc-windows-clock/1' or sample['attempt'] != config['nonce']
            or sample['vmAttempt'] != original['vmAttempt'] or sample['windowsBoot'] != original['windowsBoot']):
        raise ValueError('Fresh worker clock identity differs')
    origin = c.integer(sample['monotonicMilliseconds'])
    deadline = min(origin + 30000, original['windowsDeadlineMilliseconds'])
    if origin < original['windowsOriginMilliseconds'] or deadline - origin < 2000:
        raise TimeoutError('Worker lease outside original startup window')
    c.write_new(root / 'sample.json', sample_raw)
    entry = [binaries['entry']['path'], binaries['entry']['sha256']]
    obs = [config['observation']['path'], config['observation']['binding']['sha256']]
    inputs = [config['input']['path'], config['input']['binding']['sha256']]
    if phase == 'start-once':
        arguments = entry + [binaries['cleanup']['path'], binaries['cleanup']['sha256']] + inputs + obs + ['start-once', config['nonce']]
    else:
        operation = 'legacy-memory-cut-seed-v1' if phase == 'cut-seed' else phase
        arguments = entry + [config['nonce'], operation] + obs + inputs
    # Paths admit no spaces/quotes/metacharacters, and all remaining values are
    # validated fixed operations, hex or decimal. No shell program is composed.
    command = ' '.join([binaries['controller']['path'], '--target', *arguments, str(origin), str(deadline)])
    if time.monotonic_ns() - began >= 3_000_000_000:
        raise TimeoutError('Fresh worker bootstrap budget consumed')
    c.validate(config['clock'])
    if c.read_pinned(config['input']['binding']) != raw or c.read_pinned(config['observation']['binding']) != obs_raw:
        raise ValueError('Phase input changed before submission')
    c.write_new(root / 'submit.intent', c.encode({'requestSha256': request['sha256'], 'command': command,
                                               'origin': origin, 'deadline': deadline, 'outcome': 'unresolved'}))
    reply = exchange_recorded(root, 'submit', argv + [command], min(32, c.remaining(config['clock'])))
    response = c.write_new(root / 'response.json', reply)
    row = c.protocol.decode(reply)
    validate_reply(row, phase, config, original, origin, deadline)
    if phase == 'boot' and row['result']['guid'] != previous['native']['result']['guid']:
        raise ValueError('Boot result changed the defined VM identity')
    c.validate(config['clock'])
    if c.read_pinned(config['input']['binding']) != raw or c.read_pinned(config['observation']['binding']) != obs_raw:
        raise ValueError('Phase input changed during submission')
    result = {'schema': 'owned-rpc-windows-transition/1', 'phase': phase, 'clock': config['clock'],
              'attempt': original['attempt'], 'vmAttempt': original['vmAttempt'],
              'requestSha256': request['sha256'], 'responseSha256': response['sha256'],
              'previous': config['previous'], 'native': row, 'completed': True,
              'rpcReady': False, 'remoteDeathProven': False, 'reservationMayRelease': False}
    return c.write_new(root / 'RESULT.json', c.encode(result))


def exchange_recorded(root, stage, argv, seconds):
    """Retain failed transport evidence in the already-private consumed phase.

    Neither output nor process exit establishes native settlement. Do not emit
    remote text to logs: these exclusive 0600 records remain private journals.
    """
    if stage not in ('sample', 'submit'):
        raise ValueError('Fixed transport evidence stage required')
    try:
        return delivery.exchange(argv, b'', seconds)
    except delivery.ExchangeFailure as error:
        c.write_new(root / (stage + '.failure.json'), c.encode({
            'schema': 'owned-rpc-transport-failure/1', 'stage': stage,
            'reason': error.reason, 'returncode': error.returncode,
            'stdoutBase64': base64.b64encode(error.stdout).decode('ascii'),
            'stderrBase64': base64.b64encode(error.stderr).decode('ascii'),
            'automaticRetry': False, 'remoteDeathProven': False,
            'reservationMayRelease': False, 'rpcReady': False}))
        raise



def cut_native(row):
    return row['retainedNative'] if row.get('schema') == 'owned-rpc-retained-cut/1' else row['native']


def cut_evidence(native, request, original, bindings):
    exact(bindings, ('contract', 'activation', 'complete'))
    evidence = {name: c.read_pinned(pin) for name, pin in bindings.items()}
    contract = '\n'.join(['owned-rpc-legacy-handoff-v1', request['nonce'], original['windowsBoot'],
                         str(native['origin']), str(native['deadline']), request['binaries']['entry']['sha256'],
                         'legacy-memory-cut-seed-v1', native['manifest'], '']).encode()
    if (evidence['contract'] != contract or c.protocol.decode(evidence['activation']) != native['inventory']['seed']
            or evidence['complete'] != c.protocol.sha(evidence['activation']).encode('ascii')):
        raise ValueError('Exact native contract/activation/completion evidence differs')
    return evidence


def retained_source(retained, successor_binding, channel):
    """Historical evidence only: Windows must still prove no provider call.

    Only a first expired definition is supported. No local reply, exit status or
    absence of a file on this host establishes remote settlement or exact death.
    """
    exact(retained, ('clock', 'cutResult', 'collectedCut'))
    old = c.inspect_historical(retained['clock']);new = c.validate(successor_binding)
    if (old['bootId'] != new['bootId'] or old['windowsBoot'] != new['windowsBoot']
            or old['attempt'] == new['attempt'] or old['vmAttempt'] == new['vmAttempt'] or old['instance'] == new['instance']
            or old['deadlineMonotonicNs'] > new['originMonotonicNs'] or old['deadlineUtcNs'] > new['createdUtcNs']
            or old['windowsDeadlineMilliseconds'] > new['windowsOriginMilliseconds']):
        raise ValueError('Distinct successor after expired predecessor on original boots required')
    journal = c.directory(Path(retained['clock']['path']).parent)
    cut = validate_previous({'phase': 'define', 'previous': retained['cutResult'], 'clock': retained['clock'],
                             'transport': channel, 'nonce': new['vmAttempt']}, old, journal)
    if cut.get('schema') != 'owned-rpc-windows-transition/1':raise ValueError('Original completed cut required')
    request = c.protocol.decode(c.read(journal / 'windows-cut-seed' / 'request.json'))
    if request['clock'] != retained['clock'] or request['phase'] != 'cut-seed' or request['previous'] is not None:
        raise ValueError('Original cut request lineage differs')
    native = cut['native'];validate_reply(native, 'cut-seed', request, old, native['origin'], native['deadline'])
    submit = c.protocol.decode(c.read(journal / 'windows-cut-seed' / 'submit.intent'))
    if ((submit['origin'], submit['deadline']) != (native['origin'], native['deadline'])
            or not old['windowsOriginMilliseconds'] <= native['origin'] < native['deadline'] <= old['windowsDeadlineMilliseconds']
            or native['deadline'] - native['origin'] > 30000):raise ValueError('Original cut interval differs')
    # Re-read the authenticated collection, not caller-created evidence bytes.
    folder = journal / 'windows-files-collect-cut'
    if retained['collectedCut'].get('path') != str(folder / 'RESULT.json'):raise ValueError('Exact original cut collection required')
    collected = c.protocol.decode(c.read_pinned(retained['collectedCut']))
    cfg = c.protocol.decode(c.read(folder / 'configuration.json'))
    wire = c.read(folder / 'request.json');wire_row = c.protocol.decode(wire)
    sent = c.protocol.decode(c.read(folder / 'submit.intent'))
    if (collected.get('schema') != 'owned-rpc-windows-files/1' or collected['clock'] != retained['clock']
            or collected['result']['cutResult'] != retained['cutResult']
            or any(collected.get(k) is not False for k in ('rpcReady', 'remoteDeathProven', 'reservationMayRelease'))
            or cfg['clock'] != retained['clock'] or cfg['transport'] != channel or cfg['cutResult'] != retained['cutResult']
            or collected['response']['path'] != str(folder / 'response.json') or sent['requestSha256'] != c.protocol.sha(wire)):
        raise ValueError('Original authenticated collection lineage differs')
    reply = c.protocol.decode(c.read_pinned(collected['response']))
    if (reply.get('schema') != 'owned-rpc-transition-files-result/1' or reply.get('operation') != 'collect-cut'
            or reply.get('nonce') != cfg['nonce'] or reply.get('requestHash') != c.protocol.sha(wire)
            or reply.get('windowsBoot') != old['windowsBoot'] or reply.get('vmAttempt') != old['vmAttempt']
            or (reply.get('origin'), reply.get('deadline')) != (sent['origin'], sent['deadline'])
            or any(reply.get(k) is not False for k in ('vmChanged', 'rpcReady', 'reservationMayRelease'))):
        raise ValueError('Original authenticated collection response differs')
    bindings = collected['result']['cutEvidence'];evidence = cut_evidence(native, request, old, bindings)
    payload = {'root': native['root'], 'contractHash': c.protocol.sha(evidence['contract']), 'activation': native['inventory']['seed']}
    if wire_row != {'schema': 'owned-rpc-transition-files/1', 'operation': 'collect-cut', 'nonce': cfg['nonce'],
                    'windowsBoot': old['windowsBoot'], 'vmAttempt': old['vmAttempt'],
                    'origin': old['windowsOriginMilliseconds'], 'deadline': old['windowsDeadlineMilliseconds'],
                    'payload': payload} or reply['result'].get('root') != native['root']:
        raise ValueError('Original collected namespace differs')
    records = reply['result']['files']
    if not isinstance(records, list) or len(records) != 3:raise ValueError('Exact collected records required')
    actual = {}
    for record in records:
        exact(record, ('name', 'bytes', 'sha256', 'base64'));raw = base64.b64decode(record['base64'], validate=True)
        if record['name'] in actual or len(raw) != record['bytes'] or c.protocol.sha(raw) != record['sha256']:
            raise ValueError('Original collected bytes changed')
        actual[record['name']] = raw
    names = ('contract.txt', 'pool.activation', 'pool.complete');keys = ('contract', 'activation', 'complete')
    if actual != dict(zip(names, (evidence[k] for k in keys))):raise ValueError('Original collected evidence differs')
    for key, name in zip(keys, names):
        if bindings[key]['path'] != str(folder / name):raise ValueError('Original collected file location differs')
    # Bind the consumed definition command to its exact native worker contract.
    prior_folder = journal / 'windows-define';prior_raw = c.read(prior_folder / 'request.json');prior = c.protocol.decode(prior_raw)
    exact(prior, ('clock', 'transport', 'phase', 'nonce', 'binaries', 'observation', 'input', 'previous'))
    if (prior['clock'] != retained['clock'] or prior['transport'] != channel or prior['phase'] != 'define'
            or prior['previous'] != retained['cutResult'] or prior['nonce'] in (request['nonce'], new['attempt'], new['vmAttempt'])):
        raise ValueError('Original definition request differs')
    c.hex32(prior['nonce']);exact(prior['binaries'], ('controller', 'entry'))
    for key, filename in zip(('controller', 'entry'), IMAGES['define']):image(prior['binaries'][key], filename)
    plan_raw = staged(prior['input'], 'definition-plan.txt');plan = definition(plan_raw, old)
    observed_raw = staged(prior['observation'], 'observation.json');observed = observation(observed_raw, old)
    if (plan[3] != c.protocol.sha(observed_raw) or 'unsubmittedPredecessor' in observed
            or observed['legacyCutSeed']['contractHash'] != c.protocol.sha(evidence['contract'])
            or observed['legacyCutSeed']['activationHash'] != c.protocol.sha(evidence['activation'])
            or observed['sharedPhysicalPool']['configHash'] != native['inventory']['seed']['poolHash']):
        raise ValueError('Original definition does not bind original cut')
    sent = c.protocol.decode(c.read(prior_folder / 'submit.intent'));origin, deadline = c.integer(sent['origin']), c.integer(sent['deadline'])
    if (sent['requestSha256'] != c.protocol.sha(prior_raw) or sent['outcome'] != 'unresolved'
            or not old['windowsOriginMilliseconds'] <= origin < deadline <= old['windowsDeadlineMilliseconds'] or deadline - origin > 30000):
        raise ValueError('Original definition submit interval differs')
    args = [prior['binaries']['controller']['path'], '--target', prior['binaries']['entry']['path'], prior['binaries']['entry']['sha256'],
            prior['nonce'], 'define', prior['observation']['path'], prior['observation']['binding']['sha256'],
            prior['input']['path'], prior['input']['binding']['sha256'], str(origin), str(deadline)]
    if sent['command'] != ' '.join(args):raise ValueError('Original definition submitted command differs')
    for path in (prior_folder / 'RESULT.json', journal / 'windows-boot', journal / 'windows-start-once', journal / 'windows-files-copy-media'):
        if path.exists() or path.is_symlink():raise ValueError('Later original definition/boot state remains held')
    worker = '\n'.join(['owned-rpc-definition-worker-v1', prior['nonce'], old['windowsBoot'], str(origin), str(deadline),
                        prior['binaries']['entry']['sha256'], 'define', plan[5] + '\\definition-plan.txt', c.protocol.sha(plan_raw), '']).encode()
    guard = {'schema': 'owned-rpc-unsubmitted-predecessor/1',
             'contractPath': 'C:\\EnclaveRpcDefinition-' + prior['nonce'] + '\\' + prior['nonce'] + '\\contract.txt',
             'contractHash': c.protocol.sha(worker), 'producerHash': prior['binaries']['entry']['sha256']}
    c.validate(successor_binding)
    return {'retainedNative': native, 'cutEvidence': bindings, 'unsubmittedPredecessor': guard,
            'priorDefinitionRequestSha256': c.protocol.sha(prior_raw), 'priorWorkerNonce': prior['nonce'], 'priorCutNonce': request['nonce']}


def adopt_retained_cut(config):
    """Publish one explicit local adoption; no native cut or provider call."""
    exact(config, ('clock', 'transport', 'retained'));source = retained_source(config['retained'], config['clock'], config['transport'])
    original = c.validate(config['clock']);parent = c.directory(Path(config['clock']['path']).parent);root = parent / 'retained-cut'
    root.mkdir(mode=0o700);c.sync_directory(parent)
    request = c.write_new(root / 'request.json', c.encode(config))
    c.write_new(root / 'adopt.intent', c.encode({'requestSha256': request['sha256']}))
    if retained_source(config['retained'], config['clock'], config['transport']) != source:raise ValueError('Retained evidence changed during adoption')
    return c.write_new(root / 'RESULT.json', c.encode({'schema': 'owned-rpc-retained-cut/1', 'clock': config['clock'],
        'attempt': original['attempt'], 'vmAttempt': original['vmAttempt'], 'requestSha256': request['sha256'], **source,
        'nativeCutSubmitted': False, 'nativePredecessorVerified': False, 'capacityAdmitted': False, 'rpcReady': False, 'reservationMayRelease': False}))


def validate_retained_cut(binding, clock, channel, nonce):
    original = c.validate(clock);folder = c.directory(Path(clock['path']).parent) / 'retained-cut'
    if binding.get('path') != str(folder / 'RESULT.json'):raise ValueError('Exact successor retained-cut receipt required')
    row = c.protocol.decode(c.read_pinned(binding));request_raw = c.read(folder / 'request.json');request = c.protocol.decode(request_raw)
    exact(request, ('clock', 'transport', 'retained'))
    if request['clock'] != clock or request['transport'] != channel:raise ValueError('Retained cut channel or successor clock differs')
    if c.protocol.decode(c.read(folder / 'adopt.intent')) != {'requestSha256': c.protocol.sha(request_raw)}:
        raise ValueError('Consumed retained cut intent differs')
    source = retained_source(request['retained'], clock, channel)
    if nonce in (source['priorWorkerNonce'], source['priorCutNonce']):raise ValueError('Original worker nonce must not be reused')
    expected = {'schema': 'owned-rpc-retained-cut/1', 'clock': clock, 'attempt': original['attempt'], 'vmAttempt': original['vmAttempt'],
        'requestSha256': c.protocol.sha(request_raw), **source, 'nativeCutSubmitted': False, 'nativePredecessorVerified': False,
        'capacityAdmitted': False, 'rpcReady': False, 'reservationMayRelease': False}
    if row != expected:raise ValueError('Retained cut receipt differs from original evidence')
    return row

def prepare_definition(config):
    """Bind actual cut evidence into the original Off-only definition inputs.

    The three evidence files must be collected over the authenticated owner
    channel from the completed protected native handoff namespace. Their exact
    bytes are retained, not reconstructed by reserializing a receipt object.
    Native definition independently reopens that namespace and validates them.
    """
    exact(config, ('clock', 'cutResult', 'cutEvidence', 'observation', 'media',
                   'providerSha256', 'cleanupSha256', 'network'))
    original = c.validate(config['clock'])
    journal = c.directory(Path(config['clock']['path']).parent)
    retained = config['cutResult'].get('path') == str(journal / 'retained-cut' / 'RESULT.json')
    if retained:
        source_request = c.protocol.decode(c.read(journal / 'retained-cut' / 'request.json'))
        cut = validate_retained_cut(config['cutResult'], config['clock'], source_request['transport'], original['vmAttempt'])
        if config['cutEvidence'] != cut['cutEvidence']:
            raise ValueError('Successor must retain exact original collected evidence')
        historical = source_request['retained']
        old = c.inspect_historical(historical['clock'])
        request = c.protocol.decode(c.read(Path(historical['cutResult']['path']).parent / 'request.json'))
    else:
        result_path = journal / 'windows-cut-seed' / 'RESULT.json'
        if config['cutResult'].get('path') != str(result_path):raise ValueError('Original cut result required')
        request = c.protocol.decode(c.read(result_path.parent / 'request.json'))
        cut = validate_previous({'phase': 'define', 'previous': config['cutResult'], 'clock': config['clock'],
                                'transport': request['transport'], 'nonce': original['vmAttempt']}, original, journal)
        old = original
    native = cut_native(cut)
    validate_reply(native, 'cut-seed', request, old, native['origin'], native['deadline'])
    evidence = cut_evidence(native, request, old, config['cutEvidence'])
    activation = c.protocol.decode(evidence['activation'])
    activation_hash = c.protocol.sha(evidence['activation'])
    c.protocol.digest(activation['poolHash'])
    windows_path(activation['configPath'], 'pool.txt')
    c.integer(activation['capacityBytes'])
    obs_raw = c.read_pinned(config['observation'])
    admission = observation(obs_raw, original)
    if any(key in admission for key in ('legacyCutSeed', 'sharedPhysicalPool', 'bootNetwork', 'startupCleanup', 'unsubmittedPredecessor')):
        raise ValueError('Observation must not contain preexisting admission bindings')
    for key in ('providerSha256', 'cleanupSha256'):
        c.protocol.digest(config[key])
    network = config['network']
    exact(network, ('schema', 'switchGuid', 'mac'))
    if network['schema'] != 'owned-rpc-boot-network/1' or not re.fullmatch('02[0-9A-F]{10}', network['mac']):
        raise ValueError('Exact reviewed boot network required')
    guid(network['switchGuid'])
    media_raw = c.read_pinned(config['media'])
    media = c.protocol.decode(media_raw)
    if (media.get('schema') != 'rpc-staged-client-media-binding/1' or media.get('instance') != original['instance']
            or not isinstance(media.get('files'), list) or len(media['files']) != 2):
        raise ValueError('Original complete guest media binding required')
    files = {}
    for row in media['files']:
        exact(row, ('name', 'bytes', 'sha256', 'privateAcl'))
        if row['name'] not in ('boot.vhdx', 'seed.iso') or row['name'] in files or row['privateAcl'] is not True:
            raise ValueError('Protected original media pair required')
        c.protocol.digest(row['sha256'])
        if not 1 <= c.integer(row['bytes']) <= (4294967296 if row['name'] == 'boot.vhdx' else 67108864):
            raise ValueError('Reviewed media growth limit exceeded')
        files[row['name']] = row
    admission.update(
        legacyCutSeed={'schema': 'legacy-cut-seed-admission/1',
                       'contractPath': native['root'] + '\\contract.txt',
                       'contractHash': c.protocol.sha(evidence['contract']), 'activationHash': activation_hash,
                       'manifestHash': native['manifest'], 'producerHash': request['binaries']['entry']['sha256'],
                       'creationMode': 'retained-fenced-rpc-only/1'},
        sharedPhysicalPool={'schema': 'host-physical-pool-binding/1', 'configPath': activation['configPath'],
                            'configHash': activation['poolHash'], 'capacityBytes': activation['capacityBytes']},
        bootNetwork=dict(network),
        startupCleanup={'schema': 'owned-rpc-startup-cleanup/1', 'imageHash': config['cleanupSha256'],
                        'reservedBytes': 192 * 1048576})
    if retained:admission['unsubmittedPredecessor'] = cut['unsubmittedPredecessor']
    admission_raw = c.encode(admission)
    vm_root = 'C:\\EnclaveRpcVm-' + original['vmAttempt'] + '\\' + original['vmAttempt']
    plan = '\n'.join(['owned-rpc-definition/1', original['vmAttempt'], original['windowsBoot'],
                      c.protocol.sha(admission_raw), config['providerSha256'], vm_root,
                      str(original['windowsOriginMilliseconds']), str(original['windowsDeadlineMilliseconds']),
                      files['boot.vhdx']['sha256'], files['seed.iso']['sha256'],
                      'generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false', '']).encode()
    definition(plan, original)
    c.validate(config['clock'])
    root = journal / 'definition-inputs'
    root.mkdir(mode=0o700)
    c.sync_directory(journal)
    c.write_new(root / 'prepare.intent', c.encode(config))
    admission_binding = c.write_new(root / 'observation.json', admission_raw)
    plan_binding = c.write_new(root / 'definition-plan.txt', plan)
    for name, raw in evidence.items():
        if c.read_pinned(config['cutEvidence'][name]) != raw:
            raise ValueError('Native evidence changed during preparation')
    if c.read_pinned(config['observation']) != obs_raw or c.read_pinned(config['media']) != media_raw:
        raise ValueError('Observation or media changed during preparation')
    c.read_pinned(config['cutResult'])
    if retained:validate_retained_cut(config['cutResult'], config['clock'], source_request['transport'], original['vmAttempt'])
    c.validate(config['clock'])
    return c.write_new(root / 'RESULT.json', c.encode({
        'schema': 'owned-rpc-definition-inputs/1', 'clock': config['clock'], 'cutResult': config['cutResult'],
        'admission': admission_binding, 'plan': plan_binding, 'vmRoot': vm_root,
        'media': config['media'], 'nativeDefinitionSubmitted': False, 'rpcReady': False,
        'capacityAdmitted': False, 'reservationMayRelease': False}))
