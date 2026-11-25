#!/usr/bin/env python3
"""The catalog version config of a whole-VM app image: ONE root image, a launch identity per platform.

python3 -I isolation/vmboot/version_config.py IMAGE.json [IMAGE.json] [--snp VCPUS=MEASUREMENT ...] [--ovmf FILE]
                                              [--vcpu-type NAME]

Each IMAGE.json is what build_boot.py wrote for one platform. Given two, they must wrap the same app image: the same
root hash and the same APP.json, byte for byte. A platform appears once.

  sev-snp   needs every launch measurement to publish (--snp 8=<96 hex>, one per vCPU count the app may be booted
            with; build_boot.py does not compute it, the measurement depends on the host's firmware and vCPU model),
            the firmware it was computed for (--ovmf) and the vCPU model (--vcpu-type)
  shield    its launch identity is in IMAGE.json: the boot image's launch digest and guest SVN

It prints the part of the version config that says what the image is on each platform:

  {"runtime": "sev-snp-vm",
   "image":  {"rootHash": ..., "ovmfSha256": ..., "cmdlineSha256": ...},     the last two are the SEV-SNP wrapper's
   "snp":    {"measurements": {"8": "..."}, "vcpuType": "..."},
   "shield": {"launch": [{"bootDigest": ..., "guestSvn": n}]}}

network/snp-vm-app.mjs reads it (snpVmExpectation), and a host of a platform takes the version only if its platform is
listed. Nothing here publishes anything.
"""
import hashlib
import json
from pathlib import Path
import re
import sys

HEX64, HEX96 = re.compile('[0-9a-f]{64}'), re.compile('[0-9a-f]{96}')


def config(images, snp=None, ovmf_sha256=None, vcpu_type=None):
    """images: IMAGE.json objects; snp: {vcpus: measurement}. -> the version config's image part."""
    if not 1 <= len(images) <= 2:
        raise ValueError('one IMAGE.json per platform, at most two')
    by = {}
    for im in images:
        if im.get('schema') != 'enclave-vm-image/1' or im.get('platform') not in ('sev-snp', 'shield'):
            raise ValueError('not a whole-VM image record')
        if im['platform'] in by:
            raise ValueError('two images for platform %s' % im['platform'])
        if not HEX64.fullmatch(str(im.get('rootHash'))) or im['rootHash'] != im.get('app', {}).get('rootHash') \
                or not HEX64.fullmatch(str(im.get('appJsonSha256'))):
            raise ValueError('the %s image names no app image' % im['platform'])
        by[im['platform']] = im
    first = images[0]
    if any((im['rootHash'], im['appJsonSha256']) != (first['rootHash'], first['appJsonSha256']) for im in images):
        raise ValueError('the images wrap different app images: one root hash per version')
    out = {'runtime': 'sev-snp-vm', 'image': {'rootHash': first['rootHash']}}
    if 'sev-snp' in by:
        if not snp or not HEX64.fullmatch(str(ovmf_sha256)) or not vcpu_type:
            raise ValueError('the SEV-SNP wrapper needs its launch measurements, firmware and vCPU model')
        if any(not re.fullmatch('[1-9][0-9]{0,2}', str(k)) or not HEX96.fullmatch(str(v)) for k, v in snp.items()) \
                or len(set(snp.values())) != len(snp) or len(snp) > 16:
            raise ValueError('a launch measurement is 96 lowercase hex, one per vCPU count, each once')
        out['image'].update({'ovmfSha256': ovmf_sha256,
                             'cmdlineSha256': hashlib.sha256(by['sev-snp']['cmdline'].encode()).hexdigest()})
        out['snp'] = {'measurements': {str(k): snp[k] for k in sorted(snp, key=int)}, 'vcpuType': vcpu_type}
    elif snp or ovmf_sha256 or vcpu_type:
        raise ValueError('SEV-SNP values were given and no SEV-SNP image')
    if 'shield' in by:
        li = by['shield'].get('launchIdentity') or {}
        svn = li.get('guestSvn')
        if not HEX64.fullmatch(str(li.get('vbsBootDigest'))) or type(svn) is not int or not 0 <= svn <= 0xffffffff:
            raise ValueError('the Shield image records no launch identity')
        out['shield'] = {'launch': [{'bootDigest': li['vbsBootDigest'], 'guestSvn': svn}]}
    return out


def main(argv):
    images, snp, ovmf, vcpu = [], {}, None, None
    it = iter(argv)
    for a in it:
        if a == '--snp':
            k, _, v = next(it).partition('=')
            if k in snp:
                raise ValueError('vCPU count %s given twice' % k)
            snp[k] = v
        elif a == '--ovmf':
            with open(next(it), 'rb') as f:
                ovmf = hashlib.file_digest(f, 'sha256').hexdigest()
        elif a == '--vcpu-type':
            vcpu = next(it)
        elif a.startswith('-'):
            raise ValueError('unknown option '+a)
        else:
            images.append(json.loads(Path(a).read_text()))
    print(json.dumps(config(images, snp or None, ovmf, vcpu), indent=1))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
