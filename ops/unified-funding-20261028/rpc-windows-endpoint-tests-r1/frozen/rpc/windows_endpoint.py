"""Observe the original owned VM's endpoint once through its pinned owner channel.

Requires completed local startup transport evidence, not successful provider
settlement. Neither a returned address nor Running settles an ambiguous start.
Run in an admitted owner envelope; native image staging must be qualified first.
"""
import importlib.util
import ipaddress
from pathlib import Path
import re
import time

spec = importlib.util.spec_from_file_location('windows_transition', Path(__file__).with_name('windows_transition.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
c = w.c
MINIMUM_FREE = (18432 + 39388 + 256) * 1048576


def lineage(config, original):
    """Re-read all four exact consumed phase requests and authenticated replies."""
    journal = c.directory(Path(config['clock']['path']).parent)
    binding = config['startResult']
    rows, requests, nonces = {}, {}, set()
    for phase in reversed(w.PHASES):
        folder = journal / ('windows-' + phase)
        if not isinstance(binding, dict) or binding.get('path') != str(folder / 'RESULT.json'):
            raise ValueError('Exact original startup result chain required')
        row = c.protocol.decode(c.read_pinned(binding))
        if (row.get('schema') != 'owned-rpc-windows-transition/1' or row.get('phase') != phase
                or row.get('clock') != config['clock'] or row.get('attempt') != original['attempt']
                or row.get('vmAttempt') != original['vmAttempt'] or row.get('completed') is not True
                or any(row.get(k) is not False for k in ('rpcReady', 'remoteDeathProven', 'reservationMayRelease'))):
            raise ValueError('Original phase identity or claim differs')
        raw = c.read(folder / 'request.json')
        reply = c.read(folder / 'response.json')
        submit = c.protocol.decode(c.read(folder / 'submit.intent'))
        request = c.protocol.decode(raw)
        if (c.protocol.sha(raw) != row['requestSha256'] or c.protocol.sha(reply) != row['responseSha256']
                or submit['requestSha256'] != row['requestSha256'] or c.protocol.decode(reply) != row['native']
                or request['phase'] != phase or request['clock'] != config['clock']
                or request['transport'] != config['transport'] or request['previous'] != row['previous']):
            raise ValueError('Consumed startup evidence differs')
        c.hex32(request['nonce'])
        if request['nonce'] in nonces or request['nonce'] in (config['nonce'], original['attempt'], original['vmAttempt']):
            raise ValueError('Separate original phase nonces required')
        nonces.add(request['nonce'])
        origin, deadline = c.integer(submit['origin']), c.integer(submit['deadline'])
        if not original['windowsOriginMilliseconds'] <= origin < deadline <= original['windowsDeadlineMilliseconds'] or deadline-origin > 30000:
            raise ValueError('Phase changed original deadline')
        w.validate_reply(row['native'], phase, request, original, origin, deadline)
        w.observation(w.staged(request['observation'], 'observation.json'), original)
        if phase != 'cut-seed':
            w.validate_previous(request, original, journal)
        else:
            manifest = c.protocol.decode(w.staged(request['input'], 'handoff.json'))
            if (row['previous'] is not None or manifest.get('schema') != 'legacy-memory-handoff/2'
                    or manifest.get('boot') != original['windowsBoot']):
                raise ValueError('Original first phase manifest or predecessor differs')
        rows[phase], requests[phase] = row, request
        binding = row['previous']
    defined = rows['define']['native']['result']['guid']
    if rows['boot']['native']['result']['guid'] != defined:
        raise ValueError('Boot changed the defined VM')
    plan = w.definition(w.staged(requests['define']['input'], 'definition-plan.txt'), original)
    plan_hash = requests['define']['input']['binding']['sha256']
    for phase in ('boot', 'start-once'):
        if (requests[phase]['input']['path'] != plan[5] + '\\definition-plan.txt'
                or requests[phase]['input']['binding']['sha256'] != plan_hash
                or w.definition(w.staged(requests[phase]['input'], 'definition-plan.txt'), original) != plan):
            raise ValueError('Startup plan or original VM namespace changed')
    if plan[4] != requests['start-once']['binaries']['entry']['sha256']:
        raise ValueError('Original provider image differs')
    admission = c.protocol.decode(w.staged(requests['define']['observation'], 'observation.json'))
    if requests['define']['observation']['binding']['sha256'] != plan[3]:
        raise ValueError('Original definition admission differs')
    network = admission['bootNetwork']
    w.exact(network, ('schema', 'switchGuid', 'mac'))
    if network['schema'] != 'owned-rpc-boot-network/1' or not re.fullmatch('02[0-9A-F]{10}', network['mac']):
        raise ValueError('Original boot network identity required')
    w.guid(network['switchGuid'])
    # Byte-for-byte OwnedVmPermit.Encode, derived from the original definition
    # and exact returned GUID. Native observer independently opens the real file.
    permit = '\n'.join(['owned-rpc-vm-permit-v2', *plan[1:5], defined, plan[5] + '\\vm',
                        plan[6], plan[7], '20401094656', '1073741824',
                        'fixed-local-start-disable-and-reconcile-v2', '']).encode('ascii')
    return {'vmGuid': defined, 'switchGuid': network['switchGuid'], 'mac': network['mac'],
            'permitPath': plan[5] + '\\vm-permit.txt', 'permitSha256': c.protocol.sha(permit)}


def validate_reply(row, config, original, expected, origin, deadline, began, now):
    fixed = {'schema': 'owned-rpc-vm-endpoint/1', 'vmAttempt': original['vmAttempt'],
             'windowsBoot': original['windowsBoot'], 'permitSha256': expected['permitSha256'],
             'vmGuid': expected['vmGuid'], 'switchGuid': expected['switchGuid'], 'mac': expected['mac'],
             'originalOrigin': original['windowsOriginMilliseconds'], 'originalDeadline': original['windowsDeadlineMilliseconds'],
             'origin': origin, 'deadline': deadline, 'port': 22, 'hostAssociationObserved': True,
             'guestAuthenticated': False, 'attestationVerified': False, 'rpcReady': False, 'reservationMayRelease': False,
             'requiredFreeBytes': config['requiredFreeBytes']}
    if set(row) != set(fixed) | {'nicReference', 'observedFrom', 'observedAt', 'ipv4', 'envelope', 'freeBytes'} or any(
            row[k] != v or type(row[k]) is not type(v) for k, v in fixed.items()):
        raise ValueError('Endpoint observation belongs to another original VM or lease')
    reference = row['nicReference']
    if not isinstance(reference, str) or not re.fullmatch(r'Msvm_SyntheticEthernetPortSettingData\.InstanceID="(?:[^"\\\r\n]|\\[\\"]){1,1024}"', reference):
        raise ValueError('Exact local NIC reference required')
    start, at = c.integer(row['observedFrom']), c.integer(row['observedAt'])
    # The remote sample happened after local began. This is a conservative upper
    # bound on current remote ticks, including roundtrip latency and quantization.
    elapsed = now - began
    if elapsed < 0:
        raise ValueError('Local observation clock reversed')
    upper = origin + (elapsed + 999999) // 1000000 + 1
    if not origin <= start <= at <= upper < deadline or at-start > 2000 or upper-start > 2000:
        raise ValueError('Endpoint observation is not fresh within two seconds')
    if c.integer(row['freeBytes']) < config['requiredFreeBytes']:
        raise ValueError('Native pending-aware capacity refused')
    e = row['envelope']
    w.exact(e, ('ProcessId', 'CreationFileTime', 'JobCommitLimitBytes', 'BootstrapPrivateBytes',
                'MembershipVerified', 'LimitsVerified', 'CoversPreAssignmentMemory', 'BoundsWallTime', 'ReservationMayRelease'))
    if (not 0 < c.integer(e['ProcessId']) <= 4294967295 or c.integer(e['CreationFileTime']) == 0
            or type(e['JobCommitLimitBytes']) is not int or e['JobCommitLimitBytes'] != 128*1048576
            or not 0 < c.integer(e['BootstrapPrivateBytes']) <= 64*1048576
            or any(e[k] is not True for k in ('MembershipVerified', 'LimitsVerified'))
            or any(e[k] is not False for k in ('CoversPreAssignmentMemory', 'BoundsWallTime', 'ReservationMayRelease'))):
        raise ValueError('Exact native observer envelope required')
    host = row['ipv4']
    if host is not None:
        ip = ipaddress.IPv4Address(host)
        if (str(ip) != host or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified
                or int(ip) >> 24 == 0 or int(ip) >> 24 >= 224):
            raise ValueError('Canonical selected guest IPv4 required')
    return None if host is None else {'host': host, 'port': 22}


def observe(config):
    w.exact(config, ('clock', 'transport', 'helper', 'nonce', 'startResult', 'requiredFreeBytes'))
    original = c.validate(config['clock'])
    c.hex32(config['nonce'])
    if config['nonce'] in (original['attempt'], original['vmAttempt']):
        raise ValueError('Separate observation nonce required')
    w.image(config['helper'], 'vm-endpoint.exe')
    if c.integer(config['requiredFreeBytes']) < MINIMUM_FREE:
        raise ValueError('Retained host floor and all prospective commitments required')
    expected = lineage(config, original)
    journal = c.directory(Path(config['clock']['path']).parent)
    root = journal / 'windows-endpoint'
    argv, known = w.transport(config['transport'], root)
    if c.remaining(config['clock']) < 5:
        raise TimeoutError('Insufficient original endpoint observation window')
    root.mkdir(mode=0o700)
    c.sync_directory(journal)
    request = c.write_new(root / 'request.json', c.encode(config))
    c.write_new(root / 'known-hosts', known)
    c.write_new(root / 'sample.intent', c.encode({'request': request, 'expected': expected}))
    t = config['transport']
    command = ' '.join([t['samplerPath'], config['nonce'], original['vmAttempt'], t['samplerSha256']])
    began = time.monotonic_ns()
    raw = w.delivery.exchange(argv + [command], b'', min(3, c.remaining(config['clock'])))
    sample = c.protocol.decode(raw)
    w.exact(sample, ('schema', 'attempt', 'vmAttempt', 'windowsBoot', 'monotonicMilliseconds'))
    if (sample['schema'] != 'owned-rpc-windows-clock/1' or sample['attempt'] != config['nonce']
            or sample['vmAttempt'] != original['vmAttempt'] or sample['windowsBoot'] != original['windowsBoot']):
        raise ValueError('Fresh native observer clock identity differs')
    origin = c.integer(sample['monotonicMilliseconds'], c.MAX_INT-30000)
    deadline = min(origin+30000, original['windowsDeadlineMilliseconds'])
    if origin < original['windowsOriginMilliseconds'] or deadline-origin < 2000:
        raise TimeoutError('Observer lease outside original startup')
    c.write_new(root / 'sample.json', raw)
    command = ' '.join([config['helper']['path'], expected['permitPath'], expected['permitSha256'],
                        config['helper']['sha256'], str(origin), str(deadline), str(config['requiredFreeBytes'])])
    if time.monotonic_ns()-began >= 3_000_000_000 or lineage(config, original) != expected:
        raise ValueError('Original inputs changed or native bootstrap time consumed')
    c.validate(config['clock'])
    c.write_new(root / 'submit.intent', c.encode({'requestSha256': request['sha256'], 'command': command,
                                                'origin': origin, 'deadline': deadline, 'outcome': 'unresolved'}))
    reply = w.delivery.exchange(argv + [command], b'', min(32, c.remaining(config['clock'])))
    response = c.write_new(root / 'response.json', reply)
    row = c.protocol.decode(reply)
    c.validate(config['clock'])
    if lineage(config, original) != expected:
        raise ValueError('Original endpoint lineage changed during observation')
    endpoint = validate_reply(row, config, original, expected, origin, deadline, began, time.monotonic_ns())
    return c.write_new(root / 'RESULT.json', c.encode({
        'schema': 'owned-rpc-endpoint-observation/1', 'clock': config['clock'], 'startResult': config['startResult'],
        'response': response, 'expected': expected, 'endpoint': endpoint, 'pending': endpoint is None,
        'guestAuthenticated': False, 'providerSettlementProven': False, 'rpcReady': False,
        'remoteDeathProven': False, 'reservationMayRelease': False}))
