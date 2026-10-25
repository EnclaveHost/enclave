#!/usr/bin/env python3
"""Independent standard-library reference for the experimental masked desktop
derivation V8 (enclave-catalog-bundle/8).

Development-only contract: it is not advertised by production managers and is
not an implemented runtime. profileSha256 commits a pre-image descriptor only;
neither it nor this derivation is authorization or attestation.

Usage:
    python reference.py vectors    # emit the JSON fixture on stdout
"""
import base64
import binascii
import copy
import hashlib
import json
import re
import struct
import sys

DERIVATION = 'enclave-catalog-bundle/8'
ABI = 'enclave-domain-abi/1'
WORLD = 'wasi:cli'
ARTIFACT_KIND = 'wasm-component'
PROFILE = 'kvm-box-masked-v1'
HTTP_PORT = 8000
PORTS = ('tcp:47984', 'tcp:47989', 'tcp:48010', 'udp:47998', 'udp:47999', 'udp:48000')
COMPONENT_PREAMBLE = bytes.fromhex('0061736d0d000100')
BUNDLE_MAGIC = b'ENCLAVE-BUNDLE/1\n'
MANIFEST_MAX_BYTES = 65536
CONFIG_MAX_BYTES = 32768
CONFIG_MAX_DEPTH = 10000  # Explicit interoperability bound, added during integration.
U32_MAX = 0xFFFFFFFF

RECORD_FIELDS = frozenset({
    'derivation', 'catalog', 'cid', 'runtimeId', 'policy', 'http', 'ports',
    'configBase64', 'secretDeployment', 'desktop',
})
CATALOG_FIELDS = frozenset({'app', 'version'})
POLICY_FIELDS = frozenset({'cpuPercent', 'memMiB', 'vcpus'})
DESKTOP_FIELDS = frozenset({'profile', 'profileSha256', 'gpuMilli'})
MANIFEST_FIELDS = frozenset({
    'abi', 'artifact', 'world', 'policy', 'http', 'ports', 'desktop',
    'configBase64', 'secretDeployment',
})
MAPPING_FIELDS = frozenset({
    'record', 'recordSha256', 'componentSha256', 'componentBytes', 'appId', 'bundleBytes',
})

# [0-9] style classes are literal ASCII ranges for str patterns; fullmatch
# avoids the "$ matches before a trailing newline" pitfall.
_HEX64 = re.compile('[0-9a-f]{64}')
_PREFIXED_HEX64 = re.compile('0x[0-9a-f]{64}')
_CID = re.compile(
    'Qm[1-9A-HJ-NP-Za-km-z]{44}'
    '|b[a-z2-7]{50,120}'
    '|z[1-9A-HJ-NP-Za-km-z]{40,120}'
)


class RefusedError(ValueError):
    """The record/component pair is outside the V8 contract."""


def _refuse(message):
    raise RefusedError(message)


# --- strict JSON object syntax check (RFC 8259 grammar, iterative) ---------

_JSON_WS = frozenset(' \t\n\r')
_HEX_DIGITS = frozenset('0123456789abcdefABCDEF')
_JSON_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')


def _skip_ws(text, i):
    n = len(text)
    while i < n and text[i] in _JSON_WS:
        i += 1
    return i


def _scan_json_string(text, i):
    """text[i] is '"'; return the index after the closing quote, or -1."""
    n = len(text)
    i += 1
    while i < n:
        c = text[i]
        if c == '"':
            return i + 1
        if c == '\\':
            if i + 1 >= n:
                return -1
            escape = text[i + 1]
            if escape in '"\\/bfnrt':
                i += 2
            elif escape == 'u':
                digits = text[i + 2:i + 6]
                if len(digits) != 4 or not all(d in _HEX_DIGITS for d in digits):
                    return -1
                i += 6
            else:
                return -1
        elif c < ' ':
            return -1
        else:
            i += 1
    return -1


def _scan_json_scalar(text, i):
    if text[i] == '"':
        return _scan_json_string(text, i)
    for literal in ('true', 'false', 'null'):
        if text.startswith(literal, i):
            return i + len(literal)
    match = _JSON_NUMBER.match(text, i)
    return match.end() if match else -1


