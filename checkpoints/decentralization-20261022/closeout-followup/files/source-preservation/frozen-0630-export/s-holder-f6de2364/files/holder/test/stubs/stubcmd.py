#!/usr/bin/env python3
"""TEST STUB for privileged storage commands (invoked through symlinks named losetup, dmsetup, mount, umount, findmnt,
lsblk, blockdev, mkfs.ext4, e2fsck, modprobe, chown). State: $STUB_STATE (JSON). Rotational map: $STUB_ROT (JSON
{path_prefix: "0"|"1"}). Failure injection: $STUB_FAIL = comma-separated keys (e.g. "dmsetup-create,umount")."""
import json, os, sys
name = os.path.basename(sys.argv[0]); a = sys.argv[1:]
SP = os.environ['STUB_STATE']
st = json.load(open(SP)) if os.path.exists(SP) else {'loops': {}, 'dm': {}, 'mounts': {}, 'calls': [], 'next': 0}
fails = set(filter(None, os.environ.get('STUB_FAIL', '').split(',')))
rot = json.loads(os.environ.get('STUB_ROT', '{}'))
st['calls'].append([name] + a)
def save(): json.dump(st, open(SP, 'w'))
def done(out=None, rc=0):
    save()
    if out is not None: print(out)
    sys.exit(rc)
def mm(dev):
    if dev.startswith('/dev/loop'): return '7:' + dev[9:]
    if dev.startswith('/dev/mapper/'): return '253:%d' % sorted(st['dm']).index(dev[12:]) if dev[12:] in st['dm'] else None
    return None
def prefix(path):
    p = os.path.realpath(path); best = max((k for k in rot if p.startswith(k)), key=len, default=None); return best
if name == 'losetup':
    if '--find' in a:
        if 'losetup-attach' in fails: done(rc=1)
        f = os.path.realpath(a[-1]); dev = '/dev/loop%d' % st['next']; st['next'] += 1; st['loops'][dev] = f; done(dev)
    if '-j' in a:
        f = os.path.realpath(a[a.index('-j') + 1]); done('\n'.join(d for d, b in st['loops'].items() if b == f) or None)
    if '-d' in a:
        if 'losetup-detach' in fails: done(rc=1)
        st['loops'].pop(a[a.index('-d') + 1], None); done()
if name == 'dmsetup':
    op, n = a[0], a[1]
    if op == 'info': done(rc=0 if n in st['dm'] else 1)
    if op == 'table': done(st['dm'][n]) if n in st['dm'] else done(rc=1)
    if op == 'status':
        t = st['dm'].get(n); done('0 %s cache 8 10/100 512 5/10 0 0 0 0 0 0 0 %s' % (t.split()[1], ' '.join(t.split()[8:]))) if t else done(rc=1)
    if op == 'create':
        if 'dmsetup-create' in fails: done(rc=1)
        st['dm'][n] = a[a.index('--table') + 1]; done()
    if op == 'remove':
        if 'dmsetup-remove' in fails: done(rc=1)
        st['dm'].pop(n, None); done()
if name == 'lsblk':
    dev = a[-1]
    if 'MAJ:MIN' in a: done(mm(dev))
    if 'ROTA' in a: done(rot[dev[5:]] if dev.startswith('fake:') else '1')
    if 'MOUNTPOINTS' in a: done('\n'.join(m for m, x in st['mounts'].items() if x == mm(dev)))
if name == 'findmnt':
    if '--target' in a: done('fake:' + prefix(a[a.index('--target') + 1]))
    m = a[-1]
    if 'MAJ:MIN' in a: done(st['mounts'].get(m)) if m in st['mounts'] else done(rc=1)
    done(rc=0 if m in st['mounts'] else 1)
if name == 'mount':
    if 'mount' in fails: done(rc=1)
    st['mounts'][a[-1]] = mm(a[-2]); done()
if name == 'umount':
    if 'umount' in fails: done(rc=1)
    st['mounts'].pop(a[-1], None); done()
if name == 'blockdev':
    dev = a[-1]; f = st['loops'].get(dev); done(str(os.path.getsize(f) // 512) if f else '0')
if name == 'mkfs.ext4':
    if 'mkfs' in fails: done(rc=1)
    done()
if name == 'e2fsck':
    meta = os.environ.get('STUB_CMETA')
    if meta: st['metaZeroAtFsck'] = open(meta, 'rb').read(8 << 20) == bytes(8 << 20)
    done()
if name in ('modprobe', 'chown'): done()
done(rc=97)
