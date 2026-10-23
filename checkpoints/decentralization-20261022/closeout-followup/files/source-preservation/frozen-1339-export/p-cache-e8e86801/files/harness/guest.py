#!/usr/bin/env python3
"""INSIDE the throwaway guest, as root, one boot. Exercises the 32-line COMPOSED delta (S template cab32bbe, rendered by
S's and P's own renderers) on REAL guest-kernel loop/dm-crypt/ext4/dm-cache devices on owned virtual disks:
  A  real lsblk/losetup facts the new checks rely on (holders listed as children, MOUNTPOINTS, autoclear)
  B  disassemble refuses a loop held by a foreign mapping / mounted elsewhere, WITHOUT setting autoclear (old template:
     control, sets autoclear and "succeeds")
  C  cache-loss detaches only the loop it attached; a pre-existing loop stays (old template: control, leaves its loop)
  D  free-space credit only for owned regular same-filesystem files: adoption, unmarked foreign, symlink (+ the
     sh:credit-symlink mutant assessed), cache metadata on another filesystem
  E  retained: SIGTERM unwind sweep; fsync'd data across disassemble + cache-loss + assemble
Every command, exit code and identity receipt -> /out/receipts.jsonl; results -> /out/results.json."""
import hashlib, json, os, re, signal, subprocess, sys, time
from pathlib import Path

OUT = Path('/out'); R = OUT / 'render'
REC = open(OUT / 'receipts.jsonl', 'a', buffering=1)
ENV = {'PATH': '/usr/bin', 'LANG': 'C.UTF-8', 'DM_DISABLE_UDEV': '1', 'HOME': '/root'}
LEDGER = '/etc/enclave-rpc-cache/nvme-cache-budget.json'
HC, PC, QC = (json.loads((R / f'{n}.json').read_text()) for n in ('holder', 'pair', 'probe'))
S = {n: str(R / f'{n}-storage.sh') for n in ('holder', 'pair', 'probe', 'old-holder')}
MUT = str(R / 'mutant-credit-symlink.sh')
MK = '.enclave-budget-owner'
KEY = OUT / 'fixture.key'
RESULTS = {}


def rec(kind, **kw):
    REC.write(json.dumps(dict(kind=kind, t=round(time.time(), 3), **kw), default=str) + '\n')


def result(k, v):
    RESULTS[k] = v; rec('result', key=k, value=v)


def sh(cmd, check=False, label=None, timeout=300):
    p = subprocess.run(cmd, shell=isinstance(cmd, str), env=ENV, capture_output=True, text=True, timeout=timeout)
    rec('cmd', label=label, cmd=cmd if isinstance(cmd, str) else ' '.join(cmd), rc=p.returncode, out=p.stdout[-2000:], err=p.stderr[-2000:])
    if check and p.returncode:
        raise SystemExit(f'FAILED {label or cmd}: rc={p.returncode} {p.stderr[-400:]}')
    return p


def run(script, verb):
    return sh([script, verb], label=f'{Path(script).name} {verb}')


def short(p):
    return {'rc': p.returncode, 'err': p.stderr.strip()[-260:]}


def loops_of(f):
    return re.findall(r'^(/dev/loop\d+):', sh(['losetup', '-j', f], label='id').stdout, re.M)


def loop_facts(l):
    n = l.rsplit('/', 1)[1]
    def rd(p):
        try:
            return Path(p).read_text().strip()
        except OSError:
            return None
    return {'loop': l, 'backing': rd(f'/sys/block/{n}/loop/backing_file'), 'autoclear': rd(f'/sys/block/{n}/loop/autoclear'),
            'holders': sorted(os.listdir(f'/sys/block/{n}/holders')) if os.path.isdir(f'/sys/block/{n}/holders') else None,
            'lsblkName': sh(['lsblk', '-nro', 'NAME', l], label='lsblk NAME').stdout.splitlines(),
            'lsblkMountpoints': sh(['lsblk', '-nro', 'MOUNTPOINTS', l], label='lsblk MOUNTPOINTS').stdout.split()}


