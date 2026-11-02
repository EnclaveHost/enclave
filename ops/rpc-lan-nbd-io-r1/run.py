"""Read-only NBD-over-TLS I/O measurement: Warden originals -> NucBox Control guest.

python3 -B run.py --selftest   synthetic 64 MiB file on loopback only
python3 -B run.py              L1 (NVMe) then Base (USB RAID), each Warden-local
                               then from the Control guest over the LAN

Originals are opened only by qemu-nbd --read-only (shared read lock; a writer
would make it fail closed). The client issues only NBD_CMD_READ. Credentials
are throwaway, generated here, and the private keys are deleted at the end.
Each phase runs once; there is no retry.
"""
from array import array
import bisect
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time

R = Path(__file__).resolve().parent
SELFTEST = sys.argv[1:] == ['--selftest']
assert sys.argv[1:] in ([], ['--selftest'])
OUT = R / ('selftest' if SELFTEST else 'result')
PKI = OUT / 'pki'
TOOL = R / 'nbdbench'
WARDEN_LAN = '192.168.8.249'
IMAGES = [('l1', '/vm/enclave-volumes/rpc-production/l1-origin.qcow2', 10811),
          ('base', '/mnt/usb/enclave-rpc-production/base-origin.qcow2', 10812)]
ADMISSION = R.parent / 'rpc-export-current-admission-read-r2/CONFIG.json'
SOURCE = R.parents[1] / 'source'
GUEST = 'controladmin@172.17.28.159'
GUEST_DIR = '/tmp/rpc-lan-io-r1'
SSH = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=5',
       '-oControlMaster=no', '-oControlPath=none', '-oServerAliveInterval=5', '-oServerAliveCountMax=2',
       '-oIdentitiesOnly=yes', '-i', '/home/steven/.ssh/minipc', '-oProxyJump=minipc',
       '-oHostKeyAlias=[127.0.0.1]:32423',
       '-oUserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts']
SAMPLES = 100_000


def log(**row):
    row['at'] = time.time()
    with (OUT / 'log.jsonl').open('a') as f:
        f.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)


def sh(args, timeout, **kw):
    return subprocess.run(args, capture_output=True, timeout=timeout, check=True, **kw)


def admission():
    r = sh(['/usr/bin/node', str(SOURCE / 'rpc/server/observe_resources.mjs'), str(ADMISSION)], 5, text=True)
    a = json.loads(r.stdout)
    ok = a['authenticated'] and a['unreadUnits'] == 0 and a['availableMiB'] - a['pendingMiB'] - 640 >= max(27648, a['floorMiB'])
    log(event='admission', ok=ok, **a)
    assert ok, 'host admission refused'


def pki():
    PKI.mkdir(mode=0o700)
    def ossl(*a):
        sh(['/usr/bin/openssl', *a], 20, cwd=PKI)
    ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca-key.pem',
         '-out', 'ca-cert.pem', '-days', '1', '-subj', '/CN=rpc-lan-io-r1-ca',
         '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign')
    for name, cn, usage in (('server', 'rpc-lan-io-r1', 'serverAuth'), ('client', 'rpc-lan-io-client', 'clientAuth')):
        (PKI / (name + '.ext')).write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
                                           'extendedKeyUsage=' + usage + '\nsubjectAltName=DNS:' + cn + '\n')
        ossl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', name + '-key.pem',
             '-out', name + '.csr', '-subj', '/CN=' + cn)
        ossl('x509', '-req', '-in', name + '.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem', '-set_serial',
             '0x' + os.urandom(8).hex(), '-out', name + '-cert.pem', '-days', '1', '-extfile', name + '.ext')
    server = PKI / 'server'
    server.mkdir(mode=0o700)
    for n in ('ca-cert.pem', 'server-cert.pem', 'server-key.pem'):
        shutil.copy(PKI / n, server / n)
    (PKI / 'ca-key.pem').unlink()


def extents(image, fmt):
    """Allocated data extents (offset, length) of the image's virtual disk."""
    if SELFTEST:
        return Extents([0], [64 << 20])
    p = subprocess.Popen(['/usr/bin/qemu-img', 'map', '-U', '-f', fmt, '--output=json', image],
                         stdout=subprocess.PIPE, text=True)
    rows = Extents(array('Q'), array('Q'))
    for line in p.stdout:
        line = line.strip().strip('[],')
        if line:
            e = json.loads(line)
            if e.get('data') and not e.get('zero') and e['length'] >= 4096:
                rows.start.append(e['start'])
                rows.length.append(e['length'])
    assert p.wait(timeout=600) == 0, 'qemu-img map failed'
    return rows


class Extents:
    def __init__(self, start, length):
        self.start, self.length = start, length


