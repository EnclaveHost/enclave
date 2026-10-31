"""Prepare one protected export contract from the original owner startup clock.

No services, COWs, listeners, VM operations or adoption receipts are created.
Caller admission, authenticated input provenance and independent bounds remain
required. Private key bytes are never read by this preparer.
"""
import hashlib
import importlib.util
import ipaddress
import os
from pathlib import Path
import stat


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
clock = load('startup_clock', HERE.parent / 'startup_clock.py')
protocol = clock.protocol
volume = load('volume_export', HERE / 'volume_export.py')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_path(value):
    if not isinstance(value, str) or any(c in value for c in ',\r\n\0'):
        raise ValueError('Explicit safe canonical path required')
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('Canonical path required')
    return path


def tls_directory(path, role, kind, public):
    path = clock.directory(safe_path(path))
    for name in ('ca-cert.pem', kind + '-cert.pem', kind + '-key.pem'):
        file = path / name
        row = file.lstat()
        if (not stat.S_ISREG(row.st_mode) or row.st_uid != os.geteuid() or row.st_nlink != 1
                or stat.S_IMODE(row.st_mode) != 0o600 or not 0 < row.st_size <= 16384):
            raise ValueError('Private bounded role credential required')
        if not name.endswith('-key.pem'):
            expected = public['caSha256'] if name == 'ca-cert.pem' else public[kind + 'CertificateSha256']
            protocol.digest(expected)
            if protocol.sha(clock.read(file)) != expected:
                raise ValueError('Public role credential pin differs')
    return str(path)


