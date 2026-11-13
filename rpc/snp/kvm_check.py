"""Boot a built guest image under plain KVM and read what it does with memory it is not asked for.

python3 -I rpc/snp/kvm_check.py IMAGE_DIR OUT_DIR [--baseline]

The same kernel, initramfs, verity root and kernel command line the SNP launch measures, without SEV-SNP and
without chain disks, plus one thing the measured launch never has: systemd.run= on the command line, which runs
memory-check.sh (from a read-only disk) as root in place of the default target. So this is a test rig for the
image's contents, not a launch of the product, and it says nothing about attestation. The image has no shell
access by design; a different command line is the only way in, and it changes the SNP measurement.

OUT_DIR gets console.log, check.log (the guest script's own lines) and result.json (those lines as facts, and the
verdict). --baseline records an older image without judging it. Exit status 0 when every check holds.
"""
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_image  # noqa: E402

MEM_MIB = 8192
CAP_MB = 256
TIMEOUT = 1500


def facts(console):
    """{'unit': [['rsyslog.service', 'masked', 'inactive'], ...], 'end': [[]], ...} from the guest's QUAL lines"""
    out = {}
    for line in console.splitlines():
        at = line.find('QUAL ')
        if at >= 0:
            key, *rest = line[at+5:].split()
            out.setdefault(key, []).append(rest)
    return out


def pairs(words):
    return dict(w.split('=', 1) for w in words if '=' in w)


