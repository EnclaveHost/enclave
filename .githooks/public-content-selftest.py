#!/usr/bin/env python3
"""Public bundle data must not hide an actual secret beside it."""
import importlib.util, pathlib, secrets
p = pathlib.Path(__file__).with_name('scan-crypto-keys.py')
spec = importlib.util.spec_from_file_location('scanner', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
words = list(m.BIP39)
# A complete dictionary is public. A real mnemonic before/after it still fails.
entropy = secrets.token_bytes(16)
bits = (int.from_bytes(entropy, 'big') << 4) | (m.hashlib.sha256(entropy).digest()[0] >> 4)
phrase = ' '.join(words[(bits >> (11 * (11-i))) & 2047] for i in range(12))
dictionary = '\n'.join(words)
assert not m.scan_text(dictionary, 'bundle.mjs')
for data in (phrase+';\n'+dictionary, dictionary+';\n'+phrase):
    assert any(f.rule == 'mnemonic' for f in m.scan_text(data, 'bundle.mjs'))
for path, digest in m.VERIFIED_BUNDLE_DIGESTS:
    line = f'  "{path}": "{digest}",'
    assert not m.scan_text(line, 'bundle.manifest.json')
    assert any(f.rule == 'eth-key' for f in m.scan_text(line.replace(digest, secrets.token_hex(32)), 'bundle.manifest.json'))
    assert any(f.rule == 'eth-key' for f in m.scan_text(f'privateKey = "{digest}"', 'bundle.manifest.json'))
half = '7f' + 'ff' * 15 + '5d576e7357a4501ddfe92f46681b20a0'
registry = b'registry'.hex().ljust(64, '0')
for line in (f'uint256 private constant HALF_N = 0x{half};', f'BOOK_KEY_REGISTRY = "0x{registry}";'):
    assert not m.scan_text(line, 'public-source.js')
    assert any(f.rule == 'eth-key' for f in m.scan_text(line.replace('HALF_N', 'PRIVATE_KEY').replace('BOOK_KEY_REGISTRY', 'PRIVATE_KEY'), 'public-source.js'))
print('Public-content exceptions and adjacent secret detection passed')
