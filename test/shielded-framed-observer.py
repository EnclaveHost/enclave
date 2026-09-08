#!/usr/bin/env python3
from pathlib import Path
import importlib.util
import random
import struct

spec = importlib.util.spec_from_file_location('observer', (Path(__file__).resolve().parent.parent/'shielded/anchor/avf/host').joinpath('framed-observer.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
FrameObserver = module.FrameObserver
pack = lambda kind, body: struct.pack('<BQ', kind, len(body))+body
field = lambda nodes, m, k=32: struct.pack('<II'+'I'*len(nodes), len(nodes), m, *nodes) + b'\x91'*(3*m*k)
wire = pack(0, b'hello')+pack(12, field([4, 9], 3))+pack(8, b'\xff'*4097)+pack(13, field([7], 1))+pack(2, b'')
expected = [(0, 5), (12, 8+8+3*3*32), (8, 4097), (13, 8+4+3*32), (2, 0)]
count = 0

def check(name, good):
    global count
    if not good: raise AssertionError(name)
    count += 1

for seed in range(100):
    rng, got = random.Random(seed), []
    observer = FrameObserver('request', got.append)
    pos = 0
    while pos < len(wire):
        size = rng.randint(1, 1000)
        observer.feed(wire[pos:pos+size], float(pos)); pos += size
    summary = observer.eof()
    assert [(e['kind'], e['body_bytes']) for e in got] == expected
    assert summary == dict(frames=5, field_exchanges=2, wire_bytes=len(wire))
    assert got[1]['nodes'] == [4, 9] and got[1]['rows'] == 3 and got[1]['K'] == 32
    assert got[3]['field_sequence'] == 2 and got[3]['nodes'] == [7]
    assert all(e['first_observed_mono'] <= e['header_observed_mono'] <= e['complete_observed_mono'] for e in got)
    assert not observer.header and not observer.meta
check('100 independent randomized chunkings preserve frame ordinals and public metadata', True)

got = []; observer = FrameObserver('request', got.append)
observer.feed(wire, 1)
check('coalesced frames have separate observations', len(got) == 5 and got[-1]['sequence'] == 5)
observer = FrameObserver('request', lambda e: None)
data = pack(12, field(list(range(64)), 4096))
observer.feed(data[:9+264], 1)
check('at most protocol metadata is retained before a large body', len(observer.header) == 9 and len(observer.meta) == 264)
for pos in range(9+264, len(data), 1024): observer.feed(data[pos:pos+1024], 2)
check('large body discarded after observation', observer.eof()['frames'] == 1 and not observer.meta)

got = []; observer = FrameObserver('reply', got.append)
observer.feed(pack(0, b'\xff\x00\x91')+pack(1, b'private failure content'), 0)
check('reply payload stays opaque including violation content', len(got) == 2 and all('nodes' not in e for e in got))

for label, blob in (
    ('oversized length', struct.pack('<BQ', 8, module.MAX_FRAME+1)),
    ('short field metadata', pack(12, b'1234')),
    ('zero nodes', pack(12, struct.pack('<II', 0, 1)+b'\x00'*96)),
    ('too many nodes', pack(12, struct.pack('<II', 65, 1)+b'\x00'*96)),
    ('zero rows', pack(12, struct.pack('<III', 1, 0, 0)+b'\x00'*96)),
    ('too many rows', pack(12, field([0], 4097))),
    ('malformed plane length', pack(12, field([0], 1)+b'x')),
    ('K not a multiple of32', pack(12, field([0], 1, 33))),
):
    refused = False
    try: FrameObserver('request', lambda e: None).feed(blob, 0)
    except ValueError: refused = True
    check(label, refused)

for n in (1, 8, 9, 12, len(wire)-1):
    refused = False
    observer = FrameObserver('request', lambda e: None)
    try: observer.feed(wire[:n], 1); observer.eof()
    except ValueError: refused = True
    check(f'partial frame at EOF {n}', refused)

observer = FrameObserver('reply', lambda e: None, max_frames=1)
refused = False
try: observer.feed(pack(0, b'')*2, 0)
except ValueError: refused = True
check('bounded zero-length frame flood', refused)
for bad in (float('nan'), float('inf'), -1, True):
    refused = False
    try: FrameObserver('reply', lambda e: None).feed(b'x', bad)
    except ValueError: refused = True
    check('invalid clock', refused)
observer = FrameObserver('reply', lambda e: None); observer.feed(b'\x00', 2)
refused = False
try: observer.feed(b'x', 1)
except ValueError: refused = True
check('reversed clock refused', refused)
print(f'{count} bounded frame observation cases PASS')
