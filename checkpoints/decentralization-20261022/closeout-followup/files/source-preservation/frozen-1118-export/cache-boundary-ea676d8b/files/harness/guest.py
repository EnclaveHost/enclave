#!/usr/bin/env python3
"""Runs INSIDE the throwaway guest as root. Exercises the EXACT rendered storage scripts (/out/render/*.sh, S template
eb6a209d via S's and P's own renderers) and S's budget.py against REAL guest-kernel loop, dm-crypt, ext4 and dm-cache
devices on two virtual test disks backed by owned files. Every command, its exit code and identity receipts go to
/out/receipts-<phase>.jsonl. Nothing here touches the host kernel or any host device."""
import hashlib, json, os, re, signal, subprocess, sys, time
from pathlib import Path

PHASE = sys.argv[1]
OUT = Path('/out'); R = OUT / 'render'
REC = open(OUT / f'receipts-{PHASE}.jsonl', 'a', buffering=1)
ENV = {'PATH': '/usr/bin', 'LANG': 'C.UTF-8', 'DM_DISABLE_UDEV': '1', 'HOME': '/root'}   # no udev in the guest
HOLDER, PAIR = str(R / 'holder-storage.sh'), str(R / 'pair-storage.sh')
HC, PC = json.loads((R / 'holder.json').read_text()), json.loads((R / 'pair.json').read_text())
BUDGET = '/src/vendor/holder/budget.py'
LEDGER = '/etc/enclave-rpc-cache/nvme-cache-budget.json'
KEY = OUT / 'fixture.key'          # test-only dm-crypt fixture key; deleted by the host driver after the run


def rec(kind, **kw):
    REC.write(json.dumps(dict(kind=kind, t=round(time.time(), 3), **kw), default=str) + '\n')


def sh(cmd, check=False, timeout=300, label=None, **kw):
    p = subprocess.run(cmd, shell=isinstance(cmd, str), env=ENV, capture_output=True, text=True, timeout=timeout, **kw)
    rec('cmd', label=label, cmd=cmd if isinstance(cmd, str) else ' '.join(cmd), rc=p.returncode, out=p.stdout[-3000:], err=p.stderr[-3000:])
    if check and p.returncode:
        raise SystemExit(f'FAILED {label or cmd}: rc={p.returncode} {p.stderr[-500:]}')
    return p


def identity(tag):
    loops = []
    for l in (json.loads(sh('losetup -J -l -O NAME,BACK-FILE,BACK-INO,MAJ:MIN', label='id').stdout or '{}').get('loopdevices') or []):
        loops.append(l)
    dm = sh('dmsetup info -c --noheadings -o name,major,minor,open', label='id').stdout.split()
    tables = sh('dmsetup table', label='id').stdout.strip().splitlines()
    mnts = [l.split()[4] + ' ' + l.split(' - ')[1].split()[1] for l in open('/proc/self/mountinfo') if re.search(r' /(srv|usbtest|vmtest|mnt-raw)', l)]
    ident = {'loops': loops, 'dm': dm, 'tables': tables, 'mounts': mnts}
    rec('identity', tag=tag, **ident)
    return ident


def fstat(path):
    st = os.statvfs(path)
    return {'freeBytes': st.f_bfree * st.f_frsize, 'blockSize': st.f_frsize}


def gen(seed, n):
    """Deterministic content: SHA-256 counter stream."""
    out, i = bytearray(), 0
    while len(out) < n:
        out += hashlib.sha256(f'{seed}:{i}'.encode()).digest(); i += 1
    return bytes(out[:n])


