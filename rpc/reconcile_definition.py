"""One explicitly requested observation of an expired definition attempt.

Uses the existing definition-reconcile native operation, never DefineSystem.
Run only in an admitted bounded owner process, with qualified protected staging.
A fresh reader lease does not renew the original startup or resolve a lost reply.
"""
from pathlib import Path
import time

import windows_transition as w

c = w.c
STATES = {'submission-unproven-held', 'response-lost-held', 'provider-refused-held',
          'definition-pending-held', 'definition-failed-held', 'defined-owned-off'}


def historical(config):
    original = c.inspect_historical(config['clock'])
    wall, mono, boot = c.snapshot()
    if (boot != original['bootId'] or wall < original['deadlineUtcNs']
            or mono < original['deadlineMonotonicNs']):
        raise ValueError('Same-boot expired original startup required')
    journal = c.directory(Path(config['clock']['path']).parent)
    prior_path = journal / 'windows-define' / 'request.json'
    if config['definitionRequest'].get('path') != str(prior_path):
        raise ValueError('Exact original consumed definition request required')
    raw = c.read_pinned(config['definitionRequest'])
    prior = c.protocol.decode(raw)
    w.exact(prior, ('clock', 'transport', 'phase', 'nonce', 'binaries', 'observation', 'input', 'previous'))
    w.exact(prior['binaries'], ('controller', 'entry'))
    for key, name in zip(('controller', 'entry'), w.IMAGES['define']):
        w.image(prior['binaries'][key], name)
    w.c.hex32(prior['nonce'])
    if (prior['clock'] != config['clock'] or prior['transport'] != config['transport']
            or prior['phase'] != 'define' or config['nonce'] in
            (prior['nonce'], original['attempt'], original['vmAttempt'])):
        raise ValueError('Original definition channel or distinct reader identity differs')
    plan_raw = w.staged(prior['input'], 'definition-plan.txt')
    plan = w.definition(plan_raw, original)
    obs_raw = w.staged(prior['observation'], 'observation.json')
    if plan[3] != c.protocol.sha(obs_raw):
        raise ValueError('Original admission binding differs')
    submit = c.protocol.decode(c.read(prior_path.parent / 'submit.intent'))
    w.exact(submit, ('requestSha256', 'command', 'origin', 'deadline', 'outcome'))
    origin, deadline = c.integer(submit['origin']), c.integer(submit['deadline'])
    expected = ' '.join([prior['binaries']['controller']['path'], '--target',
                         prior['binaries']['entry']['path'], prior['binaries']['entry']['sha256'],
                         prior['nonce'], 'define', prior['observation']['path'], plan[3],
                         prior['input']['path'], c.protocol.sha(plan_raw), str(origin), str(deadline)])
    if (submit['requestSha256'] != c.protocol.sha(raw) or submit['command'] != expected
            or submit['outcome'] != 'unresolved' or origin < original['windowsOriginMilliseconds']
            or not origin < deadline <= min(origin + 30000, original['windowsDeadlineMilliseconds'])):
        raise ValueError('Consumed original submission differs')
    if (config['input']['path'] != plan[5] + '\\definition-plan.txt'
            or w.staged(config['input'], 'definition-plan.txt') != plan_raw):
        raise ValueError('Reconcile only the exact existing original plan')
    return original, journal


def validate_reply(row, config, origin, deadline):
    if (row.get('schema') != 'owned-rpc-target-definition/1' or row.get('passed') is not True
            or row.get('operation') != 'definition-reconcile' or row.get('failures') != []
            or row.get('origin') != origin or row.get('deadline') != deadline
            or row.get('root') != 'C:\\EnclaveRpcDefinition-' + config['nonce'] + '\\' + config['nonce']
            or row.get('plan') != config['input']['binding']['sha256']
            or row.get('startAuthorized') is not False or row.get('reservationMayRelease') is not False):
        raise ValueError('Exact reconciliation controller result required')
    result = row.get('result')
    w.exact(result, ('state', 'guid', 'definitionSettled', 'startAuthorized'))
    state = result['state']
    if (state not in STATES or result['startAuthorized'] is not False
            or result['definitionSettled'] is not (state in ('defined-owned-off', 'definition-failed-held'))):
        raise ValueError('Reconciliation settlement classification differs')
    if state == 'defined-owned-off':
        w.guid(result['guid'])
    elif result['guid'] != '':
        raise ValueError('Held outcome cannot acknowledge a VM')