def attach(f, label):
    l = sh(['losetup', '--find', '--show', f], check=True, label=label).stdout.strip()
    rec('ownLoop', loop=l, file=f, ino=os.stat(f).st_ino)
    return l


def own_detach(l, f):
    """Detach a loop THIS test attached, only after re-checking its backing file and inode."""
    n = l.rsplit('/', 1)[1]
    back = Path(f'/sys/block/{n}/loop/backing_file').read_text().strip() if os.path.exists(f'/sys/block/{n}/loop/backing_file') else None
    ok = back == os.path.realpath(f)
    rec('ownDetach', loop=l, file=f, backing=back, ok=ok)
    if ok:
        sh(['losetup', '-d', l], check=True, label=f'detach OWN test loop {l}')
    return ok


def identity(tag):
    loops = json.loads(sh('losetup -J -l -O NAME,BACK-FILE,BACK-INO,MAJ:MIN,AUTOCLEAR', label='id').stdout or '{}').get('loopdevices') or []
    dm = sh('dmsetup info -c --noheadings -o name', label='id').stdout.split()
    mnts = [l.split()[4] for l in open('/proc/self/mountinfo') if re.search(r' /(srv|usbtest|vmtest|vmtest2|mnt-raw)[ /]', l)]
    ident = {'loops': loops, 'dm': dm, 'mounts': mnts}
    rec('identity', tag=tag, **ident)
    return ident


def gen(seed, n):
    out, i = bytearray(), 0
    while len(out) < n:
        out += hashlib.sha256(f'{seed}:{i}'.encode()).digest(); i += 1
    return bytes(out[:n])


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def falloc(p, n):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as h:
        os.posix_fallocate(h.fileno(), 0, n); h.flush(); os.fsync(h.fileno())


def avail(d):
    st = os.statvfs(d); return st.f_bavail * st.f_frsize


def with_margin(script, margin, tag):
    """The ONLY run-time seam: the rendered NVME_FREE_MARGIN constant line (same script bytes otherwise)."""
    t = Path(script).read_text()
    assert t.count("NVME_FREE_MARGIN='0'") == 1
    p = Path(f'/tmp/{tag}-{Path(script).name}')
    p.write_text(t.replace("NVME_FREE_MARGIN='0'", f"NVME_FREE_MARGIN='{margin}'")); p.chmod(0o755)
    return str(p)


def disk(serial):
    for b in sorted(os.listdir('/sys/block')):
        v = Path(f'/sys/block/{b}/device/vpd_pg80')
        if v.exists() and serial.encode() in v.read_bytes():
            return f'/dev/{b}', Path(f'/sys/block/{b}/queue/rotational').read_text().strip()
    raise SystemExit(f'no disk {serial}')


