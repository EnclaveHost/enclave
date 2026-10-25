#!/usr/bin/env python3
"""TEST DOUBLE for the pinned `base` binary: implements ONLY the audited `base reth` surface used by a2a4.py, over a JSON
state file ($FAKE_STATE), and logs every argv to $FAKE_LOG. Faithful to the audited semantics: `db get` of a missing key
prints nothing and exits 0; `stage unwind to-block T` keeps T and truncates everything above; merkle `--from 0` rebuilds
and exits 1 when the rebuilt root differs from header(N).stateRoot; hashing stages would destroy v2 state."""
import json, os, sys
S = os.environ['FAKE_STATE']; st = json.load(open(S)); a = sys.argv[1:]
open(os.environ['FAKE_LOG'], 'a').write(json.dumps(a) + '\n')
open(os.environ['FAKE_LOG'] + '.pid', 'w').write(str(os.getpid()))
import time
INJ = '--help' not in a                               # fault injections hit the real operation, never a help probe
if INJ and os.environ.get('FAKE_SLEEP') and os.environ['FAKE_SLEEP'] in ' '.join(a): time.sleep(60)
if INJ and os.environ.get('FAKE_BIG') and os.environ['FAKE_BIG'] in ' '.join(a):
    sys.stdout.write('x' * (2 << 20)); sys.exit(0)                    # oversize, then exit at once
if INJ and os.environ.get('FAKE_ORPHAN') and os.environ['FAKE_ORPHAN'] in ' '.join(a):
    import subprocess as _sp
    c = _sp.Popen(['sleep', '30'], stdin=_sp.DEVNULL, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)   # same process group, no setsid
    open(os.environ['FAKE_LOG'] + '.orphan', 'w').write(str(c.pid)); print('StorageSettings { storage_v2: true }'); os._exit(0)
if INJ and os.environ.get('FAKE_SPAM') and os.environ['FAKE_SPAM'] in ' '.join(a):
    sys.stdout.write('x' * (4 << 20)); sys.stdout.flush(); time.sleep(60)
def save(): json.dump(st, open(S, 'w'))
assert a[0] == 'reth', a
a = a[1:]
if '--help' in a:
    print(st['help'].get(' '.join(a[:2]) if a[1] != '--help' else a[0], '')); sys.exit(0)
def opt(name):
    return a[a.index(name) + 1] if name in a else None
if a[:1] == ['db']:
    rest = a[5:] if a[3:4] == ['--config'] else a[3:]   # db --datadir D [--config F] ...
    if rest[:2] == ['settings', 'get']: print(f"StorageSettings {{ storage_v2: {str(st['v2']).lower()} }}"); sys.exit(0)
    if rest[:2] == ['stage-checkpoints', 'get']:
        for k, v in st['cp'].items(): print(f'{k}: Some(StageCheckpoint {{ block_number: {v}, stage_checkpoint: None }})')
        sys.exit(0)
    if rest[:3] == ['get', 'static-file', 'headers']:
        n = int(rest[3]); h = st['headers'].get(str(n))
        if h is not None and n <= st['headersTip']: print('Header'); print(json.dumps(h, indent=1)); print(); print('BlockHash'); print('"0xdeadbeef"')
        else: print('', end='')                      # missing key: nothing, exit 0 (the audited fail-open behaviour)
        sys.exit(0)
    if rest[:3] == ['get', 'mdbx', 'ChainState']:
        v = st['labels'].get(rest[3]); print('' if v is None else v); sys.exit(0)
    sys.exit(9)
if a[:2] == ['stage', 'unwind']:
    t = int(a[-1]); stop = st.get('unwindStopsAt')
    if stop is not None and t < stop: t = stop      # simulate an unwind that silently stops short
    for k in st['cp']:
        if k != 'merkle-execute' or st['cp'][k] > t: st['cp'][k] = min(st['cp'][k], t)
    if not st.get('keepHeadersAbove'): st['headersTip'] = min(st['headersTip'], t)
    for k in st['labels']: st['labels'][k] = min(st['labels'][k], t)
    save(); sys.exit(0)
if a[:2] == ['stage', 'drop']:
    if a[-1] in ('hashing', 'account-hashing', 'storage-hashing', 'execution') and st['v2']: st['canonicalStateDestroyed'] = True
    if a[-1] == 'merkle': st['cp']['merkle-execute'] = 0; st['trieDropped'] = True
    save(); sys.exit(0)
if a[:2] == ['stage', 'run']:
    frm, to = int(opt('--from')), int(opt('--to'))
    if a[-1] == 'merkle':
        if frm != 0: sys.exit(0)                     # the audited trap: an empty/partial range "passes" trivially
        if st['rebuiltRoot'] != st['headers'][str(to)]['stateRoot']:
            print('BodyStateRootDiff', file=sys.stderr); sys.exit(1)
        if '--checkpoints' in a: st['cp']['merkle-execute'] = to   # the pinned help: checkpoints saved ONLY with --checkpoints
        save(); sys.exit(0)
    sys.exit(0)
sys.exit(9)