def sample(rows, seed):
    """Offsets uniform over allocated bytes, 4KiB-aligned, 16KiB inside their extent."""
    cumulative, acc = array('Q'), 0
    for n in rows.length:
        cumulative.append(acc)
        acc += n
    rnd = random.Random(seed)
    out = bytearray()
    for _ in range(SAMPLES):
        x = rnd.randrange(acc)
        i = bisect.bisect_right(cumulative, x) - 1
        off, n = rows.start[i], rows.length[i]
        lo, hi = -(-off // 4096) * 4096, (off + n - 16384) // 4096 * 4096  # room for 16KiB reads
        pos = min(max((off + x - cumulative[i]) // 4096 * 4096, lo), hi) if lo <= hi else off
        out += pos.to_bytes(8, 'big')
    return bytes(out), acc


def bench(role, port, offsets_name, remote, seq):
    args = ['-addr', f'{"127.0.0.1" if SELFTEST else WARDEN_LAN}:{port}', '-export', 'rpc-lan-io-' + role,
            '-server-name', 'rpc-lan-io-r1', '-seq-start', str(seq[0]), '-seq-len', str(seq[1])]
    label = role + ('-nucbox-control-lan' if remote else '-warden-local')
    if remote:
        cmd = SSH + [GUEST, 'timeout', '110', GUEST_DIR + '/nbdbench', *args, '-ca', GUEST_DIR + '/ca-cert.pem',
                     '-cert', GUEST_DIR + '/client-cert.pem', '-key', GUEST_DIR + '/client-key.pem',
                     '-offsets', GUEST_DIR + '/' + offsets_name, '-label', label]
    else:
        cmd = ['/usr/bin/timeout', '110', str(TOOL), *args, '-ca', str(PKI / 'ca-cert.pem'),
               '-cert', str(PKI / 'client-cert.pem'), '-key', str(PKI / 'client-key.pem'),
               '-offsets', str(OUT / offsets_name), '-label', label]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    if r.returncode != 0:
        log(event='bench-failed', label=label, exit=r.returncode, stderr=r.stderr[-2000:])
        return None
    result = json.loads(r.stdout.strip().splitlines()[-1])
    (OUT / (label + '.json')).write_text(json.dumps(result, indent=1) + '\n')
    log(event='bench', label=label, phases=result['phases'], connectMs=result['connectMs'])
    return result


def main():
    OUT.mkdir(mode=0o700)
    (OUT / 'ATTEMPT.json').open('x').write(json.dumps({'once': True, 'at': time.time(), 'selftest': SELFTEST,
        'toolSha256': hashlib.sha256(TOOL.read_bytes()).hexdigest(),
        'runSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}) + '\n')
    admission()
    pki()
    images = [('st', str(OUT / 'selftest.raw'), 10899)] if SELFTEST else IMAGES
    if SELFTEST:
        with open(images[0][1], 'wb') as f:
            f.write(os.urandom(64 << 20))
    remote_ready = False
    try:
        for role, image, port in images:
            fmt = 'raw' if SELFTEST else 'qcow2'
            rows = extents(image, fmt)
            local, total = sample(rows, 'local-' + role)
            remote, _ = sample(rows, 'remote-' + role)
            i = max(range(len(rows.length)), key=rows.length.__getitem__)
            big = (rows.start[i], rows.length[i])
            seq = (-(-big[0] // (1 << 20)) * (1 << 20), (big[0] + big[1]) // (1 << 20) * (1 << 20))
            seq = (seq[0], seq[1] - seq[0])
            (OUT / ('offsets-local-' + role)).write_bytes(local)
            (OUT / ('offsets-remote-' + role)).write_bytes(remote)
            log(event='extents', role=role, image=image, extents=len(rows.length), allocatedBytes=total,
                largestExtent=list(big), seq=list(seq))
            server = subprocess.Popen(['/usr/sbin/qemu-nbd', '--read-only', '--shared=1', '--persistent',
                '--cache=none', '--aio=native', '--bind', '127.0.0.1' if SELFTEST else WARDEN_LAN,
                '--port', str(port), '--export-name', 'rpc-lan-io-' + role,
                '--object', 'tls-creds-x509,id=tls0,endpoint=server,dir=' + str(PKI / 'server') + ',verify-peer=on',
                '--object', 'authz-simple,id=auth0,identity=CN=rpc-lan-io-client',
                '--tls-creds', 'tls0', '--tls-authz', 'auth0', '--format', fmt, image],
                stdout=subprocess.DEVNULL, stderr=(OUT / ('qemu-nbd-' + role + '.log')).open('w'))
            try:
                time.sleep(1.5)
                assert server.poll() is None, 'qemu-nbd exited'
                log(event='export-started', role=role, pid=server.pid)
                bench(role, port, 'offsets-local-' + role, False, seq)
                if not SELFTEST:
                    if not remote_ready:
                        sh(SSH + [GUEST, 'mkdir', '-m', '700', GUEST_DIR], 30)
                        remote_ready = True
                        files = [TOOL, PKI / 'ca-cert.pem', PKI / 'client-cert.pem', PKI / 'client-key.pem']
                        sh(['/usr/bin/scp', '-q', *SSH[1:], *map(str, files), GUEST + ':' + GUEST_DIR + '/'], 60)
                    sh(['/usr/bin/scp', '-q', *SSH[1:], str(OUT / ('offsets-remote-' + role)), GUEST + ':' + GUEST_DIR + '/'], 60)
                    bench(role, port, 'offsets-remote-' + role, True, seq)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                log(event='export-stopped', role=role, exit=server.returncode)
    finally:
        if remote_ready:
            r = subprocess.run(SSH + [GUEST, 'rm', '-rf', GUEST_DIR], capture_output=True, timeout=30)
            log(event='guest-cleanup', exit=r.returncode)
        for p in PKI.rglob('*-key.pem'):
            p.unlink()
        if SELFTEST:
            (OUT / 'selftest.raw').unlink(missing_ok=True)
        log(event='done')


main()
