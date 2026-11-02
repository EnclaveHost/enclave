"""Backfill Base receipt and transaction history into an existing snapshot data disk.

python3 -I rpc/snp/base_history_backfill.py WORK_DIR BASE_QCOW2 SNAPSHOT_MANIFEST FS_UUID FROM_BLOCK UPTO_BLOCK

The guest chain service serves Base history from chain.json baseRetention.historyFromBlock
and refuses to start unless the receipts and transactions static files holding that block
exist. A snapshot downloaded with a distance profile holds only the newest files. This adds
the files whose ranges start in [FROM_BLOCK, UPTO_BLOCK), and nothing else: the mdbx state,
headers, changesets and reth.toml are not touched (`base snapshot download` would also
queue and re-verify the 1.1 TB state archive).

One ordinary KVM VM boots a throwaway overlay of the pinned boot image (as build_image.py)
with the Base disk attached, so ext4 is written by a kernel, not by host tools. In the VM,
root downloads each archive (resuming .part files in data/.download-cache), extracts it to
a staging directory on the same filesystem, requires exactly the manifest's output files
with their sizes and blake3 digests, then renames them into data/static_files with the
owner and mode of the existing static files. A receipt listing every added file is
written to the disk root (backfill-FROM-UPTO.json) and, with the guest's log and exit
status, to a small results disk that this host process reads back with debugfs.

The disk must not be attached to any other VM while this runs.
"""
import base64
import json
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_image import BOOT_SHA256, BOOT_VHDX, run, sha  # noqa: E402

SEGMENTS = ('receipts', 'transactions')

GUEST = r'''
import concurrent.futures, json, os, pathlib, shutil, subprocess, sys, threading
plan = json.load(open('/opt/backfill/plan.json'))
root = pathlib.Path('/mnt/base'); data = root/'data'; static = data/'static_files'
cache = data/'.download-cache'; stage = data/'.backfill-stage'
ref = os.stat(static/plan['reference'])
cache.mkdir(exist_ok=True); stage.mkdir(exist_ok=True)
def log(**kw): print(json.dumps(kw), flush=True)
ZSTD_MAGIC = bytes.fromhex('28b52ffd')
def fetch(a):
    part = cache/(pathlib.Path(a['file']).name + '.part')
    for attempt in range(3):
        # A partial left by another downloader may not be this archive's bytes at all.
        if part.exists() and (part.stat().st_size > a['size'] or part.open('rb').read(4) not in (ZSTD_MAGIC, b'')):
            part.unlink()
        subprocess.run(['curl', '-fsSL', '--retry', '30', '--retry-all-errors', '--retry-delay', '5',
                        '-C', '-', '-o', str(part), a['url']], check=False)
        if part.exists() and part.stat().st_size == a['size']:
            return part
    raise SystemExit('download size mismatch: ' + a['file'])
lock = threading.Lock(); added = []; present_files = []
def extract(a, part, out):
    shutil.rmtree(out, ignore_errors=True); out.mkdir()
    if subprocess.run('set -o pipefail; zstd -dc %s | tar -x -C %s' % (part, out), shell=True, executable='/bin/bash').returncode:
        return 'archive does not extract'
    got = sorted(str(p.relative_to(out)) for p in out.rglob('*') if p.is_file())
    want = sorted(o['path'] for o in a['outputs'])
    if got != want:
        return 'archive outputs differ: %s' % sorted(set(got) ^ set(want))
    for o in a['outputs']:
        p = out/o['path']
        if p.stat().st_size != o['size']:
            return 'output size differs: ' + o['path']
        if subprocess.run(['b3sum', '--no-names', str(p)], check=True, capture_output=True, text=True).stdout.strip() != o['blake3']:
            return 'output blake3 differs: ' + o['path']
def install(a):
    present = [(data/o['path']).exists() for o in a['outputs']]
    if all(present):
        # Installed by an earlier run, which verified the blake3 digests before the rename.
        bad = [o['path'] for o in a['outputs'] if (data/o['path']).stat().st_size != o['size']]
        if bad:
            raise SystemExit('installed output size differs: %s' % bad)
        log(event='archive-present', file=a['file']); present_files.append(a['file'])
        return
    if any(present):
        raise SystemExit('archive partly installed: ' + a['file'])
    out = stage/pathlib.Path(a['file']).name
    for attempt in range(2):
        part = fetch(a)
        with lock:
            err = extract(a, part, out)
            if err is None:
                break
            log(event='archive-rejected', file=a['file'], error=err)
            shutil.rmtree(out, ignore_errors=True); part.unlink()
    else:
        raise SystemExit('%s: %s' % (a['file'], err))
    with lock:
        for o in a['outputs']:
            p, dest = out/o['path'], data/o['path']
            if dest.exists():
                raise SystemExit('refusing to replace existing ' + o['path'])
            os.chown(p, ref.st_uid, ref.st_gid); os.chmod(p, ref.st_mode & 0o7777)
            os.rename(p, dest); added.append(o)
        shutil.rmtree(out); part.unlink()
        subprocess.run(['fstrim', str(root)], check=False)
        log(event='archive-installed', file=a['file'], outputs=len(a['outputs']))
with concurrent.futures.ThreadPoolExecutor(4) as ex:
    for f in [ex.submit(install, a) for a in plan['archives']]:
        f.result()
shutil.rmtree(stage)
receipt = {'format': 'enclave-base-history-backfill/1', 'manifestSha256': plan['manifestSha256'],
           'fromBlock': plan['fromBlock'], 'uptoBlock': plan['uptoBlock'], 'archives': [a['file'] for a in plan['archives']],
           'added': added, 'alreadyPresent': sorted(present_files), 'owner': [ref.st_uid, ref.st_gid], 'mode': oct(ref.st_mode & 0o7777)}
path = root/('backfill-%d-%d.json' % (plan['fromBlock'], plan['uptoBlock']))
path.write_text(json.dumps(receipt, indent=1) + '\n'); os.chmod(path, 0o644)
os.sync()
log(event='backfill-complete', added=len(added))
'''


