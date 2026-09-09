"""Offline review converter. Input must be the checked exporter output.

This does not establish authority for a digest. Deployment must pin the resulting
catalog SHA in measured code/assets independently of the artifact delivery path.
"""
import hashlib
import json
from pathlib import Path
import struct


def encode(d):
    assert d['format'] == 'enclave-gguf-digest-catalog-v0'
    ts = d['tensors']
    assert 0 < len(ts) <= 65536
    out = bytearray(b'AGCAT001')
    out += struct.pack('<IIQQQQ', len(ts), d['gguf_version'], d['file_size'],
                       d['header_len'], d['data_start'], d['alignment'])
    out += bytes.fromhex(d['model_sha256']) + bytes.fromhex(d['header_sha256'])
    assert len(out) == 112
    for t in ts:
        name = bytes.fromhex(t['name_hex'])
        assert 0 < len(name) < 128 and b'\0' not in name
        out += name.ljust(128, b'\0')
        out += struct.pack('<II4QQQ', t['n_dims'], t['type'], *t['ne'], t['offset'], t['size'])
        out += bytes.fromhex(t['sha256'])
    assert len(out) == 112 + 216 * len(ts)
    return bytes(out)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input', type=Path)
    ap.add_argument('output', type=Path)
    a = ap.parse_args()
    raw = encode(json.loads(a.input.read_text()))
    with a.output.open('xb') as f:
        f.write(raw)
    print(json.dumps(dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())))
