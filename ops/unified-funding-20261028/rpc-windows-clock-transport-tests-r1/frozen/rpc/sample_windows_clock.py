"""Consume one authenticated Windows clock query in the original startup window.

The sampler must already be independently qualified and staged in a protected
Windows namespace. Call only inside an admitted owner envelope. Transport exit
never proves remote death. No VM mutation, retry or fresh startup clock here.
"""
import base64
import hashlib
import importlib.util
from pathlib import Path
import re


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


clock = load('startup_clock')
delivery = load('deliver_activation')


def sample(config):
    if set(config) != {'begin', 'target', 'knownHosts', 'hostAlias', 'sshSha256',
                       'samplerPath', 'samplerSha256', 'windowsBoot'}:
        raise ValueError('Exact clock transport configuration required')
    original = clock.read_pinned(config['begin'])
    row = clock.protocol.decode(original)
    root = clock.directory(Path(config['begin']['path']).parent)
    if Path(config['begin']['path']).name != 'begin.json':
        raise ValueError('Original begin filename required')
    clock.validate_begin(row, root)
    clock.current(row, True)
    clock.hex32(config['windowsBoot'])
    clock.protocol.digest(config['samplerSha256'])
    clock.protocol.digest(config['sshSha256'])
    if hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest() != config['sshSha256']:
        raise ValueError('SSH binary differs')
    target = delivery.endpoint(config['target'])
    # Windows default OpenSSH command shell receives only this fixed executable
    # path and lowercase hex arguments; no PowerShell or shell metacharacters.
    path = config['samplerPath']
    if not isinstance(path, str) or len(path) > 220 or not re.fullmatch(r'[A-Z]:\\(?:[A-Za-z0-9_-]+\\)+clock-sample\.exe', path):
        raise ValueError('Exact protected sampler path required')
    alias = config['hostAlias']
    if not isinstance(alias, str) or not re.fullmatch('[a-zA-Z0-9_.-]{1,100}', alias):
        raise ValueError('Exact host alias required')
    known = clock.read_pinned(config['knownHosts'])
    fields = known.decode('ascii').strip().split()
    if len(fields) != 3 or fields[:2] != [alias, 'ssh-ed25519'] or known.count(b'\n') > 1:
        raise ValueError('One pinned Windows Ed25519 host key required')
    key = base64.b64decode(fields[2], validate=True)
    if len(key) != 51 or key[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
        raise ValueError('Invalid Windows host key')
    command = '"' + path + '" ' + row['attempt'] + ' ' + row['vmAttempt'] + ' ' + config['samplerSha256']
    clock.current(row, True)
    # A valid request is consumed before the sole transport, including ambiguity.
    clock.write_new(root / 'sampling.intent', clock.encode({
        'beginSha256': config['begin']['sha256'], 'configurationSha256': clock.protocol.sha(clock.encode(config)),
        'windowsBoot': config['windowsBoot'], 'samplerSha256': config['samplerSha256'],
        'outcome': 'unresolved-until-bound-clock'}))
    clock.write_new(root / 'windows-known-hosts', known)
    argv = delivery.ssh_options(root / 'windows-known-hosts', alias) + target + [command]
    if clock.read_pinned(config['begin']) != original or clock.read_pinned(config['knownHosts']) != known:
        raise ValueError('Clock inputs changed before transport')
    _, _, elapsed = clock.current(row, True)
    remaining = (10_000_000_000 - elapsed) / 1e9
    if remaining <= 0:
        raise TimeoutError('Original handshake deadline expired')
    # Exactly one local transport call. Its group cleanup is not remote death.
    raw = delivery.exchange(argv, b'', min(8, remaining))
    _, _, elapsed = clock.current(row, True)
    value = clock.protocol.decode(raw)
    clock.compose(row, value, elapsed, config['begin']['sha256'], clock.protocol.sha(raw))
    if value['windowsBoot'] != config['windowsBoot']:
        raise ValueError('Windows rebooted since reviewed admission')
    binding = clock.write_new(root / 'authenticated-sample.json', raw)
    return clock.finish(config['begin'], binding)