def verdict(f):
    """[(check, holds, what was seen)]"""
    total = int(f['memtotal-kb'][0][0]) * 1024
    conf = dict(' '.join(w).split('=', 1) for w in f.get('journald-conf', []))
    base_conf = dict(' '.join(w).split('=', 1) for w in f.get('journald-base-conf', []))
    units = {u[0]: u[1:] for u in f.get('unit', [])}
    slice_ = pairs(f['slice-loaded'][0])
    base = pairs(f['qual-base-cgroup'][0])
    probe = f['probe-after'][0]
    sizes = {d[0]: int(d[1]) for d in f.get('journal-mb-after-flood', [])}
    kept = pairs(f['journal-lines-kept'][0])

    def share(value, percent):
        return value.isdigit() and abs(int(value) - total * percent // 100) <= 2 * 4096

    return [
        ('the check ran to its end', 'end' in f, f.get('boot')),
        ('no unit failed', not f.get('failed'), f.get('failed')),
        ('every stock unit the image masks is masked and not running',
         set(units) == set(build_image.MASKED_UNITS) and all(v[0] == 'masked' and v[1] != 'active' for v in units.values()),
         {k: v for k, v in units.items() if v[0] != 'masked' or v[1] == 'active'}),
        ('the journal is capped and not copied to syslog',
         conf.get('SystemMaxUse') == '%dM' % CAP_MB and conf.get('ForwardToSyslog') == 'no' and conf.get('Storage') == 'persistent'
         and base_conf.get('SystemMaxUse') == '%dM' % CAP_MB and base_conf.get('ForwardToSyslog') == 'no', [conf, base_conf]),
        ('no syslog file grows', f['syslog-file-after-flood'][0] == f['syslog-file'][0], [f['syslog-file'], f['syslog-file-after-flood']]),
        ('each journal stays within its cap after more text than it holds',
         len(sizes) == 2 and all(CAP_MB // 2 <= v <= CAP_MB + 40 for v in sizes.values()) and int(kept['base']) > 0 and int(kept['main']) > 0
         and int(kept['base']) < 2000000 and int(kept['main']) < 2000000 and set(pairs(f['flood-suppressed'][0]).values()) == {'0'},
         [sizes, kept, f['flood'], f['flood-suppressed']]),
        ('the Base unit logs to its own journal and the front reads it',
         int(f['ns-every-namespace-sees-base'][0][0]) >= 2 and f['ns-default-sees-base'][0][0] == '0'
         and int(f['ns-every-namespace-sees-default'][0][0]) >= 1 and f['journald-base'][0][0] == 'active'
         and f['front-journal'][0] == ['200', '200'],
         [f['ns-every-namespace-sees-base'], f['ns-default-sees-base'], f['front-journal'], f['qual-base']]),
        ('the limits are shares of the memory the guest was given',
         share(slice_['high'], build_image.CLIENTS_HIGH) and share(slice_['max'], build_image.CLIENTS_MAX)
         and share(base['max'], build_image.CLIENT_MAX['base']) and base['high'] == 'max', [total, slice_, base]),
        ('the probe asked the loaded slice and set no limit',
         probe[0] == 'measuring' and int(probe[2]) >= 1 and pairs(f['slice-probed'][0])['high'] == slice_['high']
         and pairs(f['slice-probed'][0])['max'] == slice_['max'] and f['qual-base-still'][0][0] == 'active',
         [probe, f['slice-probed']]),
        ('the front reports the guest\'s memory', f['front-memory'][0][0].startswith('{"at"'), f['front-memory'][0][0][:80]),
    ]


def main(image, out, baseline=False):
    image, out = Path(image), Path(out)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    meta = json.loads((image/'IMAGE.json').read_text())
    script = ("UNITS='%s'\n" % ' '.join(build_image.MASKED_UNITS)).encode() + (HERE/'memory-check.sh').read_bytes()
    (out/'check.img').write_bytes(script + b'\n' * ((1 << 20) - len(script)))
    for name in ('l1', 'base'):
        subprocess.run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', str(out/(name+'.qcow2')), '1G'], check=True)
    cmdline = (meta['cmdline'] + ' systemd.run="/bin/sh /dev/disk/by-id/virtio-QUAL"'
               ' systemd.run_success_action=poweroff-force systemd.run_failure_action=poweroff-force')
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--ro-bind', '/', '/',
            '--bind', str(out), str(out), '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm', '--',
            '/usr/sbin/qemu-system-x86_64', '-name', 'rpc-snp-image-check', '-machine', 'q35,accel=kvm', '-cpu', 'host',
            '-smp', '4', '-m', str(MEM_MIB), '-nodefaults', '-no-reboot', '-display', 'none', '-monitor', 'none',
            '-serial', 'file:'+str(out/'console.log'), '-serial', 'file:'+str(out/'check.log'),
            '-kernel', str(image/'vmlinuz'), '-initrd', str(image/'initrd.img'), '-append', cmdline,
            '-drive', 'file=%s,format=raw,if=none,id=root0,readonly=on' % (image/'root.img'),
            '-device', 'virtio-blk-pci,drive=root0,serial=ROOT-DATA',
            '-drive', 'file=%s,format=raw,if=none,id=hash0,readonly=on' % (image/'root.verity'),
            '-device', 'virtio-blk-pci,drive=hash0,serial=ROOT-HASH',
            '-drive', 'file=%s,format=raw,if=none,id=qual0,readonly=on' % (out/'check.img'),
            '-device', 'virtio-blk-pci,drive=qual0,serial=QUAL',
            '-drive', 'file=%s,format=qcow2,if=none,id=l1' % (out/'l1.qcow2'), '-device', 'virtio-blk-pci,drive=l1,serial=RPC-l1',
            '-drive', 'file=%s,format=qcow2,if=none,id=base' % (out/'base.qcow2'), '-device', 'virtio-blk-pci,drive=base,serial=RPC-base',
            '-netdev', 'user,id=net0,restrict=on', '-device', 'virtio-net-pci,netdev=net0']
    try:
        subprocess.run(args, check=True, timeout=TIMEOUT)
    finally:
        for name in ('l1.qcow2', 'base.qcow2', 'check.img'):
            (out/name).unlink(missing_ok=True)
    f = facts((out/'check.log').read_text(errors='replace'))
    result = {'schema': 'enclave-rpc-snp-image-check/1', 'image': str(image), 'rootHash': meta['rootHash'],
              'memoryMiB': MEM_MIB, 'baseline': baseline, 'facts': f}
    if not baseline and 'end' not in f:
        result['checks'] = [{'check': 'the check ran to its end', 'holds': False, 'seen': sorted(f)}]
    elif not baseline:
        result['checks'] = [{'check': c, 'holds': bool(ok), 'seen': seen} for c, ok, seen in verdict(f)]
    if not baseline:
        for c in result['checks']:
            print('%s  %s%s' % ('ok  ' if c['holds'] else 'FAIL', c['check'], '' if c['holds'] else '  ' + json.dumps(c['seen'])))
    (out/'result.json').write_text(json.dumps(result, indent=1) + '\n')
    return 0 if baseline and 'end' in f or not baseline and all(c['holds'] for c in result['checks']) else 1


if __name__ == '__main__':
    sys.exit(main(*[a for a in sys.argv[1:] if a != '--baseline'], baseline='--baseline' in sys.argv))
