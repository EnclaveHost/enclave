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
            seed = previous['native']['inventory']['seed']
            if (cut['contractPath'] != previous['native']['root'] + '\\contract.txt'
                    or cut['manifestHash'] != previous['native']['manifest']
                    or admission['sharedPhysicalPool']['configPath'] != seed['configPath']
                    or admission['sharedPhysicalPool']['configHash'] != seed['poolHash']
                    or admission['sharedPhysicalPool']['capacityBytes'] != seed['capacityBytes']):
                raise ValueError('Definition admission belongs to a different cut/seed')
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
    sample_command = '"' + t['samplerPath'] + '" ' + config['nonce'] + ' ' + original['vmAttempt'] + ' ' + t['samplerSha256']
    began = time.monotonic_ns()
    sample_raw = delivery.exchange(argv + [sample_command], b'', min(3, c.remaining(config['clock'])))
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
    reply = delivery.exchange(argv + [command], b'', min(32, c.remaining(config['clock'])))
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
    result_path = journal / 'windows-cut-seed' / 'RESULT.json'
    if config['cutResult'].get('path') != str(result_path):
        raise ValueError('Original cut result required')
    cut = c.protocol.decode(c.read_pinned(config['cutResult']))
    request = c.protocol.decode(c.read(result_path.parent / 'request.json'))
    # Reuse the full predecessor evidence verification without creating a phase.
    validate_previous({'phase': 'define', 'previous': config['cutResult'], 'clock': config['clock'],
                       'transport': request['transport'], 'nonce': original['vmAttempt']}, original, journal)
    native = cut['native']
    validate_reply(native, 'cut-seed', request, original, native['origin'], native['deadline'])
    exact(config['cutEvidence'], ('contract', 'activation', 'complete'))
    evidence = {name: c.read_pinned(pin) for name, pin in config['cutEvidence'].items()}
    expected_contract = '\n'.join(['owned-rpc-legacy-handoff-v1', request['nonce'], original['windowsBoot'],
                                  str(native['origin']), str(native['deadline']), request['binaries']['entry']['sha256'],
                                  'legacy-memory-cut-seed-v1', native['manifest'], '']).encode()
    activation = c.protocol.decode(evidence['activation'])
    activation_hash = c.protocol.sha(evidence['activation'])
    if (evidence['contract'] != expected_contract or activation != native['inventory']['seed']
            or evidence['complete'] != activation_hash.encode('ascii')):
        raise ValueError('Exact native contract/activation/completion evidence differs')
    c.protocol.digest(activation['poolHash'])
    windows_path(activation['configPath'], 'pool.txt')
    c.integer(activation['capacityBytes'])
    obs_raw = c.read_pinned(config['observation'])
    admission = observation(obs_raw, original)
    if any(key in admission for key in ('legacyCutSeed', 'sharedPhysicalPool', 'bootNetwork', 'startupCleanup')):
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
    c.validate(config['clock'])
    return c.write_new(root / 'RESULT.json', c.encode({
        'schema': 'owned-rpc-definition-inputs/1', 'clock': config['clock'], 'cutResult': config['cutResult'],
        'admission': admission_binding, 'plan': plan_binding, 'vmRoot': vm_root,
        'media': config['media'], 'nativeDefinitionSubmitted': False, 'rpcReady': False,
        'capacityAdmitted': False, 'reservationMayRelease': False}))
