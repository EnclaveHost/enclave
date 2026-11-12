"""Assemble a catalog release of the SEV-SNP RPC image.

python3 -I rpc/snp/release.py IMAGE_DIR OUT_DIR --version LABEL --vcpus N --mem-mib M --media PREVIEW_CONFIG.json
    --runner ADDRESS --enclave-id 0x.. --journal FILE

Writes OUT_DIR/RELEASE-MANIFEST.json (public, for IPFS: everything needed to rebuild and
re-measure the image) and OUT_DIR/release.json (input for rpc/snp/owner-sign/plan.mjs, with
the version's immutable on-chain config). The launch measurement is computed offline with
sev-snp-measure from OVMF + kernel + initrd + the measured cmdline, exactly as the guest
launches (rpc/snp/launch.py), and must later equal the live report's measurement.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

OVMF = Path('/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd')
OWNER = '0x0b2d009c0c9Af05b12100D77F3c815fea822eE61'
APP_ID = '0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537'
SLUG, NAME = 'enclave-rpc', 'Enclave RPC'
DESCRIPTION = ('Ethereum and Base JSON-RPC served from an AMD SEV-SNP confidential VM. Clients verify the '
               "enclave's AMD-signed attestation before use: the launch measurement is pinned in this version's "
               "config and the report's HOST_DATA names the serving deployment. Read-only methods plus "
               'eth_sendRawTransaction; the enclave holds no keys and signs nothing. Zero publisher fee.')


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def measure(image, cmdline, vcpus):
    out = subprocess.run(['sev-snp-measure', '--mode', 'snp', '--vcpus', str(vcpus), '--vcpu-type', 'EPYC-v4',
                          '--ovmf', str(OVMF), '--kernel', str(image/'vmlinuz'), '--initrd', str(image/'initrd.img'),
                          '--append', cmdline], check=True, capture_output=True, text=True).stdout.split()[-1]
    assert len(out) == 96 and all(c in '0123456789abcdef' for c in out), out
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image'), ap.add_argument('out')
    for k in ('version', 'media', 'runner', 'enclave-id', 'journal', 'commit'):
        ap.add_argument('--'+k, required=True)
    ap.add_argument('--vcpus', type=int, required=True)
    ap.add_argument('--mem-mib', type=int, required=True)
    a = ap.parse_args()
    image, out = Path(a.image), Path(a.out)
    out.mkdir(mode=0o755)
    meta = json.loads((image/'IMAGE.json').read_text())
    for name, row in meta['artifacts'].items():
        assert sha(image/name) == row['sha256'], 'image artifact differs from IMAGE.json: '+name
    m = measure(image, meta['cmdline'], a.vcpus)
    snp = {'measurements': {str(a.vcpus): m}, 'vcpuType': 'EPYC-v4', 'policy': '0x30000',
           'hostData': 'EnclaveDeployments id of the serving deployment',
           'reportData': 'sha256(served TLS SubjectPublicKeyInfo) then 32 zero bytes; for ?nonce=<64 hex>, '
                         'sha256(SubjectPublicKeyInfo then the 32 nonce bytes) then 32 zero bytes'}
    img = {'rootHash': meta['rootHash'], 'cmdline': meta['cmdline'], 'kernel': meta['kernel'],
           'ovmfSha256': sha(OVMF), 'artifacts': {n: r['sha256'] for n, r in meta['artifacts'].items()}}
    manifest = {'format': 'enclave-rpc-snp-release/1', 'app': {'id': APP_ID, 'slug': SLUG}, 'version': a.version,
                'source': {'repo': 'EnclaveHost/enclave', 'commit': a.commit}, 'snp': snp, 'image': img,
                'imageJson': meta, 'launch': {'vcpus': a.vcpus, 'memoryMiB': a.mem_mib, 'machine': 'q35',
                                              'cpu': 'EPYC-v4', 'cbitpos': 51, 'kernelHashes': True,
                                              'launcher': 'rpc/snp/launch.py'},
                'endpoints': {'attestation': '/.well-known/enclave-attestation', 'ethereum': '/l1', 'base': '/base',
                              'beacon': '/beacon/', 'web': '/'}}
    (out/'RELEASE-MANIFEST.json').write_text(json.dumps(manifest, indent=1, sort_keys=True)+'\n')
    media = json.loads(Path(a.media).read_text()).get('_media')
    config = {'schema': 'enclave-rpc-snp/1', 'runtime': 'sev-snp-vm', 'rpcReady': True, 'chains': {'ethereum': 1, 'base': 8453},
              'snp': snp, 'image': {'rootHash': img['rootHash'], 'ovmfSha256': img['ovmfSha256'],
                                    'cmdlineSha256': hashlib.sha256(meta['cmdline'].encode()).hexdigest()},
              'source': manifest['source'], 'endpoints': manifest['endpoints'], '_media': media}
    assert len(json.dumps(config, separators=(',', ':'))) <= 4096
    release = {'owner': OWNER, 'appId': APP_ID, 'slug': SLUG, 'name': NAME, 'description': DESCRIPTION,
               'version': a.version, 'cid': None, 'res': [0, 0, a.mem_mib, 0], 'ports': 'tcp:8443', 'config': config,
               'runner': a.runner, 'runnerFundWei': str(10**15), 'enclaveId': a.enclave_id, 'appPort': 8443,
               'journal': a.journal}
    (out/'release.json').write_text(json.dumps(release, indent=1)+'\n')
    print(json.dumps({'measurement': m, 'manifestSha256': sha(out/'RELEASE-MANIFEST.json')}))


if __name__ == '__main__':
    main()
