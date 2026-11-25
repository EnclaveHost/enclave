#!/usr/bin/env python3
"""Wrap a whole-VM app image for one platform: the kernel, the initramfs (vm-init and every kernel module the boot
loads) and the kernel command line. This is the only part of a whole-VM image that differs between platforms; the
app image (root.img, root.verity, APP.json, and a model volume it may name) is the same bytes everywhere.

python3 -I isolation/vmboot/build_boot.py SPEC.json

SPEC.json (unknown fields refuse):
  out         new directory for the bootable image
  app         an app image directory: APP.json, root.img, root.verity (see APP.json below)
  platform    "sev-snp": QEMU/KVM with SEV-SNP, the layout rpc/snp/launch.py boots.
              "shield": an Enclave Shield host (a Hyper-V partition under the OpenHCL paravisor). Built, never booted.
  kernel      {"vmlinuz": path, "sha256": hex}
  kernelRoot  {"image": path, "sha256": hex, "release": "6.8.0-147-generic"}: an ext4 image carrying that kernel's
              modules under /usr/lib/modules/<release>
  shield      for platform "shield" only: {"igvmfilegen", "openhclBoot", "underhillKernel", "underhillInitrd":
              {"path", "sha256"} each (the reviewed OpenHCL set, pinned below), "tpmModule": {"path", "sha256"} (the
              paravisor TPM driver built for this kernel, shield-tpm/build.sh), "guestSvn": the image's security
              version number}

APP.json, written by the app's own build:
  schema "enclave-vm-app/1"; rootHash, rootBlocks, rootSalt (dm-verity, sha256, 4096-byte blocks, no superblock);
  artifacts {"root.img": {bytes, sha256}, "root.verity": {...}}; kernelModules: names the app needs loaded;
  ports: its protected ports; models (optional): {dataBlocks, rootHash, salt}.

Out, sev-snp: vmlinuz, initrd.img, root.img and root.verity (hard links to the app's when possible), IMAGE.json with
the command line the launch measurement covers.
Out, shield: image.igvm (the paravisor, the kernel as an ELF image, the initramfs and the command line, which is what
Hyper-V loads and what the launch identity, the VBS boot digest, covers), image-vbs.json (igvmfilegen's statement
of that digest), ROOT_DATA.iso and ROOT_HASH.iso (the app's disks in wrap_iso.py's container), IMAGE.json.

The app half of the command line (root hash and geometry, model volume) is derived from APP.json alone, so it is the
same string on every platform.
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
SHIELD_FIELDS = {'igvmfilegen', 'openhclBoot', 'underhillKernel', 'underhillInitrd', 'tpmModule', 'guestSvn'}
HEX64 = re.compile('[0-9a-f]{64}')
# What the boot itself needs per platform, before and beyond what an app asks for. vm-init needs dm-verity and
# overlay everywhere; the rest is how the platform presents disks and makes reports.
PLATFORM_MODULES = {'sev-snp': ['dm-verity', 'overlay', 'tsm', 'sev-guest'],
                    # Hyper-V's bus, its SCSI (the DVD drives the disks arrive on) and its sockets (how the host
                    # reaches the front); the paravisor TPM driver is a file of its own (spec.shield.tpmModule)
                    'shield': ['dm-verity', 'overlay', 'hv_vmbus', 'hv_storvsc', 'hv_sock']}
PLATFORM_CMDLINE = {'sev-snp': 'console=ttyS0 panic=-1', 'shield': 'console=ttyS0 loglevel=3 panic=-1'}
# The OpenHCL set the Shield hosts' admitted desktop image is built from (the non-debug recipe; the paravisor
# initramfs carries the guest-only volatile report input patch). Anything else is an unreviewed paravisor.
SHIELD_PINS = {'igvmfilegen': '81647f66a88559d68c4d7565dfdcc355305c00cc842b49403a3c5188c36e1a1c',
               'openhclBoot': '18dbeae950c1c143364638892ace4c2cf2128eb12d67f3de05bdbe37b2fd16bc',
               'underhillKernel': '4d6c417654d5d26374c3bc44ed1c6473d5a0d9e7b9773d2bb1dab2abe5306762',
               'underhillInitrd': '71a91101f8f9b870199946076db2b220c68167e029539d4619a6b7600432124e'}
TPM_MODULE = 'enclave_openhcl_tpm.ko'
ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'
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


def elf_kernel(vmlinuz, out):
    """The uncompressed ELF kernel inside a zstd bzImage (what scripts/extract-vmlinux does): the paravisor's
    direct-boot loader takes an ELF image, a distribution ships the compressed one."""
    raw = Path(vmlinuz).read_bytes()
    at = -1
    while (at := raw.find(ZSTD_MAGIC, at+1)) >= 0:
        r = subprocess.run(['zstd', '-dcq'], input=raw[at:], capture_output=True)
        if r.stdout[:4] == b'\x7fELF' and r.stdout[4] == 2 and int.from_bytes(r.stdout[18:20], 'little') == 62:
            Path(out).write_bytes(r.stdout)
            return
    raise ValueError('no zstd-compressed x86-64 ELF kernel in the kernel image')


def igvm_manifest(guest_svn, cmdline):
    """The reviewed non-debug VBS recipe (the Shield desktop's), with this image's command line and version."""
    if type(guest_svn) is not int or not 1 <= guest_svn <= 0xffff:
        raise ValueError('guestSvn')
    if not re.fullmatch(r'[\x20-\x7e]{1,2000}', cmdline) or '"' in cmdline or '\\' in cmdline:
        raise ValueError('command line')
    return {'guest_arch': 'x64', 'guest_configs': [{
        'guest_svn': guest_svn, 'max_vtl': 2, 'isolation_type': {'vbs': {'enable_debug': False}},
        'image': {'openhcl': {'command_line': 'OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux', 'memory_page_count': 16384,
                              'memory_page_base': 32768, 'linux': {'use_initrd': True, 'command_line': cmdline},
                              'static_command_line': True}}}]}


def build_igvm(shield, kernel_elf, initrd, cmdline, out, name):
    """Run the pinned igvmfilegen. Returns the VBS boot digest it states for the image."""
    work = out/('.igvm-'+name)
    work.mkdir()
    tool = work/'igvmfilegen'
    shutil.copyfile(shield['igvmfilegen'], tool)
    os.chmod(tool, 0o500)
    (work/'manifest.json').write_text(json.dumps(igvm_manifest(shield['guestSvn'], cmdline), indent=2))
    (work/'resources.json').write_text(json.dumps({'resources': {
        'openhcl_boot': str(shield['openhclBoot']), 'underhill_kernel': str(shield['underhillKernel']),
        'underhill_initrd': str(shield['underhillInitrd']), 'linux_kernel': str(kernel_elf), 'linux_initrd': str(initrd)}}))
    r = subprocess.run([str(tool), 'manifest', '-m', str(work/'manifest.json'), '-r', str(work/'resources.json'),
                        '-o', str(work/(name+'.bin'))], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                       env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=120)
    if r.returncode != 0:
        raise RuntimeError('igvmfilegen failed: '+(r.stderr or r.stdout).strip().splitlines()[-1])
    vbs = json.loads((work/(name+'-vbs.json')).read_text())
    series = vbs['series']
    if len(series) != 1 or series[0]['endorsement']['build_info']['debug_build'] is not False \
            or series[0]['endorsement']['vbs_isvsvn'] != shield['guestSvn']:
        raise RuntimeError('the image is not the non-debug build at the stated version')
    digest = series[0]['reference']['vbs_boot_digest'].lower()
    if not HEX64.fullmatch(digest) or int(digest, 16) == 0:
        raise RuntimeError('no VBS boot digest')
    return work, digest


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
    platform = spec.get('platform')
    if platform not in PLATFORM_MODULES:
        raise ValueError('platform %r is not built here' % platform)
    if set(spec) != FIELDS | ({'shield'} if platform == 'shield' else set()):
        raise ValueError('unsupported build specification')
    shield = None
    if platform == 'shield':
        if set(spec['shield']) != SHIELD_FIELDS:
            raise ValueError('unsupported shield specification')
        shield = {'guestSvn': spec['shield']['guestSvn']}
        for name, pin in SHIELD_PINS.items():
            if spec['shield'][name].get('sha256') != pin:
                raise ValueError('unreviewed OpenHCL input: '+name)
            shield[name] = pinned(spec['shield'][name], 'path')
        shield['tpmModule'] = pinned(spec['shield']['tpmModule'], 'path')
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
    if shield:
        # built for this very kernel, or the kernel refuses it: the release is in the module's vermagic
        if (b'vermagic='+release.encode()+b' ') not in shield['tpmModule'].read_bytes():
            raise ValueError('the TPM module was not built for '+release)
        shutil.copyfile(shield['tpmModule'], initrd/'modules'/TPM_MODULE)
        os.chmod(initrd/'modules'/TPM_MODULE, 0o444)
        lines.append('/modules/'+TPM_MODULE)
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
    cmdline = PLATFORM_CMDLINE[platform] + ' ' + app_cmdline
    image = {'schema': 'enclave-vm-image/1', 'platform': platform, 'kernel': release, 'cmdline': cmdline,
             'rootHash': app['rootHash'], 'app': app, 'appJsonSha256': sha(appdir/'APP.json'),
             'modules': [Path(x).name for x in lines],
             'inputs': {'kernelRootSha256': spec['kernelRoot']['sha256'], 'kernelSha256': spec['kernel']['sha256'],
                        'sources': {n: sha(HERE/n) for n in ('vm-init.c', 'build_boot.py')}}}
    if platform == 'sev-snp':
        shutil.copyfile(vmlinuz, out/'vmlinuz')
        for name in ('root.img', 'root.verity'):
            try:
                os.link(appdir/name, out/name)
            except OSError:
                shutil.copyfile(appdir/name, out/name)
        names = ('vmlinuz', 'initrd.img', 'root.img', 'root.verity')
    else:
        elf_kernel(vmlinuz, work/'vmlinux.elf')
        # twice, from the same inputs: an image whose bytes or digest differ between runs has no identity to publish
        first, digest = build_igvm(shield, work/'vmlinux.elf', out/'initrd.img', cmdline, work, 'image')
        second, again = build_igvm(shield, work/'vmlinux.elf', out/'initrd.img', cmdline, work, 'again')
        if digest != again or sha(first/'image.bin') != sha(second/'again.bin'):
            raise RuntimeError('the boot image is not deterministic')
        shutil.copyfile(first/'image.bin', out/'image.igvm')
        shutil.copyfile(first/'image-vbs.json', out/'image-vbs.json')
        import wrap_iso
        discs = {}
        for label, name in (('ROOT_DATA', 'root.img'), ('ROOT_HASH', 'root.verity')):
            discs[label] = wrap_iso.wrap(label, appdir/name, out/(label+'.iso'), app['artifacts'][name]['sha256'])
        (out/'initrd.img').unlink()   # it is inside image.igvm; a second copy beside it would only invite a mismatch
        image.update({'launchIdentity': {'vbsBootDigest': digest, 'guestSvn': shield['guestSvn']}, 'discs': discs,
                      'kernelElfSha256': sha(work/'vmlinux.elf')})
        image['inputs'].update({'openhcl': SHIELD_PINS, 'tpmModuleSha256': spec['shield']['tpmModule']['sha256']})
        names = ('image.igvm', 'image-vbs.json', 'ROOT_DATA.iso', 'ROOT_HASH.iso')
    image['artifacts'] = {n: {'bytes': (out/n).stat().st_size, 'sha256': sha(out/n)} for n in names}
    (out/'IMAGE.json').write_text(json.dumps(image, indent=1)+'\n')
    shutil.rmtree(work)
    print(json.dumps({'platform': platform, 'rootHash': app['rootHash'], 'cmdline': cmdline,
                      **({'vbsBootDigest': image['launchIdentity']['vbsBootDigest']} if shield else {})}))


if __name__ == '__main__':
    sys.path.insert(0, str(HERE))
    if len(sys.argv) != 2:
        raise SystemExit('usage: build_boot.py SPEC.json')
    main(sys.argv[1])