def is_json_object_text(text):
    """True when text is exactly one JSON object (whitespace allowed around it).

    Iterative, with the V8 container-depth bound, and
    NaN/Infinity, comments, trailing commas, BOMs etc. are not part of the grammar.
    """
    n = len(text)
    i = _skip_ws(text, 0)
    if i >= n or text[i] != '{':
        return False
    stack = []
    state = 'value'
    while True:
        i = _skip_ws(text, i)
        if state == 'after' and not stack:
            return i == n
        if i >= n:
            return False
        c = text[i]
        if state == 'value':
            if c == '{':
                stack.append('}')
                if len(stack) > CONFIG_MAX_DEPTH:
                    return False
                state = 'key_or_close'
                i += 1
            elif c == '[':
                stack.append(']')
                if len(stack) > CONFIG_MAX_DEPTH:
                    return False
                state = 'value_or_close'
                i += 1
            else:
                i = _scan_json_scalar(text, i)
                if i < 0:
                    return False
                state = 'after'
        elif state == 'value_or_close':
            if c == ']':
                stack.pop()
                state = 'after'
                i += 1
            else:
                state = 'value'
        elif state in ('key_or_close', 'key'):
            if c == '}' and state == 'key_or_close':
                stack.pop()
                state = 'after'
                i += 1
            elif c == '"':
                i = _scan_json_string(text, i)
                if i < 0:
                    return False
                state = 'colon'
            else:
                return False
        elif state == 'colon':
            if c != ':':
                return False
            i += 1
            state = 'value'
        else:  # 'after' inside a container
            if c == ',':
                i += 1
                state = 'key' if stack[-1] == '}' else 'value'
            elif c == stack[-1]:
                stack.pop()
                i += 1
            else:
                return False


# --- record validation -------------------------------------------------------

def _exact_object(value, fields, where):
    if type(value) is not dict:
        _refuse(f'{where} must be an object')
    keys = set(value)
    missing = fields - keys
    extra = keys - fields
    if missing:
        _refuse(f'{where} is missing {sorted(missing)}')
    if extra:
        _refuse(f'{where} has unknown fields {sorted(map(repr, extra))}')


def _integer(value, low, high, where):
    # type() rather than isinstance(): bool is a subclass of int.
    if type(value) is not int or not low <= value <= high:
        _refuse(f'{where} must be an integer in {low}..{high}')


def _pattern(value, pattern, where):
    if type(value) is not str or not pattern.fullmatch(value):
        _refuse(f'{where} has an invalid format')


def _nonzero_hex(value, where):
    if set(value[2:] if value.startswith('0x') else value) == {'0'}:
        _refuse(f'{where} must be nonzero')


def decode_config(value):
    """Strict canonical padded RFC 4648 base64 of a UTF-8 JSON object; returns bytes."""
    if type(value) is not str or not value:
        _refuse('configBase64 must be a nonempty string')
    if not value.isascii() or len(value) % 4:
        _refuse('configBase64 is not padded standard base64')
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        _refuse('configBase64 is not standard base64')
    if base64.b64encode(raw).decode('ascii') != value:
        _refuse('configBase64 is not canonical base64')
    if not 1 <= len(raw) <= CONFIG_MAX_BYTES:
        _refuse(f'decoded config must be 1..{CONFIG_MAX_BYTES} bytes')
    if b'\x00' in raw:
        _refuse('decoded config contains a NUL byte')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        _refuse('decoded config is not valid UTF-8')
    if not is_json_object_text(text):
        _refuse('decoded config is not a JSON object')
    return raw


def validate_record(record):
    _exact_object(record, RECORD_FIELDS, 'record')

    derivation = record['derivation']
    if type(derivation) is not str or derivation != DERIVATION:
        _refuse(f'derivation must be {DERIVATION}')

    catalog = record['catalog']
    _exact_object(catalog, CATALOG_FIELDS, 'catalog')
    _pattern(catalog['app'], _PREFIXED_HEX64, 'catalog.app')
    _integer(catalog['version'], 0, U32_MAX, 'catalog.version')

    _pattern(record['cid'], _CID, 'cid')

    _pattern(record['runtimeId'], _HEX64, 'runtimeId')
    _nonzero_hex(record['runtimeId'], 'runtimeId')

    policy = record['policy']
    _exact_object(policy, POLICY_FIELDS, 'policy')
    _integer(policy['cpuPercent'], 400, 1600, 'policy.cpuPercent')
    _integer(policy['memMiB'], 8192, 65536, 'policy.memMiB')
    _integer(policy['vcpus'], 4, 16, 'policy.vcpus')

    http = record['http']
    if type(http) is not int or http != HTTP_PORT:
        _refuse(f'http must be the integer {HTTP_PORT}')

    ports = record['ports']
    if (type(ports) is not list or len(ports) != len(PORTS)
            or any(type(got) is not str or got != want for got, want in zip(ports, PORTS))):
        _refuse('ports must be exactly the fixed desktop streaming ports in order')

    decode_config(record['configBase64'])

    _pattern(record['secretDeployment'], _PREFIXED_HEX64, 'secretDeployment')
    _nonzero_hex(record['secretDeployment'], 'secretDeployment')

    desktop = record['desktop']
    _exact_object(desktop, DESKTOP_FIELDS, 'desktop')
    if type(desktop['profile']) is not str or desktop['profile'] != PROFILE:
        _refuse(f'desktop.profile must be {PROFILE}')
    _pattern(desktop['profileSha256'], _HEX64, 'desktop.profileSha256')
    _nonzero_hex(desktop['profileSha256'], 'desktop.profileSha256')
    _integer(desktop['gpuMilli'], 500, 1000, 'desktop.gpuMilli')