def setup():
    hdd, hr = disk('enc-hdd'); nv, nr = disk('enc-nvme')
    rec('disks', hdd=hdd, hddRot=hr, nvme=nv, nvmeRot=nr, kernel=os.uname().release)
    assert (hr, nr) == ('1', '0')
    for m in ('loop', 'dm-crypt'):
        sh(['modprobe', m], check=True, label=f'modprobe {m}')
    KEY.write_bytes(os.urandom(64)); KEY.chmod(0o600)
    sh(['cryptsetup', 'luksFormat', '--batch-mode', '--type', 'luks2', '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '1000', '--key-file', str(KEY), nv], check=True, label='luksFormat')
    sh(['cryptsetup', 'open', '--key-file', str(KEY), nv, 'vmtest-crypt'], check=True, label='open dm-crypt')
    sh(['mkfs.ext4', '-q', '-b', '4096', '/dev/mapper/vmtest-crypt'], check=True, label='mkfs /vmtest')
    sh(['mkfs.ext4', '-q', '-b', '4096', hdd], check=True, label='mkfs /usbtest')
    sh(['mount', '/dev/mapper/vmtest-crypt', '/vmtest'], check=True, label='mount /vmtest')
    sh(['mount', hdd, '/usbtest'], check=True, label='mount /usbtest')
    falloc('/vmtest/vmtest2.img', 24 << 20)                       # a SECOND non-rotational ext4 (other-filesystem case)
    l2 = attach('/vmtest/vmtest2.img', 'loop for /vmtest2')
    sh(['mkfs.ext4', '-q', '-b', '4096', l2], check=True, label='mkfs /vmtest2 (on OWN test loop)')
    os.makedirs('/vmtest2', exist_ok=True)
    sh(['mount', l2, '/vmtest2'], check=True, label='mount /vmtest2')
    rec('vmtest2', loop=l2, rota=sh(['lsblk', '-nso', 'ROTA', l2], label='id').stdout.split())
    for d in ('/usbtest/enclave-base-holder', '/usbtest/enclave-l1-pair', '/usbtest/probe', '/vmtest/enclave-base-holder-cache',
              '/vmtest/enclave-l1-pair-cache', '/vmtest/probe-cache', '/vmtest2/probe-meta', '/vmtest/foreign', '/mnt-raw'):
        os.makedirs(d, exist_ok=True)
    Path(LEDGER).write_text((R / 'ledger.json').read_text()); os.chmod(LEDGER, 0o644)
    return l2


def pair_reset():
    k = PC['storage']['cache']
    for f in (PC['storage']['origin']['imagePath'], k['dataImagePath'], k['metadataImagePath']):
        for l in loops_of(f):
            own_detach(l, f)
        for x in (f, f + MK):
            if os.path.lexists(x):
                os.remove(x)


def main():
    l2 = setup()
    identity('after-setup')
    O = HC['storage']['origin']['imagePath']; HK = HC['storage']['cache']
    for n in ('holder', 'pair', 'probe'):
        result(f'{n}.create', short(run(S[n], 'create')))

    # A. real lsblk/losetup facts under a live mapping
    result('holder.assemble', short(run(S['holder'], 'assemble')))
    result('A.loopsUnderMapping', {Path(f).name: [loop_facts(l) for l in loops_of(f)] for f in (O, HK['dataImagePath'], HK['metadataImagePath'])})
    man = {}
    d = '/srv/enclave-base-holder/data/t'; os.makedirs(d, exist_ok=True)
    for i in range(4):
        p = f'{d}/f{i}.bin'; data = gen(f'f{i}', 4 << 20)
        with open(p, 'wb') as h:
            h.write(data); h.flush(); os.fsync(h.fileno())
        man[p] = hashlib.sha256(data).hexdigest()
    result('holder.disassemble', short(run(S['holder'], 'disassemble')))
    result('A.afterDisassemble', identity('after-disassemble'))

    # B. disassemble must never detach an ACTIVE loop (and must not set autoclear)
    for case in ('held-by-foreign-mapping', 'mounted-elsewhere'):
        for variant in ('composed', 'old-control'):
            l = attach(O, f'{case}: test attaches origin (foreign user)')
            if case == 'held-by-foreign-mapping':
                sz = sh(['blockdev', '--getsz', l], label='id').stdout.strip()
                sh(['dmsetup', 'create', 'foreign-hold', '--table', f'0 {sz} linear {l} 0'], check=True, label='foreign mapping holds origin loop')
            else:
                sh(['mount', '-o', 'ro', l, '/mnt-raw'], check=True, label='mount origin loop elsewhere (ro)')
            before = loop_facts(l)
            p = run(S['holder'] if variant == 'composed' else S['old-holder'], 'disassemble')
            after = loop_facts(l)
            if case == 'held-by-foreign-mapping':
                sh('dmsetup remove foreign-hold', check=True, label='remove OWN foreign-hold fixture')
            else:
                sh(['umount', '/mnt-raw'], check=True, label='umount OWN /mnt-raw fixture')
            time.sleep(0.5)
            still = l in loops_of(O)
            result(f'B.{case}.{variant}', {'rc': p.returncode, 'err': p.stderr.strip()[-200:], 'before': before, 'afterDisassemble': after,
                                           'loopStillBoundAfterUserGone': still})
            if still:
                own_detach(l, O)

    # C. cache-loss detaches only the loop it attached (origin was accessed uncached in B -> cache-loss is required anyway)
    for variant in ('composed', 'old-control'):
        p = run(S['holder'] if variant == 'composed' else S['old-holder'], 'cache-loss')
        left = loops_of(O)
        result(f'C.noPriorLoop.{variant}', {'rc': p.returncode, 'originLoopsLeft': left})
        for l in left:
            own_detach(l, O)
    l = attach(O, 'pre-existing origin loop (before cache-loss)')
    ino = os.stat(O).st_ino
    p = run(S['holder'], 'cache-loss')
    f = loop_facts(l)
    result('C.preExistingLoop.composed', {'rc': p.returncode, 'kept': l in loops_of(O), 'backing': f['backing'], 'inodeSame': os.stat(O).st_ino == ino})
    own_detach(l, O)

    # D. free-space credit
    pk = PC['storage']['cache']; po = PC['storage']['origin']['imagePath']
    os.remove(po)                                                     # D1: owned complete cache files remain, origin gone
    m = avail('/vmtest') - (8 << 20)                                  # full re-allocation (16 MiB) would NOT fit; adoption does
    result('D1.ownedAdoption', short(run(with_margin(S['pair'], m, 'd1'), 'create')))
    pair_reset()
    falloc(pk['metadataImagePath'], 8 << 20); fs = sha(pk['metadataImagePath'])   # D2: unmarked foreign file
    m = avail('/vmtest') - (4 << 20)
    p1 = run(with_margin(S['pair'], m, 'd2'), 'create'); p2 = run(S['pair'], 'create')
    result('D2.unmarkedForeign', {'tightMargin': short(p1), 'zeroMargin': short(p2), 'foreignUnchanged': sha(pk['metadataImagePath']) == fs,
                                  'originCreated': os.path.exists(po), 'loops': loops_of(po)})
    pair_reset()
    # D3: symlinked cache path with a forged "own" marker; short (fast) and long (slow) symlinks; composed vs mutant
    target_short = '/vmtest/foreign/t.img'
    target_long = '/vmtest/foreign/' + 'x' * 80 + '/real-meta.img'
    sym = {}
    for kind, tgt in (('short', target_short), ('long', target_long)):
        pair_reset()
        falloc(tgt, 8 << 20); ts = sha(tgt)
        os.symlink(tgt, pk['metadataImagePath'])
        Path(pk['metadataImagePath'] + MK).write_text(json.dumps({'reservation': 'l1-pair-dm-cache', 'path': pk['metadataImagePath'], 'bytes': 8 << 20}) + '\n')
        link_alloc = os.lstat(pk['metadataImagePath']).st_blocks * 512
        a = avail('/vmtest'); need_composed = (16 << 20)              # (cache bytes) + margin - credit(0)
        knife = a - need_composed + 2048                              # composed need = avail + 2 KiB; mutant need = that - link_alloc
        out = {'linkLength': len(tgt), 'linkAllocatedBytes': link_alloc}
        for v, script in (('composed', S['pair']), ('mutant', MUT)):
            k1 = run(with_margin(script, knife, f'd3{kind}{v}'), 'create')
            k0 = run(script, 'create')
            out[v] = {'knifeEdgeMargin': short(k1), 'zeroMargin': short(k0)}
        out['stateAfter'] = {'targetUnchanged': sha(tgt) == ts, 'symlinkIntact': os.path.islink(pk['metadataImagePath']) and os.readlink(pk['metadataImagePath']) == tgt,
                             'originCreated': os.path.exists(po), 'loops': loops_of(po), 'dataFileCreated': os.path.exists(pk['dataImagePath'])}
        sym[kind] = out
        os.remove(pk['metadataImagePath']); os.remove(pk['metadataImagePath'] + MK)
    result('D3.symlink', sym)
    pair_reset()
    result('pair.recreate', short(run(S['pair'], 'create')))
    # D4: probe's metadata lives on /vmtest2: only its CDATA (same fs as the measured directory) may be credited
    qk = QC['storage']['cache']; qo = QC['storage']['origin']['imagePath']
    os.remove(qo)
    m = avail('/vmtest') - (4 << 20)          # crediting BOTH (12 MiB) passes; crediting only CDATA (4 MiB) needs avail + 4 MiB
    shas = {f: sha(f) for f in (qk['dataImagePath'], qk['metadataImagePath'])}
    p1 = run(with_margin(S['probe'], m, 'd4'), 'create')
    st = {'filesUnchanged': all(sha(f) == h for f, h in shas.items()), 'originCreated': os.path.exists(qo), 'loops': loops_of(qo)}
    p2 = run(S['probe'], 'create')
    result('D4.otherFilesystem', {'tightMargin': short(p1), 'stateAfterRefusal': st, 'zeroMarginAdopts': short(p2),
                                  'devices': {f: os.stat(os.path.dirname(f)).st_dev for f in (qk['dataImagePath'], qk['metadataImagePath'])}})

    # E1. retained: SIGTERM unwind sweep on the composed pair create
    pair_reset()
    t0 = time.monotonic(); run(S['pair'], 'create'); full = time.monotonic() - t0
    sweep = []
    for frac in (0.15, 0.3, 0.45, 0.6, 0.75, 0.9):
        pair_reset()
        q = subprocess.Popen([S['pair'], 'create'], env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        time.sleep(full * frac)
        try:
            os.killpg(q.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        o, e = q.communicate(timeout=120)
        sweep.append({'delay': round(full * frac, 3), 'rc': q.returncode, 'originLeft': os.path.exists(po), 'loopsLeft': loops_of(po),
                      'err': e.strip()[-120:]})
    result('E1.sigtermSweep', {'uninterruptedSec': round(full, 3), 'attempts': sweep})
    pair_reset(); result('pair.final', short(run(S['pair'], 'create')))

    # E2. retained: fsync'd data survives disassemble + cache-loss + assemble (origin was accessed uncached in B/C)
    result('E2.assemble', short(run(S['holder'], 'assemble')))
    bad = [p for p, h in man.items() if sha(p) != h]
    result('E2.dataAfterCacheLoss', {'files': len(man), 'mismatches': bad})
    result('E2.status', sh('dmsetup status enclave-base-holder', label='status').stdout.strip())
    result('E2.verifyCap', short(run(S['holder'], 'verify-cap')))

    # F. teardown of everything this test made, then the final identity
    for n in ('holder', 'pair', 'probe'):
        result(f'F.{n}.disassemble', short(run(S[n], 'disassemble')))
    sh(['umount', '/vmtest2'], check=True, label='umount /vmtest2')
    own_detach(l2, '/vmtest/vmtest2.img')
    sh(['umount', '/vmtest'], check=True, label='umount /vmtest'); sh(['umount', '/usbtest'], check=True, label='umount /usbtest')
    sh(['cryptsetup', 'close', 'vmtest-crypt'], check=True, label='close dm-crypt')
    fin = identity('final')
    result('F.final', {'clean': not fin['loops'] and fin['dm'] in ([], ['No', 'devices', 'found']) and not fin['mounts'], **fin})


if __name__ == '__main__':
    try:
        main()
    except BaseException as e:
        rec('exception', error=repr(e)[:2000]); RESULTS['exception'] = repr(e)[:2000]
        raise
    finally:
        (OUT / 'results.json').write_text(json.dumps(RESULTS, indent=1, default=str))