def execute(config):
    w.exact(config, ('clock', 'definitionRequest', 'transport', 'nonce', 'binaries', 'observation', 'input'))
    c.hex32(config['nonce'])
    original, journal = historical(config)
    w.exact(config['binaries'], ('controller', 'entry'))
    for key, name in zip(('controller', 'entry'), w.IMAGES['define']):
        w.image(config['binaries'][key], name)
    observed = w.staged(config['observation'], 'observation.json')
    w.observation(observed, original)
    root = journal / 'windows-definition-reconcile'
    argv, known = w.transport(config['transport'], root)
    # Fixed directory refuses replay even after transport loss or changed nonce.
    root.mkdir(mode=0o700)
    c.sync_directory(journal)
    request = c.write_new(root / 'request.json', c.encode(config))
    c.write_new(root / 'known-hosts', known)
    c.write_new(root / 'sample.intent', c.encode({'requestSha256': request['sha256']}))
    began = time.monotonic_ns()
    t = config['transport']
    sample_raw = w.exchange_recorded(root, 'sample', argv + [' '.join([
        t['samplerPath'], config['nonce'], original['vmAttempt'], t['samplerSha256']])], 3)
    c.write_new(root / 'sample.json', sample_raw)
    sample = c.protocol.decode(sample_raw)
    w.exact(sample, ('schema', 'attempt', 'vmAttempt', 'windowsBoot', 'monotonicMilliseconds'))
    if (sample['schema'] != 'owned-rpc-windows-clock/1' or sample['attempt'] != config['nonce']
            or sample['vmAttempt'] != original['vmAttempt'] or sample['windowsBoot'] != original['windowsBoot']):
        raise ValueError('Reader sample identity differs')
    origin = c.integer(sample['monotonicMilliseconds'], c.MAX_INT - 30000)
    if origin < original['windowsDeadlineMilliseconds']:
        raise ValueError('Original Windows startup has not expired')
    deadline = origin + 30000  # Reader-only lease; original plan bytes never change.
    b = config['binaries']
    command = ' '.join([b['controller']['path'], '--target', b['entry']['path'], b['entry']['sha256'],
                        config['nonce'], 'definition-reconcile', config['observation']['path'],
                        config['observation']['binding']['sha256'], config['input']['path'],
                        config['input']['binding']['sha256'], str(origin), str(deadline)])
    if historical(config) != (original, journal) or c.read_pinned(config['observation']['binding']) != observed:
        raise ValueError('Reader inputs changed before submission')
    if time.monotonic_ns() - began >= 3_000_000_000:
        raise TimeoutError('Original reader bootstrap budget consumed')
    c.write_new(root / 'submit.intent', c.encode({'requestSha256': request['sha256'], 'command': command,
                                               'origin': origin, 'deadline': deadline, 'outcome': 'unresolved'}))
    reply = w.exchange_recorded(root, 'submit', argv + [command], 32)
    response = c.write_new(root / 'response.json', reply)
    row = c.protocol.decode(reply)
    validate_reply(row, config, origin, deadline)
    if historical(config) != (original, journal) or c.read_pinned(config['observation']['binding']) != observed:
        raise ValueError('Reader inputs changed during submission')
    if time.monotonic_ns() - began >= 35_000_000_000:
        raise TimeoutError('Reader transport completion exceeded bound')
    return c.write_new(root / 'RESULT.json', c.encode({
        'schema': 'owned-rpc-definition-reconciliation/1', 'clock': config['clock'],
        'definitionRequest': config['definitionRequest'], 'requestSha256': request['sha256'],
        'responseSha256': response['sha256'], 'native': row, 'observationCompleted': True,
        'definitionSettled': row['result']['definitionSettled'], 'newStartupAuthorized': False,
        'rpcReady': False, 'remoteDeathProven': False, 'reservationMayRelease': False}))