def validate_component(component):
    if type(component) not in (bytes, bytearray):
        _refuse('component must be bytes')
    component = bytes(component)
    if not component.startswith(COMPONENT_PREAMBLE):
        _refuse('component does not begin with the component preamble')
    if len(component) > U32_MAX:
        _refuse('component is too large')
    return component


# --- canonical encoding and derivation ---------------------------------------

def _canonical_string(value):
    if not value.isascii() or any(c < ' ' for c in value):
        raise TypeError('canonical strings are printable ASCII in this contract')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def _canonical(value):
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            raise TypeError('object keys must be strings')
        # ASCII-only keys: code point order equals byte order.
        return '{' + ','.join(
            _canonical_string(key) + ':' + _canonical(value[key]) for key in sorted(value)
        ) + '}'
    if type(value) is list:
        return '[' + ','.join(_canonical(item) for item in value) + ']'
    if type(value) is str:
        return _canonical_string(value)
    if type(value) is int:
        return str(value)
    raise TypeError(f'unsupported canonical value {type(value).__name__}')


def canonical_json(value):
    return _canonical(value).encode('ascii')


def _sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def derive(record, component):
    """Return (bundle bytes, mapping dict) or raise RefusedError."""
    validate_record(record)
    component = validate_component(component)
    record = copy.deepcopy(record)

    manifest = canonical_json({
        'abi': ABI,
        'artifact': {'kind': ARTIFACT_KIND, 'sha256': _sha256_hex(component)},
        'world': WORLD,
        'policy': record['policy'],
        'http': record['http'],
        'ports': record['ports'],
        'desktop': record['desktop'],
        'configBase64': record['configBase64'],
        'secretDeployment': record['secretDeployment'],
    })
    if len(manifest) > MANIFEST_MAX_BYTES:
        _refuse('manifest is too large')

    bundle = (BUNDLE_MAGIC
              + struct.pack('<I', len(manifest)) + manifest
              + struct.pack('<I', len(component)) + component)
    mapping = {
        'record': record,
        'recordSha256': _sha256_hex(canonical_json(record)),
        'componentSha256': _sha256_hex(component),
        'componentBytes': len(component),
        'appId': _sha256_hex(bundle),
        'bundleBytes': len(bundle),
    }
    return bundle, mapping


# --- fixtures ------------------------------------------------------------------

FIXTURE_COMPONENT = COMPONENT_PREAMBLE + b'masked-desktop-v8-reference-fixture'
BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
BASE32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567'
BASE_CONFIG = '{"codec":"h264","display":{"height":1080,"width":1920},"input":"masked"}'

IDENTITY = 'identity'   # bound into the bundle: appId must change
SEPARATE = 'separate'   # bound only through recordSha256: appId must not change


