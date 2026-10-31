#!/usr/bin/env python3
"""Run the complete guest-key-owner half of the original startup once.

Public inputs must arrive via the authenticated original owner's channel. Hashes
alone do not establish that provenance. Run in the independently admitted user
unit described by envelope(); private SSH identities stay on this host. Native
endpoint association is a prior observation, not a continuing freshness claim.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('startup_clock')
guest = load('observe_guest')
attachment = load('prepare_attachment')
delivery = load('deliver_activation')
launch = load('launch_activation')
activation = load('observe_activation')
prepare_runtime = load('prepare_runtime')
runtime = load('deliver_runtime')
p = c.protocol
INPUTS = ('serverContract', 'serverReady', 'endpointReceipt', 'seedReceipt', 'imageReceipt', 'credentialReceipt')


def envelope(attempt, deadline):
    """PID1 owns a cutoff earlier than the original deadline, even if we hang."""
    c.hex32(attempt)
    unit = 'enclave-rpc-guest-workflow-' + attempt + '.service'
    keys = ('Id', 'MainPID', 'InvocationID', 'ControlGroup', 'Type', 'RuntimeMaxUSec',
            'TimeoutStopUSec', 'MemoryMax', 'MemorySwapMax', 'CPUQuotaPerSecUSec',
            'KillMode', 'Restart', 'SendSIGKILL', 'FinalKillSignal', 'TasksMax',
            'NoNewPrivileges', 'ExecMainStartTimestampMonotonic')
    result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
                             '--property=' + ','.join(keys), '--no-pager'],
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
    if len(result.stdout) > 8192:
        raise ValueError('Bounded workflow envelope read required')
    row = {}
    for line in result.stdout.decode().splitlines():
        key, sep, value = line.partition('=')
        if not sep or key in row:
            raise ValueError('Exact workflow properties required')
        row[key] = value
    invocation = os.environ.get('INVOCATION_ID', '')
    expected = {'Id': unit, 'MainPID': str(os.getpid()), 'InvocationID': invocation,
                'Type': 'exec', 'RuntimeMaxUSec': '4min', 'TimeoutStopUSec': '1s',
                'MemoryMax': str(256 << 20), 'MemorySwapMax': '0', 'CPUQuotaPerSecUSec': '1s',
                'KillMode': 'control-group', 'Restart': 'no', 'SendSIGKILL': 'yes',
                'FinalKillSignal': '9', 'TasksMax': '16', 'NoNewPrivileges': 'yes'}
    if (set(row) != set(keys) or not re.fullmatch('[0-9a-f]{32}', invocation)
            or any(row[k] != v for k, v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip() != '0::' + row['ControlGroup']):
        raise ValueError('Independent workflow envelope differs')
    start = row['ExecMainStartTimestampMonotonic']
    if not re.fullmatch('[0-9]{1,19}', start):
        raise ValueError('Exact workflow process origin required')
    elapsed = time.monotonic_ns() - int(start) * 1000
    # Two seconds cover allowed cross-host/wall-clock drift. Unit stop grace is
    # included. No local phase or callback can extend the PID1-owned cutoff.
    if not 0 <= elapsed < 10_000_000_000 or time.time_ns() - elapsed + 243_000_000_000 >= deadline:
        raise TimeoutError('Workflow envelope cannot fit inside original deadline')
    return {'unit': unit, 'invocation': invocation, 'pid': os.getpid(),
            'startMonotonicMicroseconds': start, 'cgroup': row['ControlGroup']}


def inputs(config):
    fields = {*INPUTS, 'target', 'jump', 'sshSha256', 'journalRoot', 'ownerBootId', 'vmAttempt'}
    if not isinstance(config, dict) or set(config) != fields:
        raise ValueError('Exact guest workflow configuration required')
    p.boot(config['ownerBootId'])
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != config['ownerBootId']:
        raise ValueError('Guest-key-owner host rebooted')
    c.hex32(config['vmAttempt'])
    raw = {key: c.read_pinned(config[key]) for key in INPUTS}
    values = {key: p.decode(value) for key, value in raw.items()}
    server = values['serverContract']
    p.identity(server['attempt'], server['instance'])
    p.window(server['createdUtcNs'], server['deadlineUtcNs'], time.time_ns())
    # Validate all storage/public credential relationships before any SSH call;
    # this temporary parse does not assign the eventual guest's boot identity.
    p.compose(raw['serverContract'], raw['serverReady'], raw['credentialReceipt'],
              config['ownerBootId'], time.time_ns())
    endpoint = values['endpointReceipt']
    exact = {'schema', 'clock', 'startResult', 'response', 'expected', 'endpoint', 'pending',
             'guestAuthenticated', 'providerSettlementProven', 'rpcReady', 'remoteDeathProven', 'reservationMayRelease'}
    if (set(endpoint) != exact or endpoint['schema'] != 'owned-rpc-endpoint-observation/1'
            or endpoint['clock'] != server['startupClock']
            or any(endpoint[k] is not False for k in ('pending', 'guestAuthenticated', 'providerSettlementProven',
                                                       'rpcReady', 'remoteDeathProven', 'reservationMayRelease'))):
        raise ValueError('Original completed owner endpoint observation required')
    for key in ('clock', 'startResult', 'response'):
        binding = endpoint[key]
        if set(binding) != {'path', 'sha256'} or not Path(binding['path']).is_absolute():
            raise ValueError('Original owner evidence binding required')
        p.digest(binding['sha256'])  # These paths belong to the original owner, not Control.
    expected = endpoint['expected']
    if set(expected) != {'vmGuid', 'switchGuid', 'mac', 'permitPath', 'permitSha256'}:
        raise ValueError('Original VM endpoint identity required')
    for key in ('vmGuid', 'switchGuid'):
        if str(uuid.UUID(expected[key])) != expected[key] or uuid.UUID(expected[key]).int == 0:
            raise ValueError('Original VM/network GUID required')
    p.digest(expected['permitSha256'])
    vm_root = 'C:\\EnclaveRpcVm-' + config['vmAttempt'] + '\\' + config['vmAttempt']
    if expected['permitPath'] != vm_root + '\\vm-permit.txt' or not re.fullmatch('02[0-9A-F]{10}', expected['mac']):
        raise ValueError('Another VM attempt or interface')
    target = config['target']
    delivery.endpoint(target)  # Stat only; no private key bytes read.
    if target['user'] != 'rpcadmin' or endpoint['endpoint'] != {'host': target['host'], 'port': target['port']} or target['port'] != 22:
        raise ValueError('SSH target differs from original owned VM observation')
    jump = config['jump']
    if jump is not None:
        if set(jump) != {'endpoint', 'alias', 'knownHosts'}:
            raise ValueError('Exact pinned jump configuration required')
        delivery.endpoint(jump['endpoint'])
        delivery.ssh_options(Path(config['journalRoot']) / 'jump-known-hosts', jump['alias'])
        known = c.read_pinned(jump['knownHosts'])
        if not 0 < len(known) <= 16384:
            raise ValueError('Bounded jump host pins required')
        raw['jumpKnownHosts'] = known
    p.digest(config['sshSha256'])
    if p.sha(Path('/usr/bin/ssh').read_bytes()) != config['sshSha256']:
        raise ValueError('Owner SSH binary changed')
    seed, image = values['seedReceipt'], values['imageReceipt']
    delivery.seed_host_key(seed, server['instance'], server['attempt'])
    if image['schema'] != 'rpc-offline-image/1':
        raise ValueError('Reviewed image receipt required')
    # Fail before observing/activating if the already prepared runtime closure
    # is incomplete. The actual preparers still revalidate their inputs later.
    required = dict(prepare_runtime.runtime.required_pins())
    required.update(guest.FILES)
    required.update(delivery.FILES)
    for name, mode in required.items():
        seeded = name in seed['records']
        row = seed['records'].get(name) if seeded else image['installedFiles'].get(name.lstrip('/'), {})
        actual_mode = row.get('mode')
        if actual_mode != (format(mode, '04o') if seeded else mode) or row.get('private') is True:
            raise ValueError('Complete public runtime closure required before submission')
        p.digest(row.get('sha256'))
    for module in (launch, runtime):
        for name, mode in module.IMPORTS.items():
            row = seed['records']['/opt/enclave-rpc/' + name]
            if row['mode'] != format(mode, '04o') or row.get('private') is True:
                raise ValueError('Complete seeded import closure required')
            p.digest(row['sha256'])
    return server, raw


def run(config):
    config = p.decode(c.encode(config))  # Fixed private configuration for the entire attempt.
    server, original_inputs = inputs(config)
    observed_envelope = envelope(server['attempt'], server['deadlineUtcNs'])
    parent = c.directory(config['journalRoot'])
    root = parent / (server['attempt'] + '-workflow')
    root.mkdir(mode=0o700)
    c.sync_directory(parent)
    c.write_new(root / 'intent.json', c.encode({'configurationSha256': p.sha(c.encode(config)),
        'attempt': server['attempt'], 'createdUtcNs': server['createdUtcNs'], 'deadlineUtcNs': server['deadlineUtcNs'],
        'envelope': observed_envelope, 'outcome': 'consumed-no-automatic-retry'}))
    wall, mono = time.time_ns(), time.monotonic_ns()
    receipts = {}
    phase = 'preflight'

    def current():
        now = time.time_ns()
        if abs(now - wall - (time.monotonic_ns() - mono)) > 2_000_000_000:
            raise ValueError('Guest-key-owner clock changed')
        p.window(server['createdUtcNs'], server['deadlineUtcNs'], now)
        if inputs(config) != (server, original_inputs):
            raise ValueError('Original workflow inputs changed')
        return (server['deadlineUtcNs'] - now) / 1e9

    def step(name, function, arguments):
        nonlocal phase
        phase = name
        current()
        c.write_new(root / (name + '.intent.json'), c.encode(arguments))
        result = function(arguments)
        current()
        receipts[name] = c.write_new(root / (name + '.result.json'), c.encode(result))
        return result

    def pin(path):
        raw = c.read(path)
        return {'path': str(path), 'sha256': p.sha(raw)}

    try:
        channel = {key: config[key] for key in ('target', 'jump', 'sshSha256', 'journalRoot')}
        observed = step('guest-observe', guest.observe, dict(channel, serverContract=config['serverContract'], seedReceipt=config['seedReceipt']))
        boot = observed['guestBootId']
        bundle_dir = root / 'attachment'
        step('attachment', attachment.prepare, {**{k: config[k] for k in ('serverContract', 'serverReady', 'credentialReceipt')},
              'instance': server['instance'], 'guestBootId': boot, 'output': str(bundle_dir)})
        bundle = pin(bundle_dir / 'RESULT.json')
        shared = dict(channel, attachmentReceipt=bundle, seedReceipt=config['seedReceipt'], guestBootId=boot)
        step('delivery', delivery.send, dict(channel, bundleReceipt=bundle, seedReceipt=config['seedReceipt'], guestBootId=boot))
        shared['deliveryReceipt'] = pin(parent / server['attempt'] / 'receipt.json')
        step('launch', launch.send, shared)
        shared['launchReceipt'] = pin(parent / (server['attempt'] + '-activation-launch') / 'receipt.json')
        ready = step('activation-observe', activation.observe, shared)
        owner_identity = ready['receipt']['owner']
        runtime_inputs = {key: ready[key] for key in ('activationRequest', 'activationReady')}
        runtime_inputs.update(attachmentReceipt=bundle, imageReceipt=config['imageReceipt'], seedReceipt=config['seedReceipt'])
        for side in ('l1', 'base'):
            output = root / ('prepare-' + side)
            step('prepare-' + side, prepare_runtime.prepare, dict(runtime_inputs, phase=side, output=str(output)))
            result = step('runtime-' + side, runtime.send, dict(channel, runtimeReceipt=pin(output / 'RESULT.json'),
                          attachmentReceipt=bundle, seedReceipt=config['seedReceipt'], guestBootId=boot))
            if result['receipt']['result']['owner'] != owner_identity:
                raise ValueError('Activation owner changed between attachment and runtime')
        current()
        return c.write_new(root / 'RESULT.json', c.encode({'schema': 'owned-rpc-guest-workflow/1',
            'attempt': server['attempt'], 'instance': server['instance'], 'guestBootId': boot,
            'ownerBootId': config['ownerBootId'], 'createdUtcNs': server['createdUtcNs'],
            'deadlineUtcNs': server['deadlineUtcNs'], 'endpointReceipt': config['endpointReceipt'],
            'receipts': receipts, 'clientProcessesObserved': True, 'rpcReady': False, 'adopted': False,
            'providerSettlementProven': False, 'writersFenced': False, 'remoteDeathProven': False,
            'reservationMayRelease': False}))
    except Exception as error:
        # Never resubmit, reset the clock, infer death, release storage, or take
        # over an existing attempt. Exact subphase intents remain authoritative.
        c.write_new(root / 'HELD.json', c.encode({'phase': phase, 'errorType': type(error).__name__,
                     'rpcReady': False, 'reservationMayRelease': False, 'automaticRetry': False}))
        raise


if __name__ == '__main__':
    import sys
    os.umask(0o077)
    print(json.dumps(run(p.decode(c.read(sys.argv[1])))))