def prepare(config):
    fields = {'clock', 'credentialReceipt', 'resourceConfig', 'runtimePins', 'roles',
              'stateParent', 'output', 'floorMiB', 'reserveMiB'}
    if not isinstance(config, dict) or set(config) != fields:
        raise ValueError('Exact export preparation configuration required')
    original = clock.validate(config['clock'])
    credential_raw = clock.read_pinned(config['credentialReceipt'])
    credentials = protocol.decode(credential_raw)
    if (credentials.get('schema') != 'owned-rpc-credentials/1'
            or (credentials['attempt'], credentials['instance']) != (original['attempt'], original['instance'])
            or set(credentials['roles']) != {'l1', 'base'}):
        raise ValueError('Original guest credential identity required')
    for name, minimum in [('floorMiB', 27648), ('reserveMiB', 512)]:
        if type(config[name]) is not int or not minimum <= config[name] <= 1048576:
            raise ValueError('Export resource floor/reserve weakened or invalid')
    resource_raw = clock.read_pinned(config['resourceConfig'])
    resource = protocol.decode(resource_raw)
    if set(resource) != {'url', 'controlClient', 'controlClientSha256', 'keyFile'} or resource['url'] != 'http://127.0.0.1:8095':
        raise ValueError('Maintained local authenticated resource authority required')
    # The reader validates the actual client/key and authenticates /health.
    # Neither resource status nor current admission is manufactured here.
    protocol.digest(resource['controlClientSha256'])
    safe_path(resource['controlClient'])
    safe_path(resource['keyFile'])
    pins = config['runtimePins']
    required = {str(HERE / n) for n in ('guarded_export.py', 'volume_export.py', 'observe_resources.mjs')}
    required |= {str(HERE.parent / n) for n in ('startup_clock.py', 'storage_protocol.py')}
    required |= {'/usr/bin/node', str(safe_path(config['resourceConfig']['path']))} | set(volume.TOOLS)
    if not isinstance(pins, dict) or set(pins) != required:
        raise ValueError('Exact reviewed runtime closure required')
    def verify_pins():
        for name, expected in pins.items():
            protocol.digest(expected)
            # System executable symlinks are accepted at their fixed tool path;
            # owned configuration and source paths are canonical independently.
            if digest(name) != expected:
                raise ValueError('Reviewed runtime source/tool changed')
        if pins[config['resourceConfig']['path']] != config['resourceConfig']['sha256']:
            raise ValueError('Resource configuration pin differs')
        for name, expected in volume.TOOLS.items():
            if pins[name] != expected:
                raise ValueError('Maintained QEMU tool pin differs')
    verify_pins()
    if set(config['roles']) != {'l1', 'base'}:
        raise ValueError('Both fixed storage roles required')
    ports = set()
    originals = []
    roles = {}
    for role in ('l1', 'base'):
        row = config['roles'][role]
        if set(row) != {'parent', 'originals', 'tls', 'clientTls', 'host', 'port'}:
            raise ValueError('Exact role preparation fields required')
        ip = ipaddress.ip_address(row['host'])
        if ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_unspecified or str(ip) != row['host']:
            raise ValueError('Explicit canonical unicast host required')
        if type(row['port']) is not int or not 1024 <= row['port'] <= 65535 or row['port'] in ports:
            raise ValueError('Distinct explicit storage ports required')
        ports.add(row['port'])
        public = credentials['roles'][role]
        if (public['tlsName'] != 'rpc-storage-' + original['attempt'] + '-' + role
                or public['clientDN'] != 'CN=rpc-client-' + original['attempt'] + '-' + role):
            raise ValueError('Original role TLS identity differs')
        parent = clock.directory(safe_path(row['parent']))
        # No existing/partially consumed export attempt can be silently reused.
        if os.path.lexists(parent / (original['attempt'] + '-' + role)):
            raise ValueError('Export role attempt already consumed')
        chain = row['originals']
        if not isinstance(chain, list) or not 1 <= len(chain) <= 3:
            raise ValueError('Bounded explicit original chain required')
        seen = set()
        for entry in chain:
            if not isinstance(entry, list) or len(entry) != 2:
                raise ValueError('Exact original path/metadata required')
            path = safe_path(entry[0])
            volume.directory(path.parent)
            if (str(path) in seen or not isinstance(entry[1], list) or len(entry[1]) != 5
                    or any(type(n) is not int or n < 0 for n in entry[1]) or volume.metadata(path) != entry[1]):
                raise ValueError('Original image identity differs')
            seen.add(str(path))
            originals.append((path, list(entry[1])))
        roles[role] = {**row, 'parent': str(parent), 'bytes': protocol.BYTES,
                       'tlsName': public['tlsName'],
                       'tls': tls_directory(row['tls'], role, 'server', public),
                       'clientTls': tls_directory(row['clientTls'], role, 'client', public)}
    state = clock.directory(safe_path(config['stateParent']))
    if os.path.lexists(state / original['attempt']):
        raise ValueError('Export supervisor attempt already consumed')
    output = Path(config['output'])
    if not output.is_absolute() or output.name != original['attempt']:
        raise ValueError('Exclusive attempt-named output required')
    clock.directory(output.parent)
    contract = {'attempt': original['attempt'], 'instance': original['instance'], 'bootId': original['bootId'],
                'createdUtcNs': original['createdUtcNs'], 'deadlineUtcNs': original['deadlineUtcNs'],
                'floorMiB': config['floorMiB'], 'reserveMiB': config['reserveMiB'],
                'roles': roles, 'stateParent': str(state), 'sourcePins': dict(pins),
                'resourceArgv': ['/usr/bin/node', str(HERE / 'observe_resources.mjs'), config['resourceConfig']['path']],
                'startupClock': dict(config['clock'])}
    # All validation precedes consuming output; partial output is never replaced.
    clock.validate(config['clock'])
    output.mkdir(mode=0o700)
    clock.sync_directory(output.parent)
    clock.write_new(output / 'prepare.intent', clock.encode({'clock': config['clock'], 'credentialReceipt': config['credentialReceipt']}))
    binding = clock.write_new(output / 'contract.json', clock.encode(contract))
    verify_pins()
    if clock.read_pinned(config['credentialReceipt']) != credential_raw or clock.read_pinned(config['resourceConfig']) != resource_raw:
        raise ValueError('Preparation input changed')
    for path, expected in originals:
        if volume.metadata(path) != expected:
            raise ValueError('Original image changed during preparation')
    clock.validate(config['clock'])
    result = {'schema': 'owned-rpc-export-preparation/1', 'attempt': original['attempt'],
              'instance': original['instance'], 'clock': config['clock'], 'contract': binding,
              'credentialReceiptSha256': config['credentialReceipt']['sha256'],
              'createdUtcNs': original['createdUtcNs'], 'deadlineUtcNs': original['deadlineUtcNs'],
              'exportStarted': False, 'capacityAdmitted': False, 'rpcReady': False, 'writersFenced': False}
    clock.write_new(output / 'RESULT.json', clock.encode(result))
    return result