def _b64(data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    return base64.b64encode(data).decode('ascii')


def base_record():
    return {
        'derivation': DERIVATION,
        'catalog': {'app': '0x' + '11' * 32, 'version': 1},
        'cid': 'Qm' + BASE58[:44],
        'runtimeId': '22' * 32,
        'policy': {'cpuPercent': 800, 'memMiB': 16384, 'vcpus': 8},
        'http': HTTP_PORT,
        'ports': list(PORTS),
        'configBase64': _b64(BASE_CONFIG),
        'secretDeployment': '0x' + '33' * 32,
        'desktop': {'profile': PROFILE, 'profileSha256': '44' * 32, 'gpuMilli': 750},
    }


def _set(path, value):
    keys = path.split('.')

    def apply(record):
        target = record
        for key in keys[:-1]:
            target = target[key]
        target[keys[-1]] = copy.deepcopy(value)
        return record
    return apply


def _drop(path):
    keys = path.split('.')

    def apply(record):
        target = record
        for key in keys[:-1]:
            target = target[key]
        del target[keys[-1]]
        return record
    return apply


def _replace(value):
    return lambda record: copy.deepcopy(value)


def _chain(*steps):
    def apply(record):
        for step in steps:
            record = step(record)
        return record
    return apply


def _config(data):
    return _set('configBase64', _b64(data))


def _identity(record):
    return record


def _config_of_length(size):
    filler = size - len('{"a":""}')
    return '{"a":"' + 'x' * filler + '"}'


def _urlsafe_only_config():
    for n in range(1, 64):
        standard = _b64('{"k":"' + '?' * n + '"}')
        if '+' in standard or '/' in standard:
            return standard.replace('+', '-').replace('/', '_')
    raise AssertionError('no URL-safe distinguishing config found')


def _positive_cases():
    return [
        ('baseline', _identity, None),
        ('policy-and-gpu-minimum-bounds', _chain(
            _set('policy', {'cpuPercent': 400, 'memMiB': 8192, 'vcpus': 4}),
            _set('desktop.gpuMilli', 500)), IDENTITY),
        ('policy-and-gpu-maximum-bounds', _chain(
            _set('policy', {'cpuPercent': 1600, 'memMiB': 65536, 'vcpus': 16}),
            _set('desktop.gpuMilli', 1000)), IDENTITY),
        ('policy-cpu-percent-changed', _set('policy.cpuPercent', 1200), IDENTITY),
        ('desktop-profile-sha256-changed', _set('desktop.profileSha256', '45' * 32), IDENTITY),
        ('desktop-profile-sha256-single-bit', _set('desktop.profileSha256', '44' * 31 + '45'), IDENTITY),
        ('desktop-gpu-milli-changed', _set('desktop.gpuMilli', 900), IDENTITY),
        ('config-changed', _config('{"codec":"hevc","display":{"height":1440,"width":2560}}'), IDENTITY),
        ('config-whitespace-distinct-bytes', _config(
            '{ "codec": "h264", "display": {"height": 1080, "width": 1920}, "input": "masked" }\n'), IDENTITY),
        ('config-key-order-distinct-bytes', _config(
            '{"input":"masked","display":{"width":1920,"height":1080},"codec":"h264"}'), IDENTITY),
        ('config-empty-object', _config('{}'), IDENTITY),
        ('config-unicode-text', _config('{"title":"Bureau – café ☕"}'), IDENTITY),
        ('config-escaped-nul-is-not-a-nul-byte', _config(r'{"a":"\u0000"}'), IDENTITY),
        ('config-lone-surrogate-escape', _config(r'{"a":"\ud800"}'), IDENTITY),
        ('config-duplicate-keys-are-syntax', _config('{"a":1,"a":2}'), IDENTITY),
        ('config-large-exponent-is-syntax', _config('{"n":1e999,"m":-0.0e-0}'), IDENTITY),
        ('config-deep-nesting', _config('{"a":' + '[' * 2000 + ']' * 2000 + '}'), IDENTITY),
        ('config-maximum-depth', _config('{"a":' + '[' * (CONFIG_MAX_DEPTH - 1) + ']' * (CONFIG_MAX_DEPTH - 1) + '}'), IDENTITY),
        ('config-maximum-length', _config(_config_of_length(CONFIG_MAX_BYTES)), IDENTITY),
        ('secret-deployment-changed', _set('secretDeployment', '0x' + '34' * 32), IDENTITY),
        ('runtime-id-changed', _set('runtimeId', '23' * 32), SEPARATE),
        ('catalog-app-changed', _set('catalog.app', '0x' + 'ab' * 32), SEPARATE),
        ('catalog-app-zero-is-not-restricted', _set('catalog.app', '0x' + '00' * 32), SEPARATE),
        ('catalog-version-zero', _set('catalog.version', 0), SEPARATE),
        ('catalog-version-maximum', _set('catalog.version', U32_MAX), SEPARATE),
        ('cid-cidv1-base32', _set('cid', 'b' + (BASE32_LOWER * 2)[:58]), SEPARATE),
        ('cid-cidv1-base32-maximum', _set('cid', 'b' + (BASE32_LOWER * 4)[:120]), SEPARATE),
        ('cid-base58btc-multibase', _set('cid', 'z' + BASE58[:48]), SEPARATE),
        ('cid-base58btc-minimum', _set('cid', 'z' + BASE58[:40]), SEPARATE),
    ]


def _negative_cases():
    cases = []

    def add(name, mutate, component=None):
        cases.append((name, mutate, component))

    # Record shape.
    add('record-not-object', _replace([['derivation', DERIVATION]]))
    add('record-null', _replace(None))
    add('record-empty-object', _replace({}))
    for field in sorted(RECORD_FIELDS):
        add(f'missing-{field}', _drop(field))
    for field, value in [
        ('label', 'masked desktop'),
        ('device', '/dev/dri/renderD128'),
        ('devices', ['/dev/kvm', '/dev/uinput']),
        ('unmasked', True),
        ('masked', False),
        ('imagePath', '/var/lib/images/desktop.qcow2'),
        ('nativeArtifact', 'desktop-agent.elf'),
        ('shell', '/bin/sh -c "start-desktop"'),
        ('args', ['--device', '/dev/dri/card0']),
        ('inference', {'model': 'legacy-7b', 'weights': 'public'}),
        ('model', 'legacy-7b'),
        ('gpu', {'milli': 750}),
        ('ownerCredential', 'placeholder-not-a-secret'),
        ('abi', ABI),
        ('world', WORLD),
        ('artifact', {'kind': ARTIFACT_KIND}),
        ('appId', '55' * 32),
        ('imageSha256', '66' * 32),
    ]:
        add(f'extra-field-{field}', _set(field, value))

    # derivation / legacy shapes.
    for name, value in [
        ('v7', 'enclave-catalog-bundle/7'),
        ('v9', 'enclave-catalog-bundle/9'),
        ('trailing-space', DERIVATION + ' '),
        ('uppercase', DERIVATION.upper()),
        ('integer', 8),
        ('null', None),
    ]:
        add(f'derivation-{name}', _set('derivation', value))
    add('legacy-inference-record', _chain(
        _set('derivation', 'enclave-catalog-bundle/7'),
        _drop('desktop'),
        _set('inference', {'model': 'legacy-7b', 'gpuMilli': 750})))
    add('legacy-inference-in-desktop', _set('desktop.inference', 'legacy'))
    add('legacy-gpu-in-policy', _set('policy.gpuMilli', 750))

    # catalog.
    add('catalog-not-object', _set('catalog', '0x' + '11' * 32))
    add('catalog-missing-app', _drop('catalog.app'))
    add('catalog-missing-version', _drop('catalog.version'))
    add('catalog-extra-label', _set('catalog.label', 'desktop'))
    add('catalog-app-uppercase', _set('catalog.app', '0x' + 'AB' * 32))
    add('catalog-app-no-prefix', _set('catalog.app', '11' * 32))
    add('catalog-app-uppercase-prefix', _set('catalog.app', '0X' + '11' * 32))
    add('catalog-app-short', _set('catalog.app', '0x' + '11' * 31))
    add('catalog-app-long', _set('catalog.app', '0x' + '11' * 33))
    add('catalog-app-trailing-newline', _set('catalog.app', '0x' + '11' * 32 + '\n'))
    add('catalog-version-negative', _set('catalog.version', -1))
    add('catalog-version-over-u32', _set('catalog.version', U32_MAX + 1))
    add('catalog-version-bool-true', _set('catalog.version', True))
    add('catalog-version-bool-false', _set('catalog.version', False))
    add('catalog-version-fraction', _set('catalog.version', 1.5))
    add('catalog-version-string', _set('catalog.version', '1'))

    # cid.
    for name, value in [
        ('empty', ''),
        ('qm-short', 'Qm' + BASE58[:43]),
        ('qm-long', 'Qm' + BASE58[:45]),
        ('qm-invalid-char', 'Qm' + 'O' * 44),
        ('qm-zero-char', 'Qm' + '0' * 44),
        ('base32-short', 'b' + 'a' * 49),
        ('base32-long', 'b' + 'a' * 121),
        ('base32-uppercase', 'b' + 'A' * 58),
        ('base32-invalid-digit', 'b' + '1' * 58),
        ('base58-short', 'z' + BASE58[:39]),
        ('base58-long', 'z' + (BASE58 * 3)[:121]),
        ('base16-multibase', 'f01701220' + 'ab' * 32),
        ('trailing-newline', 'Qm' + BASE58[:44] + '\n'),
        ('leading-space', ' Qm' + BASE58[:44]),
        ('path', '/ipfs/Qm' + BASE58[:44]),
        ('integer', 1),
    ]:
        add(f'cid-{name}', _set('cid', value))

    # runtimeId.
    for name, value in [
        ('zero', '0' * 64),
        ('uppercase', 'AB' * 32),
        ('prefixed', '0x' + '22' * 32),
        ('short', '2' * 63),
        ('long', '2' * 65),
        ('non-hex', 'g' * 64),
        ('integer', 34),
        ('trailing-newline', '22' * 32 + '\n'),
    ]:
        add(f'runtime-id-{name}', _set('runtimeId', value))

    # policy.
    add('policy-not-object', _set('policy', [800, 16384, 8]))
    for field in sorted(POLICY_FIELDS):
        add(f'policy-missing-{field}', _drop(f'policy.{field}'))
    add('policy-extra-cpu-only', _set('policy.cpuOnly', True))
    for field, low, high, ok in [
        ('cpuPercent', 400, 1600, 800),
        ('memMiB', 8192, 65536, 16384),
        ('vcpus', 4, 16, 8),
    ]:
        add(f'policy-{field}-below-minimum', _set(f'policy.{field}', low - 1))
        add(f'policy-{field}-above-maximum', _set(f'policy.{field}', high + 1))
        add(f'policy-{field}-bool', _set(f'policy.{field}', True))
        add(f'policy-{field}-fraction', _set(f'policy.{field}', ok + 0.5))
        add(f'policy-{field}-string', _set(f'policy.{field}', str(ok)))
        add(f'policy-{field}-null', _set(f'policy.{field}', None))

    # http.
    for name, value in [
        ('other-port', 8080), ('below', 7999), ('bool', True),
        ('fraction', 8000.5), ('string', '8000'), ('null', None), ('list', [8000]),
    ]:
        add(f'http-{name}', _set('http', value))

    # ports.
    for name, value in [
        ('reordered', list(reversed(PORTS))),
        ('missing-last', list(PORTS[:-1])),
        ('extra-ssh', list(PORTS) + ['tcp:22']),
        ('duplicate', list(PORTS[:-1]) + [PORTS[0]]),
        ('uppercase-protocol', ['TCP:47984'] + list(PORTS[1:])),
        ('integer-entry', [47984] + list(PORTS[1:])),
        ('joined-string', ','.join(PORTS)),
        ('empty', []),
        ('object', {'tcp': [47984, 47989, 48010], 'udp': [47998, 47999, 48000]}),
    ]:
        add(f'ports-{name}', _set('ports', value))

    # secretDeployment.
    for name, value in [
        ('zero', '0x' + '0' * 64),
        ('no-prefix', '33' * 32),
        ('uppercase-prefix', '0X' + '33' * 32),
        ('uppercase-hex', '0x' + 'AB' * 32),
        ('short', '0x' + '33' * 31),
        ('long', '0x' + '33' * 33),
        ('integer', 51),
        ('trailing-newline', '0x' + '33' * 32 + '\n'),
    ]:
        add(f'secret-deployment-{name}', _set('secretDeployment', value))

    # configBase64: encoding.
    base_b64 = _b64(BASE_CONFIG)
    for name, value in [
        ('empty', ''),
        ('null', None),
        ('object', {'codec': 'h264'}),
        ('unpadded', _b64('{}').rstrip('=')),
        ('extra-padding', _b64('{}') + '=='),
        ('non-canonical-trailing-bits', 'e31='),
        ('url-safe-alphabet', _urlsafe_only_config()),
        ('trailing-newline', base_b64 + '\n'),
        ('leading-space', ' ' + base_b64),
        ('embedded-line-break', base_b64[:8] + '\r\n' + base_b64[8:]),
        ('non-ascii-char', base_b64 + 'é'),
        ('padding-in-middle', 'e3=0'),
    ]:
        add(f'config-base64-{name}', _set('configBase64', value))
    # configBase64: decoded bytes.
    for name, data in [
        ('invalid-utf8', b'{"a":"\xff"}'),
        ('overlong-utf8', b'{"a":"\xc0\xaf"}'),
        ('encoded-surrogate-utf8', b'{"a":"\xed\xa0\x80"}'),
        ('raw-nul-in-string', b'{"a":"\x00"}'),
        ('raw-nul-after-object', b'{}\x00'),
        ('utf8-bom', b'\xef\xbb\xbf{}'),
        ('too-long', _config_of_length(CONFIG_MAX_BYTES + 1).encode('ascii')),
    ]:
        add(f'config-{name}', _config(data))
    # configBase64: JSON.
    add('config-depth-over-limit', _config('{"a":' + '[' * CONFIG_MAX_DEPTH + ']' * CONFIG_MAX_DEPTH + '}'))
    add('config-depth-hidden-by-duplicate', _config('{"a":' + '[' * CONFIG_MAX_DEPTH + ']' * CONFIG_MAX_DEPTH + ',"a":0}'))
    for name, text in [
        ('array', '[]'),
        ('null', 'null'),
        ('true', 'true'),
        ('string', '"text"'),
        ('number', '1'),
        ('whitespace-only', ' '),
        ('bare-nan', 'NaN'),
        ('nan-value', '{"a":NaN}'),
        ('infinity-value', '{"a":Infinity}'),
        ('negative-infinity-value', '{"a":-Infinity}'),
        ('trailing-comma', '{"a":1,}'),
        ('array-trailing-comma', '{"a":[1,]}'),
        ('single-quotes', "{'a':1}"),
        ('unquoted-key', '{a:1}'),
        ('missing-value', '{"a"}'),
        ('line-comment', '{"a":1}//comment'),
        ('block-comment', '{/*c*/"a":1}'),
        ('two-objects', '{"a":1} {"b":2}'),
        ('trailing-garbage', '{}x'),
        ('leading-zero', '{"a":01}'),
        ('trailing-dot', '{"a":1.}'),
        ('leading-dot', '{"a":.5}'),
        ('leading-plus', '{"a":+1}'),
        ('hex-number', '{"a":0x10}'),
        ('raw-tab-in-string', '{"a":"tab\there"}'),
        ('raw-newline-in-string', '{"a":"line\nbreak"}'),
        ('invalid-escape', r'{"a":"\x41"}'),
        ('short-unicode-escape', r'{"a":"\u12"}'),
        ('unterminated', '{"a":1'),
        ('unterminated-string', '{"a":"x}'),
        ('form-feed-whitespace', '{"a":1}\f'),
        ('nbsp-whitespace', '{"a":1} '),
        ('python-literal', '{"a":True}'),
        ('undefined-literal', '{"a":undefined}'),
    ]:
        add(f'config-json-{name}', _config(text))

    # desktop.
    add('desktop-not-object', _set('desktop', PROFILE))
    add('desktop-list', _set('desktop', [PROFILE, '44' * 32, 750]))
    for field in sorted(DESKTOP_FIELDS):
        add(f'desktop-missing-{field}', _drop(f'desktop.{field}'))
    for name, value in [
        ('unmasked', 'kvm-box-unmasked-v1'),
        ('next-version', 'kvm-box-masked-v2'),
        ('previous-version', 'kvm-box-masked-v0'),
        ('uppercase', PROFILE.upper()),
        ('trailing-space', PROFILE + ' '),
        ('empty', ''),
        ('image-path', '/var/lib/images/kvm-box-masked-v1.img'),
        ('device-path', '/dev/dri/renderD128'),
        ('arbitrary', 'custom-desktop'),
        ('null', None),
    ]:
        add(f'desktop-profile-{name}', _set('desktop.profile', value))
    for name, value in [
        ('zero', '0' * 64),
        ('uppercase', 'AB' * 32),
        ('prefixed', '0x' + '44' * 32),
        ('short', '4' * 63),
        ('long', '4' * 65),
        ('non-hex', 'z' * 64),
        ('trailing-newline', '44' * 32 + '\n'),
    ]:
        add(f'desktop-profile-sha256-{name}', _set('desktop.profileSha256', value))
    for name, value in [
        ('below-minimum', 499), ('above-maximum', 1001), ('zero', 0),
        ('bool', True), ('fraction', 750.5), ('string', '750'), ('null', None),
    ]:
        add(f'desktop-gpu-milli-{name}', _set('desktop.gpuMilli', value))
    for field, value in [
        ('device', '/dev/dri/renderD128'),
        ('devices', ['/dev/kvm']),
        ('unmasked', True),
        ('masked', False),
        ('imagePath', '/var/lib/images/desktop.img'),
        ('imageSha256', '66' * 32),
        ('kernel', 'vmlinuz-6.6.87.2-enclave-kvm-box'),
        ('args', ['--device', '/dev/dri/card0']),
        ('shell', '/bin/sh'),
        ('inference', 'legacy'),
        ('label', 'desktop'),
    ]:
        add(f'desktop-extra-{field}', _set(f'desktop.{field}', value))

    # component.
    for name, component in [
        ('empty', b''),
        ('core-module-preamble', bytes.fromhex('0061736d01000000') + b'module'),
        ('truncated-preamble', COMPONENT_PREAMBLE[:7]),
        ('wrong-layer', bytes.fromhex('0061736d0d000200') + b'body'),
        ('wrong-version', bytes.fromhex('0061736d0e000100') + b'body'),
        ('offset-preamble', b'\x00' + COMPONENT_PREAMBLE + b'body'),
        ('elf-native', b'\x7fELF\x02\x01\x01\x00' + b'\x00' * 8),
        ('shell-script', b'#!/bin/sh\nexec start-desktop\n'),
    ]:
        add(f'component-{name}', _identity, component)
    return cases


def _json_roundtrip(value):
    return json.loads(json.dumps(value))


def _check_bundle(bundle, mapping, component):
    start = len(BUNDLE_MAGIC)
    if bundle[:start] != BUNDLE_MAGIC:
        raise AssertionError('bundle magic')
    (manifest_len,) = struct.unpack_from('<I', bundle, start)
    manifest = bundle[start + 4:start + 4 + manifest_len]
    (component_len,) = struct.unpack_from('<I', bundle, start + 4 + manifest_len)
    body = bundle[start + 8 + manifest_len:]
    if len(manifest) != manifest_len or manifest_len > MANIFEST_MAX_BYTES:
        raise AssertionError('manifest length')
    if component_len != len(body) or body != component:
        raise AssertionError('component framing')
    parsed = json.loads(manifest.decode('ascii'))
    if canonical_json(parsed) != manifest or set(parsed) != MANIFEST_FIELDS:
        raise AssertionError('manifest is not canonical or has wrong fields')
    if parsed['artifact'] != {'kind': ARTIFACT_KIND, 'sha256': mapping['componentSha256']}:
        raise AssertionError('manifest artifact')
    if set(mapping) != MAPPING_FIELDS:
        raise AssertionError('mapping fields')
    if (mapping['appId'] != _sha256_hex(bundle) or mapping['bundleBytes'] != len(bundle)
            or mapping['componentBytes'] != len(component)
            or mapping['recordSha256'] != _sha256_hex(canonical_json(mapping['record']))):
        raise AssertionError('mapping digests')


def _expect_refused(name, record, component):
    try:
        derive(record, component)
    except RefusedError:
        return
    raise AssertionError(f'negative fixture {name!r} was accepted')


def build_vectors():
    component = FIXTURE_COMPONENT
    _, base_mapping = derive(base_record(), component)
    names = set()

    ok = []
    for name, mutate, relation in _positive_cases():
        if name in names:
            raise AssertionError(f'duplicate fixture name {name!r}')
        names.add(name)
        record = mutate(base_record())
        snapshot = copy.deepcopy(record)
        bundle, mapping = derive(record, component)
        if record != snapshot:
            raise AssertionError(f'derive mutated its input in {name!r}')
        _check_bundle(bundle, mapping, component)
        if derive(_json_roundtrip(record), component) != (bundle, mapping):
            raise AssertionError(f'{name!r} does not survive JSON emission')
        if relation == IDENTITY:
            if mapping['appId'] == base_mapping['appId']:
                raise AssertionError(f'{name!r} should change appId')
        elif relation == SEPARATE:
            if (mapping['appId'] != base_mapping['appId']
                    or mapping['recordSha256'] == base_mapping['recordSha256']):
                raise AssertionError(f'{name!r} should change only recordSha256')
        ok.append({'name': name, 'record': copy.deepcopy(record),
                   'mapping': mapping, 'bundle_hex': bundle.hex()})

    refused = []
    for name, mutate, bad_component in _negative_cases():
        if name in names:
            raise AssertionError(f'duplicate fixture name {name!r}')
        names.add(name)
        record = mutate(base_record())
        candidate = component if bad_component is None else bad_component
        _expect_refused(name, record, candidate)
        _expect_refused(name, _json_roundtrip(record), candidate)
        refused.append({'name': name, 'record': copy.deepcopy(record),
                        'component_hex': candidate.hex()})

    return {'component_hex': component.hex(), 'ok': ok, 'refused': refused}


def main(argv):
    if argv != ['vectors']:
        print('usage: python reference.py vectors', file=sys.stderr)
        return 2
    json.dump(build_vectors(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
