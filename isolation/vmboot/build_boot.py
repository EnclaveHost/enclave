#!/usr/bin/env python3
"""Wrap a whole-VM app image for one platform: the kernel, the initramfs (vm-init and every kernel module the boot
loads) and the kernel command line. This is the only part of a whole-VM image that differs between platforms; the
app image (root.img, root.verity, APP.json, and a model volume it may name) is the same bytes everywhere.

python3 -I isolation/vmboot/build_boot.py SPEC.json

SPEC.json (unknown fields refuse):
  out         new directory for the bootable image
  app         an app image directory: APP.json, root.img, root.verity (see APP.json below)
  platform    "sev-snp": QEMU/KVM with SEV-SNP, the layout rpc/snp/launch.py boots. ("shield", an Enclave Shield
              host, is not built yet: its boot image is an IGVM file and its kernel question is open.)
  kernel      {"vmlinuz": path, "sha256": hex}
  kernelRoot  {"image": path, "sha256": hex, "release": "6.8.0-147-generic"}: an ext4 image carrying that kernel's
              modules under /usr/lib/modules/<release>

APP.json, written by the app's own build:
  schema "enclave-vm-app/1"; rootHash, rootBlocks, rootSalt (dm-verity, sha256, 4096-byte blocks, no superblock);
  artifacts {"root.img": {bytes, sha256}, "root.verity": {...}}; kernelModules: names the app needs loaded;
  ports: its protected ports; models (optional): {dataBlocks, rootHash, salt}.

Out: vmlinuz, initrd.img, root.img and root.verity (hard links to the app's when possible), IMAGE.json with the
command line the launch identity covers. The app half of the command line (root hash and geometry, model volume) is
derived from APP.json alone, so it is the same string on every platform.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
FIELDS = {'out', 'app', 'platform', 'kernel', 'kernelRoot'}
HEX64 = re.compile('[0-9a-f]{64}')
# What the boot itself needs per platform, before and beyond what an app asks for. vm-init needs dm-verity and
# overlay everywhere; the rest is how the platform presents disks and makes reports.
PLATFORM_MODULES = {'sev-snp': ['dm-verity', 'overlay', 'tsm', 'sev-guest']}
PLATFORM_CMDLINE = {'sev-snp': 'console=ttyS0 panic=-1'}
MODULE_NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,40}')


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def run(argv, **kw):
    return subprocess.run([str(a) for a in argv], check=True, **kw)


def pinned(item, key):
    p = Path(item[key]).resolve(strict=True)
    if not HEX64.fullmatch(str(item.get('sha256'))) or sha(p) != item['sha256']:
        raise ValueError('pinned input differs: %s' % p)
    return p


def read_app(directory):
    """APP.json, checked against the files beside it. Returns (app, the app's half of the kernel command line)."""
    app = json.loads((directory/'APP.json').read_text())
    if app.get('schema') != 'enclave-vm-app/1' or set(app) - {'schema', 'rootHash', 'rootBlocks', 'rootSalt', 'artifacts',
                                                              'kernelModules', 'ports', 'models', 'inputs'}:
        raise ValueError('unsupported APP.json')
    if not (HEX64.fullmatch(str(app['rootHash'])) and HEX64.fullmatch(str(app['rootSalt']))) or type(app['rootBlocks']) is not int \
            or app['rootBlocks'] < 2:
        raise ValueError('APP.json root geometry')
    if set(app['artifacts']) != {'root.img', 'root.verity'}:
        raise ValueError('APP.json must pin root.img and root.verity')
    for name, row in app['artifacts'].items():
        if (directory/name).stat().st_size != row['bytes'] or sha(directory/name) != row['sha256']:
            raise ValueError('app artifact differs from APP.json: '+name)
    if app['artifacts']['root.img']['bytes'] != app['rootBlocks']*4096:
        raise ValueError('APP.json geometry is not the root image')
    if any(type(m) is not str or not MODULE_NAME.fullmatch(m) for m in app.get('kernelModules', [])):
        raise ValueError('APP.json kernelModules')
    cmdline = 'enclave.roothash=%s enclave.root=%d:%s' % (app['rootHash'], app['rootBlocks'], app['rootSalt'])
    m = app.get('models')
    if m is not None:
        if set(m) != {'dataBlocks', 'rootHash', 'salt'} or type(m['dataBlocks']) is not int or m['dataBlocks'] < 2 \
                or not (HEX64.fullmatch(str(m['rootHash'])) and HEX64.fullmatch(str(m['salt']))):
            raise ValueError('APP.json models')
        cmdline += ' enclave.models=%d:%s:%s' % (m['dataBlocks'], m['rootHash'], m['salt'])
    return app, cmdline


def module_order(modules, names):
    """The files to load for these modules, dependencies first, from the kernel's own modules.dep."""
    dep = {}
    for line in (modules/'modules.dep').read_text().splitlines():
        a, b = line.split(':', 1)
        dep[a] = b.split()
    builtin = (modules/'modules.builtin').read_text()
    out = []

    def add(f):
        for d in reversed(dep[f]):
            add(d)
        if f not in out:
            out.append(f)
    for m in names:
        spellings = {m, m.replace('-', '_'), m.replace('_', '-')}
        found = [f for f in dep if any(f.endswith('/%s.ko.zst' % s) or f.endswith('/%s.ko' % s) for s in spellings)]
        if len(found) == 1:
            add(found[0])
        elif found or not any('/%s.ko' % s in builtin for s in spellings):
            raise ValueError('kernel module %s is neither built in nor a single module' % m)
    return out


def main(specpath):
    os.umask(0o022)
    spec = json.loads(Path(specpath).read_text())
    if set(spec) != FIELDS:
        raise ValueError('unsupported build specification')
    platform = spec['platform']
    if platform not in PLATFORM_MODULES:
        raise ValueError('platform %r is not built here' % platform)
    appdir = Path(spec['app']).resolve(strict=True)
    app, app_cmdline = read_app(appdir)
    vmlinuz = pinned(spec['kernel'], 'vmlinuz')
    kroot = pinned(spec['kernelRoot'], 'image')
    release = spec['kernelRoot']['release']
    if not re.fullmatch(r'[0-9A-Za-z.+-]{1,64}', release):
        raise ValueError('kernel release')
    out = Path(spec['out']).resolve()
    out.mkdir(mode=0o700)
    work = out/'work'
    (work/'kernel').mkdir(parents=True)
    initrd = work/'initrd'
    (initrd/'modules').mkdir(parents=True)

    # debugfs cannot give the extracted files their owner as an ordinary user and says so; the bytes are what matter
    run(['/usr/sbin/debugfs', '-R', 'rdump /usr/lib/modules/%s %s' % (release, work/'kernel'), kroot], capture_output=True)
    modules = work/'kernel'/release
    if not (modules/'modules.dep').is_file():
        raise ValueError('the kernel root has no modules for '+release)
    lines = []
    for f in module_order(modules, PLATFORM_MODULES[platform] + app.get('kernelModules', [])):
        name = Path(f).name.removesuffix('.zst')
        if f.endswith('.zst'):
            run(['zstd', '-dqf', modules/f, '-o', initrd/'modules'/name])
        else:
            shutil.copyfile(modules/f, initrd/'modules'/name)
        os.chmod(initrd/'modules'/name, 0o444)
        lines.append('/modules/'+name)
    (initrd/'module-order.txt').write_text('\n'.join(lines)+'\n')
    run(['gcc', '-static', '-O2', '-Wall', '-Wextra', '-Werror', HERE/'vm-init.c', '-o', initrd/'init'])
    for d in ('proc', 'sys', 'dev', 'lower', 'rw', 'newroot'):
        (initrd/d).mkdir()
    for p in [initrd, *initrd.rglob('*')]:
        os.utime(p, (0, 0), follow_symlinks=False)
    entries = sorted(str(p.relative_to(initrd)) for p in initrd.rglob('*'))
    with open(out/'initrd.img', 'wb') as f:
        cpio = subprocess.Popen(['cpio', '-o', '-H', 'newc', '--reproducible', '--owner=0:0', '--quiet'], cwd=initrd,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        gz = subprocess.Popen(['gzip', '-n', '-6'], stdin=cpio.stdout, stdout=f)
        cpio.stdout.close()
        cpio.communicate(('\n'.join(entries)+'\n').encode())
        if cpio.returncode or gz.wait():
            raise RuntimeError('packing the initramfs failed')
    shutil.copyfile(vmlinuz, out/'vmlinuz')
    for name in ('root.img', 'root.verity'):
        try:
            os.link(appdir/name, out/name)
        except OSError:
            shutil.copyfile(appdir/name, out/name)
    cmdline = PLATFORM_CMDLINE[platform] + ' ' + app_cmdline
    image = {'schema': 'enclave-vm-image/1', 'platform': platform, 'kernel': release, 'cmdline': cmdline,
             'rootHash': app['rootHash'], 'app': app, 'appJsonSha256': sha(appdir/'APP.json'),
             'artifacts': {n: {'bytes': (out/n).stat().st_size, 'sha256': sha(out/n)}
                           for n in ('vmlinuz', 'initrd.img', 'root.img', 'root.verity')},
             'modules': [Path(x).name for x in lines],
             'inputs': {'kernelRootSha256': spec['kernelRoot']['sha256'],
                        'sources': {n: sha(HERE/n) for n in ('vm-init.c', 'build_boot.py')}}}
    (out/'IMAGE.json').write_text(json.dumps(image, indent=1)+'\n')
    shutil.rmtree(work)
    print(json.dumps({'platform': platform, 'rootHash': app['rootHash'], 'cmdline': cmdline}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: build_boot.py SPEC.json')
    main(sys.argv[1])