def plan_archives(manifest, lo, hi):
    archives = []
    for seg in SEGMENTS:
        c = manifest['components'][seg]
        for f, size, outputs in zip(c['chunk_files'], c['chunk_sizes'], c['chunk_output_files']):
            start = int(f.rsplit('-', 2)[-2])
            if lo <= start < hi:
                archives.append({'file': f, 'url': manifest['base_url'].rstrip('/') + '/' + f, 'size': size,
                                 'outputs': outputs})
    want = {(seg, s) for seg in SEGMENTS for s in range(lo, hi, manifest['components'][seg]['blocks_per_file'])}
    have = {(a['file'].split('/')[-1].split('-')[0], int(a['file'].rsplit('-', 2)[-2])) for a in archives}
    if want != have:
        raise ValueError('manifest does not list every archive in range: %s' % sorted(want - have))
    return archives


def main(work, disk, manifest_path, uuid, lo, hi):
    work, disk, lo, hi = Path(work), Path(disk), int(lo), int(hi)
    work.mkdir(mode=0o700)
    if sha(BOOT_VHDX) != BOOT_SHA256:
        raise ValueError('Pinned boot image changed')
    manifest = json.loads(Path(manifest_path).read_text())
    plan = {'manifestSha256': sha(manifest_path), 'fromBlock': lo, 'uptoBlock': hi,
            'reference': 'static_file_receipts_%d_%d' % (hi, hi + manifest['components']['receipts']['blocks_per_file'] - 1),
            'archives': plan_archives(manifest, lo, hi)}
    (work/'plan.json').write_text(json.dumps(plan, indent=1)+'\n')
    script = '\n'.join([
        'set -eux',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get -q -o DPkg::Lock::Timeout=600 update', 'apt-get -qy -o DPkg::Lock::Timeout=600 install b3sum zstd curl',
        'mkdir -p /mnt/base', 'mount -o noatime UUID=%s /mnt/base' % uuid,
        'python3 -I /opt/backfill/guest.py',
        'cp /mnt/base/backfill-%d-%d.json /mnt/results/receipt.json' % (lo, hi),
        'umount /mnt/base', 'sync',
    ])

    def wf(path, data, mode='0644'):
        return {'path': path, 'owner': 'root:root', 'permissions': mode, 'encoding': 'b64',
                'content': base64.b64encode(data).decode()}
    cloud = {'ssh_pwauth': False, 'disable_root': True, 'package_update': False, 'package_upgrade': False,
             'write_files': [wf('/opt/backfill/plan.json', json.dumps(plan).encode()),
                             wf('/opt/backfill/guest.py', GUEST.encode()),
                             wf('/opt/backfill/run.sh', script.encode()+b'\n', '0700')],
             'runcmd': [['bash', '-c', 'mkdir -p /mnt/results && mount /dev/disk/by-id/virtio-RESULTS /mnt/results; '
                         '/opt/backfill/run.sh > /mnt/results/backfill.log 2>&1; echo $? > /mnt/results/rc; '
                         'umount /mnt/results; sync; poweroff']]}
    seed = work/'seed'
    seed.mkdir(mode=0o700)
    (seed/'user-data').write_text('#cloud-config\n'+json.dumps(cloud)+'\n')
    (seed/'meta-data').write_text('instance-id: base-backfill-%d\nlocal-hostname: base-backfill\n' % lo)
    run(['/usr/bin/xorriso', '-as', 'mkisofs', '-V', 'cidata', '-J', '-r', '-o', str(work/'seed.iso'),
         str(seed/'user-data'), str(seed/'meta-data')])
    run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'vhdx', '-b', str(BOOT_VHDX), str(work/'os.qcow2'), '8G'])
    # getty hangs up ttyS0 at its login prompt, so the guest reports on a small results disk.
    run(['/usr/bin/truncate', '-s', '64M', str(work/'results.img')])
    run(['/usr/sbin/mkfs.ext4', '-q', str(work/'results.img')])
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--ro-bind', '/', '/',
            '--bind', str(work), str(work), '--bind', str(disk), str(disk),
            '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm', '--',
            '/usr/sbin/qemu-system-x86_64', '-name', 'rpc-base-history-backfill', '-machine', 'q35,accel=kvm', '-cpu', 'host',
            '-smp', '4', '-m', '4096', '-nodefaults', '-no-reboot', '-display', 'none', '-monitor', 'none',
            '-serial', 'file:'+str(work/'console.log'),
            '-drive', 'file='+str(work/'os.qcow2')+',format=qcow2,if=none,id=os0,cache=none',
            '-device', 'virtio-blk-pci,drive=os0,bootindex=0',
            '-drive', 'file='+str(disk)+',format=qcow2,if=none,id=base0,cache=none,discard=unmap',
            '-device', 'virtio-blk-pci,drive=base0,serial=RPC-base',
            '-drive', 'file='+str(work/'results.img')+',format=raw,if=none,id=res0,cache=none',
            '-device', 'virtio-blk-pci,drive=res0,serial=RESULTS',
            '-drive', 'file='+str(work/'seed.iso')+',format=raw,media=cdrom,readonly=on',
            '-netdev', 'user,id=net0', '-device', 'virtio-net-pci,netdev=net0']
    t = time.time()
    r = subprocess.run(args, capture_output=True, text=True)
    (work/'os.qcow2').unlink()
    for name in ('backfill.log', 'receipt.json', 'rc'):
        subprocess.run(['/usr/sbin/debugfs', '-R', 'dump /%s %s' % (name, work/name), str(work/'results.img')],
                       capture_output=True)
    rc = (work/'rc').read_text().strip() if (work/'rc').exists() else None
    if r.returncode != 0 or rc != '0' or not (work/'receipt.json').exists():
        raise RuntimeError('backfill VM did not complete (rc %s); see backfill.log %s' % (rc, r.stderr[-400:]))
    receipt = json.loads((work/'receipt.json').read_text())
    result = {'seconds': round(time.time()-t), 'disk': str(disk), 'planSha256': sha(work/'plan.json'),
              'added': len(receipt['added']), 'receiptSha256': sha(work/'receipt.json')}
    (work/'RESULT.json').write_text(json.dumps(result, indent=1)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main(*sys.argv[1:7])
