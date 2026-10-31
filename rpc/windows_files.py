"""Owner adapters for the bounded native TransitionFiles executable.

All executable paths must already have qualified protected Windows custody.
Call inside an admitted owner envelope. No private media bytes cross this
transport, and no result proves VM state, remote death or RPC readiness.
"""
import base64
import importlib.util
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('windows_transition', Path(__file__).with_name('windows_transition.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
c = w.c


def common(config, extra):
    w.exact(config, ('clock', 'transport', 'helper', 'nonce', *extra))
    original = c.validate(config['clock'])
    c.hex32(config['nonce'])
    if config['nonce'] in (original['attempt'], original['vmAttempt']):
        raise ValueError('Separate file operation nonce required')
    w.image(config['helper'], 'transition-files.exe')
    return original


def call(config, original, operation, journal_name, payload):
    journal = c.directory(Path(config['clock']['path']).parent)
    root = journal / ('windows-files-' + journal_name)
    argv, known = w.transport(config['transport'], root)
    if c.remaining(config['clock']) < 5:
        raise TimeoutError('Insufficient original startup time')
    root.mkdir(mode=0o700)
    c.sync_directory(journal)
    c.write_new(root / 'configuration.json', c.encode(config))
    c.write_new(root / 'known-hosts', known)
    wire = {'schema': 'owned-rpc-transition-files/1', 'operation': operation, 'nonce': config['nonce'],
            'windowsBoot': original['windowsBoot'], 'vmAttempt': original['vmAttempt'],
            'origin': original['windowsOriginMilliseconds'], 'deadline': original['windowsDeadlineMilliseconds'],
            'payload': payload}
    raw = c.encode(wire)
    if len(raw) > 65536:
        raise ValueError('Native request byte bound')
    request = c.write_new(root / 'request.json', raw)
    c.write_new(root / 'sample.intent', c.encode({'request': request}))
    t = config['transport']
    command = '"' + t['samplerPath'] + '" ' + config['nonce'] + ' ' + original['vmAttempt'] + ' ' + t['samplerSha256']
    began = time.monotonic_ns()
    sample_raw = w.delivery.exchange(argv + [command], b'', min(3, c.remaining(config['clock'])))
    sample = c.protocol.decode(sample_raw)
    w.exact(sample, ('schema', 'attempt', 'vmAttempt', 'windowsBoot', 'monotonicMilliseconds'))
    if (sample['schema'] != 'owned-rpc-windows-clock/1' or sample['attempt'] != config['nonce']
            or sample['vmAttempt'] != original['vmAttempt'] or sample['windowsBoot'] != original['windowsBoot']):
        raise ValueError('Fresh file worker clock identity differs')
    origin = c.integer(sample['monotonicMilliseconds'])
    deadline = min(origin + 30000, original['windowsDeadlineMilliseconds'])
    if origin < original['windowsOriginMilliseconds'] or deadline - origin < 2000:
        raise TimeoutError('Native file lease outside original window')
    c.write_new(root / 'sample.json', sample_raw)
    command = ' '.join([config['helper']['path'], '--target', operation, config['nonce'], original['windowsBoot'],
                        str(origin), str(deadline), config['helper']['sha256']])
    if time.monotonic_ns() - began >= 3_000_000_000:
        raise TimeoutError('Native file bootstrap budget consumed')
    c.validate(config['clock'])
    c.write_new(root / 'submit.intent', c.encode({'requestSha256': request['sha256'], 'command': command,
                                                'origin': origin, 'deadline': deadline, 'outcome': 'unresolved'}))
    reply = w.delivery.exchange(argv + [command], raw, min(32, c.remaining(config['clock'])))
    response = c.write_new(root / 'response.json', reply)
    row = c.protocol.decode(reply)
    if (row.get('schema') != 'owned-rpc-transition-files-result/1' or row.get('operation') != operation
            or row.get('nonce') != config['nonce'] or row.get('requestHash') != request['sha256']
            or row.get('windowsBoot') != original['windowsBoot'] or row.get('vmAttempt') != original['vmAttempt']
            or row.get('origin') != origin or row.get('deadline') != deadline
            or any(row.get(k) is not False for k in ('vmChanged', 'rpcReady', 'reservationMayRelease'))):
        raise ValueError('Native file result binding differs')
    env = row['envelope']
    if (env.get('MembershipVerified') is not True or env.get('LimitsVerified') is not True
            or env.get('JobCommitLimitBytes') != 128*1048576
            or not 0 < c.integer(env.get('BootstrapPrivateBytes')) <= 64*1048576
            or c.integer(row.get('pid')) == 0 or c.integer(row.get('creation')) == 0
            or env.get('ProcessId') != row['pid'] or env.get('CreationFileTime') != row['creation']):
        raise ValueError('Native file process/envelope differs')
    c.validate(config['clock'])
    return root, row['result'], response


def complete(root, config, result, response):
    c.validate(config['clock'])
    return c.write_new(root / 'RESULT.json', c.encode({
        'schema': 'owned-rpc-windows-files/1', 'clock': config['clock'], 'response': response,
        'result': result, 'rpcReady': False, 'remoteDeathProven': False, 'reservationMayRelease': False}))


def collect_cut(config):
    original = common(config, ('cutResult',))
    journal = c.directory(Path(config['clock']['path']).parent)
    cut = w.validate_previous({'phase': 'define', 'previous': config['cutResult'], 'clock': config['clock'],
                               'transport': config['transport'], 'nonce': config['nonce']}, original, journal)
    request = c.protocol.decode(c.read(Path(config['cutResult']['path']).parent / 'request.json'))
    native = cut['native']
    contract = '\n'.join(['owned-rpc-legacy-handoff-v1', request['nonce'], original['windowsBoot'],
                          str(native['origin']), str(native['deadline']), request['binaries']['entry']['sha256'],
                          'legacy-memory-cut-seed-v1', native['manifest'], '']).encode()
    payload = {'root': native['root'], 'contractHash': c.protocol.sha(contract), 'activation': native['inventory']['seed']}
    root, result, response = call(config, original, 'collect-cut', 'collect-cut', payload)
    if result.get('root') != native['root']:
        raise ValueError('Collected namespace differs')
    records = result.get('files')
    if not isinstance(records, list) or len(records) != 3:
        raise ValueError('Exact three cut files required')
    files = {}
    for row in records:
        w.exact(row, ('name', 'bytes', 'sha256', 'base64'))
        if row['name'] not in ('contract.txt', 'pool.activation', 'pool.complete') or row['name'] in files:
            raise ValueError('Fixed cut evidence filenames required')
        c.protocol.digest(row['sha256'])
        raw = base64.b64decode(row['base64'], validate=True)
        if not 0 < len(raw) <= 4096 or len(raw) != row['bytes'] or c.protocol.sha(raw) != row['sha256']:
            raise ValueError('Exact collected bytes differ')
        files[row['name']] = raw
    if (files['contract.txt'] != contract or c.protocol.decode(files['pool.activation']) != payload['activation']
            or files['pool.complete'] != c.protocol.sha(files['pool.activation']).encode('ascii')):
        raise ValueError('Native completed cut evidence differs')
    evidence = {key: c.write_new(root / name, files[name]) for key, name in
                [('contract', 'contract.txt'), ('activation', 'pool.activation'), ('complete', 'pool.complete')]}
    return complete(root, config, {'cutResult': config['cutResult'], 'cutEvidence': evidence}, response)


def stage_inputs(config):
    original = common(config, ('phase', 'files'))
    if config['phase'] not in w.PHASES:
        raise ValueError('Fixed startup phase required')
    names = {'observation.json', 'definition-plan.txt'} if config['phase'] == 'define' else {'observation.json'}
    if not isinstance(config['files'], dict) or set(config['files']) != names:
        raise ValueError('Fixed phase input files required')
    files = {}
    for name, binding in config['files'].items():
        raw = c.read_pinned(binding)
        if len(raw) > (32768 if name == 'observation.json' else 4096):
            raise ValueError('Native staged file bound')
        files[name] = raw
    w.observation(files['observation.json'], original)
    if 'definition-plan.txt' in files and w.definition(files['definition-plan.txt'], original)[3] != c.protocol.sha(files['observation.json']):
        raise ValueError('Definition input admission differs')
    payload = {'files': [{'name': name, 'bytes': len(raw), 'sha256': c.protocol.sha(raw),
                         'base64': base64.b64encode(raw).decode()} for name, raw in files.items()]}
    # Native input shape deliberately omits redundant sizes; native decoded
    # byte bounds and digest checks are authoritative for staged bytes.
    for row in payload['files']: del row['bytes']
    root, result, response = call(config, original, 'stage-inputs', 'stage-' + config['phase'], payload)
    remote = 'C:\\EnclaveRpcInputs-' + config['nonce'] + '\\' + config['nonce']
    if result.get('root') != remote or len(result.get('files', [])) != len(files):
        raise ValueError('Staged namespace or file set differs')
    verified = {}
    for row in result['files']:
        w.exact(row, ('name', 'bytes', 'sha256'))
        name = row['name']
        if name not in files or name in verified or row['bytes'] != len(files[name]) or row['sha256'] != c.protocol.sha(files[name]):
            raise ValueError('Staged file readback differs')
        if c.read_pinned(config['files'][name]) != files[name]:
            raise ValueError('Owner staged input changed')
        verified[name] = {'path': remote + '\\' + name, 'binding': config['files'][name]}
    return complete(root, config, {'phase': config['phase'], 'files': verified}, response)


def copy_media(config):
    original = common(config, ('definitionResult', 'preparedDefinition'))
    journal = c.directory(Path(config['clock']['path']).parent)
    defined = w.validate_previous({'phase': 'boot', 'previous': config['definitionResult'], 'clock': config['clock'],
                                   'transport': config['transport'], 'nonce': config['nonce']}, original, journal)
    prepared = c.protocol.decode(c.read_pinned(config['preparedDefinition']))
    if (prepared.get('schema') != 'owned-rpc-definition-inputs/1' or prepared.get('clock') != config['clock']
            or prepared['plan']['sha256'] != defined['native']['plan']
            or prepared['vmRoot'] != 'C:\\EnclaveRpcVm-' + original['vmAttempt'] + '\\' + original['vmAttempt']):
        raise ValueError('Original prepared/defined VM differs')
    plan = w.definition(c.read_pinned(prepared['plan']), original)
    media = c.protocol.decode(c.read_pinned(prepared['media']))
    if media.get('instance') != original['instance'] or media.get('schema') != 'rpc-staged-client-media-binding/1':
        raise ValueError('Original private media binding differs')
    rows = media.get('files')
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError('Original media pair required')
    expected = {row['name']: row for row in rows}
    if (set(expected) != {'boot.vhdx', 'seed.iso'} or expected['boot.vhdx']['sha256'] != plan[8]
            or expected['seed.iso']['sha256'] != plan[9] or any(row.get('privateAcl') is not True for row in rows)):
        raise ValueError('Definition media hashes/custody differ')
    payload = {'sourceRoot': media['root'], 'planHash': prepared['plan']['sha256']}
    root, result, response = call(config, original, 'copy-media', 'copy-media', payload)
    if (result.get('root') != prepared['vmRoot'] or result.get('sourceRoot') != media['root']
            or result.get('planHash') != prepared['plan']['sha256'] or result.get('definitionJournalBound') is not True
            or any(result.get(k) is not False for k in ('currentVmOffObserved', 'mediaAttached', 'privateContentsPrinted'))
            or not isinstance(result.get('files'), list) or len(result['files']) != 2):
        raise ValueError('Private media copy receipt differs')
    seen = set()
    for row in result['files']:
        w.exact(row, ('name', 'bytes', 'sha256'))
        name = row['name']
        if name not in expected or name in seen or any(row[k] != expected[name][k] for k in ('bytes', 'sha256')):
            raise ValueError('Private destination readback differs')
        seen.add(name)
    return complete(root, config, {'definitionResult': config['definitionResult'], 'preparedDefinition': config['preparedDefinition'],
                                    'mediaCopy': result}, response)