def write_set(d, prefix, count, size):
    os.makedirs(d, exist_ok=True)
    man = {}
    for i in range(count):
        p = f'{d}/{prefix}-{i}.bin'; data = gen(f'{prefix}{i}', size)
        with open(p, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        man[p] = hashlib.sha256(data).hexdigest()
    fd = os.open(d, os.O_RDONLY); os.fsync(fd); os.close(fd)
    return man


def check_set(man, tag):
    sh('sync; echo 3 > /proc/sys/vm/drop_caches', label='drop-caches')
    bad = {p: 'missing' for p in man if not os.path.exists(p)}
    for p, h in man.items():
        if p not in bad:
            got = hashlib.sha256(open(p, 'rb').read()).hexdigest()
            if got != h:
                bad[p] = got
    rec('verify', tag=tag, files=len(man), mismatches=bad)
    return not bad


def status(name, tag):
    s = sh(f'dmsetup status {name}', label='status').stdout.strip()
    rec('dmstatus', tag=tag, status=s)
    return s


def disk(serial):
    for b in sorted(os.listdir('/sys/block')):
        v = Path(f'/sys/block/{b}/device/vpd_pg80')
        if v.exists() and serial.encode() in v.read_bytes():
            return f'/dev/{b}', Path(f'/sys/block/{b}/queue/rotational').read_text().strip()
    raise SystemExit(f'no disk with serial {serial}')


def actual(cfgd):
    k = cfgd['storage']['cache']
    return sum(os.lstat(p).st_blocks * 512 for p in (k['dataImagePath'], k['metadataImagePath'],
                                                     k['dataImagePath'] + '.enclave-budget-owner', k['metadataImagePath'] + '.enclave-budget-owner') if os.path.exists(p))


def setup(fresh):
    hdd, hrot = disk('enc-hdd'); nv, nrot = disk('enc-nvme')
    rec('disks', hdd=hdd, hddRotational=hrot, nvme=nv, nvmeRotational=nrot, kernel=os.uname().release)
    assert (hrot, nrot) == ('1', '0'), 'test disks must present rotational HDD + non-rotational NVMe'
    for m in ('loop', 'dm-crypt'):                      # production: loop autoloads via kmod static nodes (no udev here)
        sh(['modprobe', m], check=True, label=f'modprobe {m}')
    if fresh:
        KEY.write_bytes(os.urandom(64)); KEY.chmod(0o600)
        sh(['cryptsetup', 'luksFormat', '--batch-mode', '--type', 'luks2', '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '1000',
            '--key-file', str(KEY), nv], check=True, label='luksFormat test nvme disk')
    sh(['cryptsetup', 'open', '--key-file', str(KEY), nv, 'vmtest-crypt'], check=True, label='open dm-crypt')
    if fresh:
        sh(['mkfs.ext4', '-q', '-b', '4096', '/dev/mapper/vmtest-crypt'], check=True, label='mkfs /vmtest (ext4 on dm-crypt)')
        sh(['mkfs.ext4', '-q', '-b', '4096', hdd], check=True, label='mkfs /usbtest (ext4 on rotational disk)')
    sh(['mount', '/dev/mapper/vmtest-crypt', '/vmtest'], check=True, label='mount /vmtest')
    sh(['mount', hdd, '/usbtest'], check=True, label='mount /usbtest')
    for d in ('/usbtest/enclave-base-holder', '/usbtest/enclave-l1-pair', '/vmtest/enclave-base-holder-cache', '/vmtest/enclave-l1-pair-cache', '/vmtest/foreign'):
        os.makedirs(d, exist_ok=True)
    Path(LEDGER).write_text((R / 'ledger.json').read_text()); os.chmod(LEDGER, 0o644)
    rec('ledger', path=LEDGER, sha256=hashlib.sha256(Path(LEDGER).read_bytes()).hexdigest(), uid=os.lstat(LEDGER).st_uid)


def foreign():
    f = '/vmtest/foreign/foreign.img'
    if not os.path.exists(f):
        with open(f, 'wb') as h:
            h.write(gen('foreign', 4 << 20)); h.flush(); os.fsync(h.fileno())
    lo = sh(['losetup', '--find', '--show', f], check=True, label='foreign loop').stdout.strip()
    sz = sh(['blockdev', '--getsz', lo], check=True, label='foreign size').stdout.strip()
    sh(['dmsetup', 'create', 'foreign-linear', '--table', f'0 {sz} linear {lo} 0'], check=True, label='foreign mapping')
    st = os.lstat(f)
    fid = {'file': f, 'inode': st.st_ino, 'sha256': hashlib.sha256(open(f, 'rb').read()).hexdigest(), 'loop': lo,
           'loopMajMin': sh(['lsblk', '-dno', 'MAJ:MIN', lo], label='id').stdout.strip()}
    rec('foreign', **fid)
    return fid


def foreign_intact(fid, tag):
    st = os.lstat(fid['file'])
    lo = sh(['losetup', '-j', fid['file'], '-O', 'NAME', '-n'], label='id').stdout.strip()
    ok = (st.st_ino == fid['inode'] and hashlib.sha256(open(fid['file'], 'rb').read()).hexdigest() == fid['sha256']
          and lo == fid['loop'] and sh('dmsetup info foreign-linear', label='id').returncode == 0)
    rec('foreignIntact', tag=tag, ok=ok)
    return ok


def foreign_remove(fid):
    sh('dmsetup remove foreign-linear', check=True, label='remove OWN foreign-linear (test fixture)')
    sh(['losetup', '-d', fid['loop']], check=True, label='detach OWN foreign loop (test fixture)')


RESULTS = {}


def result(k, v):
    RESULTS[k] = v
    rec('result', key=k, value=v)


def run(script, verb, **kw):
    return sh([script, verb], label=f'{Path(script).name} {verb}', **kw)


def phase_one():
    setup(fresh=True)
    identity('after-setup')
    free0 = fstat('/vmtest')
    fid = foreign()
    # ledger: next reservation at a full share is refused; the real ledger validates
    p = sh([sys.executable, '-I', BUDGET, 'validate', str(R / 'ledger-over.json')], label='budget validate over-share ledger')
    result('nextReservationRefused', {'rc': p.returncode, 'err': p.stderr.strip()[-300:]})
    p = sh([sys.executable, '-I', BUDGET, 'validate', LEDGER], label='budget validate ledger')
    result('ledgerValid', p.returncode == 0)
    # create (exact rendered scripts)
    for name, script, c in (('holder', HOLDER, HC), ('pair', PAIR, PC)):
        p = run(script, 'create')
        result(f'{name}.create.rc', p.returncode)
        v = run(script, 'verify-cap')
        result(f'{name}.verifyCap', {'rc': v.returncode, 'json': v.stdout.strip()[-600:]})
        k = c['storage']['cache']
        result(f'{name}.accounting', {'actualFilesMarkers': actual(c), 'maxBytes': k['dataBytes'] + k['metadataBytes'] + k['slackBytes'],
                                       'declared': k['dataBytes'] + k['metadataBytes'], 'slack': k['slackBytes']})
    free1 = fstat('/vmtest')
    result('ext4.vmtest.freeDelta', {'usedByCreates': free0['freeBytes'] - free1['freeBytes'], 'foreignFixture': 4 << 20,
                                      'sumMaxBytes': sum(r['maxBytes'] for r in json.loads(Path(LEDGER).read_text())['reservations'])})
    identity('after-create')
    result('foreign.afterCreate', foreign_intact(fid, 'after-create'))
    # a foreign mapping with OUR name must be refused and left untouched
    lo = fid['loop']; sz = sh(['blockdev', '--getsz', lo], label='id').stdout.strip()
    sh(['dmsetup', 'create', 'enclave-base-holder', '--table', f'0 {sz} linear {lo} 0'], check=True, label='foreign SAME-NAME mapping')
    p = run(HOLDER, 'assemble')
    t = sh('dmsetup table enclave-base-holder', label='id').stdout.strip()
    result('sameNameForeignMapping', {'assembleRc': p.returncode, 'refusal': p.stderr.strip()[-300:], 'foreignTableAfter': t,
                                      'holderLoopsLeft': sh(['losetup', '-j', HC['storage']['origin']['imagePath']], label='id').stdout.strip()})
    sh('dmsetup remove enclave-base-holder', check=True, label='remove OWN same-name foreign fixture')
    # assemble + deterministic IO
    p = run(HOLDER, 'assemble'); result('holder.assemble.rc', p.returncode)
    ident = identity('assembled')
    st = status('enclave-base-holder', 'assembled'); result('writethrough', ' writethrough ' in f' {st} ')
    data = '/srv/enclave-base-holder/data/t'
    man = write_set(data, 'a', 6, 4 << 20)
    result('io.firstRead', check_set(man, 'first-read'))
    result('io.secondRead', check_set(man, 'second-read'))
    status('enclave-base-holder', 'after-io')
    # orderly removal + reassembly
    p = run(HOLDER, 'disassemble'); result('holder.disassemble.rc', p.returncode)
    after = identity('after-disassemble')
    result('disassemble.clean', not any('enclave-base-holder' in x for x in after['dm']) and
           not any(HC['storage']['origin']['imagePath'] in json.dumps(l) or 'cache-' in json.dumps(l) for l in after['loops']))
    result('foreign.afterDisassemble', foreign_intact(fid, 'after-disassemble'))
    p = run(HOLDER, 'assemble'); result('holder.reassemble.rc', p.returncode)
    result('io.afterReassemble', check_set(man, 'after-reassemble'))
    st = status('enclave-base-holder', 'after-reassemble')
    # stale-cache hazard: uncached origin access must block assemble until cache-loss
    run(HOLDER, 'disassemble')
    raw = sh(['losetup', '--find', '--show', HC['storage']['origin']['imagePath']], check=True, label='uncached origin loop (hazard)').stdout.strip()
    os.makedirs('/mnt-raw', exist_ok=True)
    sh(['mount', '-o', 'ro', raw, '/mnt-raw'], check=True, label='mount origin WITHOUT cache (hazard)')
    p = run(HOLDER, 'assemble')
    result('staleCacheHazard', {'assembleRc': p.returncode, 'refusal': p.stderr.strip()[-300:]})
    sh(['umount', '/mnt-raw'], check=True, label='umount hazard'); sh(['losetup', '-d', raw], check=True, label='detach hazard loop')
    p = run(HOLDER, 'cache-loss'); result('cacheLoss.afterHazard.rc', p.returncode)
    p = run(HOLDER, 'assemble'); result('holder.assembleAfterCacheLoss.rc', p.returncode)
    result('io.afterCacheLoss', check_set(man, 'after-cache-loss'))
    status('enclave-base-holder', 'after-cache-loss')
    # budget verify catches a grown cache file (exact size), then passes once restored
    run(HOLDER, 'disassemble')
    meta = HC['storage']['cache']['metadataImagePath']; n = HC['storage']['cache']['metadataBytes']
    os.truncate(meta, n + 4096)
    v1 = run(HOLDER, 'verify-cap'); os.truncate(meta, n); v2 = run(HOLDER, 'verify-cap')
    result('budget.grownFile', {'rcGrown': v1.returncode, 'refusal': v1.stderr.strip()[-200:], 'rcRestored': v2.returncode})
    # interruption: SIGTERM to the whole control group of a FRESH real pair create (production script) at delays across its
    # measured duration; then recovery with the production script, and (if it refuses on free space) the FIXED template
    k = PC['storage']['cache']; origin = PC['storage']['origin']['imagePath']; cd, cm = k['dataImagePath'], k['metadataImagePath']
    MK = '.enclave-budget-owner'
    def loops_of(f):
        return re.findall(r'^(/dev/loop\d+):', sh(['losetup', '-j', f], label='id').stdout, re.M)
    def pair_reset():                                   # operator rollback of the pair to "never created" (its files only)
        for f in (origin, cd, cm):
            for l in loops_of(f):
                sh(['losetup', '-d', l], label=f'reset: detach loop of {Path(f).name}')
        for f in (origin, cd, cd + MK, cm, cm + MK):
            if os.path.exists(f):
                os.remove(f)
    def state():
        return {'origin': os.path.exists(origin), 'loops': {Path(f).name: loops_of(f) for f in (origin, cd, cm)},
                'cache': {Path(f).name: [os.lstat(f).st_size, os.lstat(f).st_blocks * 512] if os.path.exists(f) else None for f in (cd, cm)},
                'markers': [os.path.exists(cd + MK), os.path.exists(cm + MK)]}
    pair_reset()
    t0 = time.monotonic(); p = run(PAIR, 'create'); full = round(time.monotonic() - t0, 3)
    result('pair.createUninterrupted', {'rc': p.returncode, 'sec': full})
    attempts = []
    for frac in (0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95):
        pair_reset()
        delay = round(full * frac, 3)
        q = subprocess.Popen([PAIR, 'create'], env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        time.sleep(delay)
        try:
            os.killpg(q.pid, signal.SIGTERM)            # like systemd stopping the unit: TERM to the whole control group
        except ProcessLookupError:
            pass
        o, e = q.communicate(timeout=120)
        a = {'delay': delay, 'rc': q.returncode, 'stderr': e.strip()[-240:], 'left': state()}
        v = run(PAIR, 'verify-cap'); a['verifyCapRc'] = v.returncode
        r1 = run(PAIR, 'create'); a['recoverProduction'] = {'rc': r1.returncode, 'err': r1.stderr.strip()[-200:]}
        if r1.returncode and 'origin' in r1.stderr and 'exists' in r1.stderr and os.path.exists(origin) and not loops_of(origin):
            os.remove(origin)                           # documented manual step: the interrupted run's UNMARKED origin
            a['manualOriginRemoved'] = True
            r1 = run(PAIR, 'create'); a['recoverProductionAfterOriginRemoval'] = {'rc': r1.returncode, 'err': r1.stderr.strip()[-200:]}
        if r1.returncode:
            r2 = run(str(R / 'pair-storage.fixed.sh'), 'create'); a['recoverFixed'] = {'rc': r2.returncode, 'err': r2.stderr.strip()[-200:]}
        a['after'] = state()
        a['verifyAfterRecoveryRc'] = run(PAIR, 'verify-cap').returncode
        attempts.append(a)
        rec('interruption', **a)
    result('interruptions', attempts)
    # the same interruption against the FIXED template (fixes/0001 + 0002): finer delays across the origin/loop window
    fixed = str(R / 'pair-storage.fixed.sh'); fx = []
    for i in range(12):
        pair_reset()
        delay = round(0.12 + 0.025 * i, 3)
        q = subprocess.Popen([fixed, 'create'], env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        time.sleep(delay)
        try:
            os.killpg(q.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        o, e = q.communicate(timeout=120)
        a = {'delay': delay, 'rc': q.returncode, 'completedBeforeSignal': q.returncode == 0, 'stderr': e.strip()[-240:], 'left': state()}
        if q.returncode:
            r2 = run(fixed, 'create'); a['recoverFixed'] = {'rc': r2.returncode, 'err': r2.stderr.strip()[-200:]}
            a['verifyAfterRecoveryRc'] = run(PAIR, 'verify-cap').returncode
        fx.append(a); rec('interruptionFixed', **a)
    result('interruptionsFixed', fx)
    pair_reset()
    p = run(PAIR, 'create'); result('pair.recreateAfterInterrupts.rc', p.returncode)
    v = run(PAIR, 'verify-cap'); result('pair.verifyAfterInterrupts.rc', v.returncode)
    result('foreign.afterInterrupts', foreign_intact(fid, 'after-interrupts'))
    # abrupt power loss with the cache attached: fsynced data must survive on the durable origin
    p = run(HOLDER, 'assemble'); result('holder.assembleBeforeCrash.rc', p.returncode)
    man2 = write_set(data, 'crash', 4, 4 << 20)
    full = dict(man, **man2)
    (OUT / 'manifest.json').write_text(json.dumps(full)); fd = os.open(str(OUT / 'manifest.json'), os.O_RDONLY); os.fsync(fd); os.close(fd)
    with open(f'{data}/unsynced.bin', 'wb') as f:
        f.write(gen('unsynced', 1 << 20))                 # NOT fsynced: may be lost; recorded, not asserted
    status('enclave-base-holder', 'before-crash')
    rec('crash', how='sysrq b: immediate reboot, no sync, no unmount, cache mapped and mounted')
    (OUT / 'results-one.json').write_text(json.dumps(RESULTS, indent=1, default=str))
    fd = os.open(str(OUT / 'results-one.json'), os.O_RDONLY); os.fsync(fd); os.close(fd)
    REC.flush(); os.fsync(REC.fileno())
    Path('/proc/sysrq-trigger').write_text('b')


def phase_two():
    setup(fresh=False)                                    # same disks; ext4 journals replay after the crash
    identity('boot-after-crash')
    man = json.loads((OUT / 'manifest.json').read_text())
    # 1. what the boot-time storage unit does: assemble directly (no cache-loss first)
    p = run(HOLDER, 'assemble'); result('afterCrash.directAssemble.rc', p.returncode)
    result('afterCrash.directAssemble.status', status('enclave-base-holder', 'after-crash-direct-assemble'))
    result('afterCrash.directAssemble.data', check_set(man, 'after-crash-direct'))
    result('afterCrash.unsyncedPresent', os.path.exists('/srv/enclave-base-holder/data/t/unsynced.bin'))
    # 2. the reviewed loss procedure: disassemble, cache-loss (invalidate metadata first, read-only fsck), assemble
    run(HOLDER, 'disassemble')
    p = run(HOLDER, 'cache-loss'); result('afterCrash.cacheLoss.rc', p.returncode)
    p = run(HOLDER, 'assemble'); result('afterCrash.reviewedAssemble.rc', p.returncode)
    result('afterCrash.reviewedProcedure.data', check_set(man, 'after-crash-reviewed'))
    status('enclave-base-holder', 'after-crash-reviewed')
    for i in range(4):                                     # repeated reads so smq promotes origin blocks into the cache
        check_set(man, f'promote-pass-{i}')
    result('beforeCorruption.status', status('enclave-base-holder', 'before-corruption'))
    fid = foreign()
    # 3. cache DEVICE CONTENT lost/corrupted while its metadata still says "cached": probe read-only, then recover
    run(HOLDER, 'disassemble')
    k = HC['storage']['cache']
    with open(k['dataImagePath'], 'r+b') as f:               # garbage over the whole cache data device (allocation kept)
        f.write(os.urandom(k['dataBytes'])); f.flush(); os.fsync(f.fileno())
    o = sh(['losetup', '--find', '--show', HC['storage']['origin']['imagePath']], check=True, label='probe origin loop').stdout.strip()
    d = sh(['losetup', '--find', '--show', k['dataImagePath']], check=True, label='probe data loop').stdout.strip()
    m = sh(['losetup', '--find', '--show', k['metadataImagePath']], check=True, label='probe meta loop').stdout.strip()
    mm = lambda x: sh(['lsblk', '-dno', 'MAJ:MIN', x], label='id').stdout.strip()
    tbl = f"0 {sh(['blockdev', '--getsz', o], label='id').stdout.strip()} cache {mm(m)} {mm(d)} {mm(o)} 512 1 writethrough smq 0"
    pr = sh(['dmsetup', 'create', 'cachetest-probe', '--readonly', '--table', tbl], label='READ-ONLY probe mapping over the corrupted cache')
    if pr.returncode:                                       # dm-cache may need a writable table; the MOUNT stays read-only
        sh(['dmsetup', 'create', 'cachetest-probe', '--table', tbl], label='probe mapping (rw table, ro mount)')
    probe = {'probeStatus': status('cachetest-probe', 'probe')}
    diff, total, CH = 0, 0, 4096                           # raw comparison: bytes served THROUGH the cache vs the origin
    with open('/dev/mapper/cachetest-probe', 'rb') as a, open(o, 'rb') as b:
        while True:
            x, y = a.read(CH), b.read(CH)
            if not y:
                break
            total += 1; diff += x != y
    probe.update(blocksCompared4k=total, blocksDifferent4k=diff)
    os.makedirs('/mnt-raw', exist_ok=True)
    mp = sh(['mount', '-o', 'ro,noload', '/dev/mapper/cachetest-probe', '/mnt-raw'], label='probe mount ro,noload')
    probe['mountRc'] = mp.returncode
    if mp.returncode == 0:
        bad = 0
        for pth, h in man.items():
            q = pth.replace('/srv/enclave-base-holder', '/mnt-raw')
            try:
                bad += hashlib.sha256(open(q, 'rb').read()).hexdigest() != h
            except OSError:
                bad += 1
        probe['filesWrongOrUnreadable'] = bad
        sh(['umount', '/mnt-raw'], label='probe umount')
    sh('dmsetup remove cachetest-probe', label='remove probe mapping')
    for x in (o, d, m):
        sh(['losetup', '-d', x], label='detach probe loop')
    result('corruptCacheWithoutCacheLoss.readOnlyProbe', probe)
    p = run(HOLDER, 'cache-loss'); result('corruptCache.cacheLoss.rc', p.returncode)
    p = run(HOLDER, 'assemble'); result('corruptCache.assemble.rc', p.returncode)
    result('corruptCache.reviewedProcedure.data', check_set(man, 'after-corrupt-cache-reviewed'))
    result('foreign.phaseTwo', foreign_intact(fid, 'phase-two'))
    v = run(HOLDER, 'verify-cap'); result('final.verifyCap', {'rc': v.returncode, 'json': v.stdout.strip()[-600:]})
    # 4. orderly teardown of everything this test made
    p = run(HOLDER, 'disassemble'); result('final.disassemble.rc', p.returncode)
    p = run(PAIR, 'disassemble'); result('final.pairDisassemble.rc', p.returncode)
    foreign_remove(fid)
    sh(['umount', '/vmtest'], check=True, label='umount /vmtest'); sh(['umount', '/usbtest'], check=True, label='umount /usbtest')
    sh(['cryptsetup', 'close', 'vmtest-crypt'], check=True, label='close dm-crypt')
    fin = identity('final')
    result('final.noLeftovers', {'loops': fin['loops'], 'dm': fin['dm'], 'mounts': fin['mounts'],
                                 'clean': not fin['loops'] and fin['dm'] in ([], ['No', 'devices', 'found']) and not fin['mounts']})
    (OUT / 'results-two.json').write_text(json.dumps(RESULTS, indent=1, default=str))


if __name__ == '__main__':
    try:
        {'one': phase_one, 'two': phase_two}[PHASE]()
    except BaseException as e:
        rec('exception', error=repr(e)[:2000])
        (OUT / f'results-{PHASE}.json').write_text(json.dumps(dict(RESULTS, exception=repr(e)[:2000]), indent=1, default=str))
        raise
