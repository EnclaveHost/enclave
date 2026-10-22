# ROOT EXECUTES (prepared by Claude 2026-10-21; derived from linux-corrected-release/activation/stage.py).
# Copies the post-adoption release dir and image into /home/steven/enclave-prod under NEW names (never over 51516b778's
# or c083's, which stay as evidence), each copy compared file by file with its source; reuses the staged lease-gas record
# only if byte-equal. No active config, drop-in or service is changed. Writes plan.json beside this script.
from pathlib import Path
import hashlib, json, shutil, os, datetime
W = Path('/home/steven/Documents/Codex/2026-10-18/wo/work'); S = W/'linux-post-adoption-release/stage'; P = Path('/home/steven/enclave-prod'); A = Path(__file__).resolve().parent
os.umask(0o077)
INV = json.loads((W/'linux-post-adoption-release/ARTIFACT-INVENTORY.json').read_text())
SHORT, MEASUREMENT = INV['commit'][:9], INV['image']['measurement']
items = [f'metal-{SHORT}', f'dist-leasegas-{SHORT}']
def inv(root):
    out = {}
    for f in sorted(root.rglob('*')):
        if f.is_symlink(): out[str(f.relative_to(root))] = {'link': os.readlink(f)}
        elif f.is_file(): out[str(f.relative_to(root))] = {'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'mode': f.stat().st_mode & 0o777}
    return out
assert not (A/'plan.json').exists(), 'already staged; inspect rather than redo'
assert not (S/items[0]/'node_modules').exists() and not any(p.is_symlink() for p in (S/items[0]).rglob('node_modules'))
assert (S/items[1]/'MEASUREMENT').read_text().strip() == MEASUREMENT
assert hashlib.sha256((S/items[1]/'initramfs.cpio.gz').read_bytes()).hexdigest() == INV['image']['files']['initramfs.cpio.gz']
for old in ['metal-c083e27a8', 'dist-leasegas-c083e27a8', 'metal-51516b778', 'dist-leasegas-51516b778']:
    assert (P/old).exists(), 'preserve the earlier activations\' evidence: it must still be present'
for name in items:
    source = S/name; dest = P/name; tmp = dest.with_name(dest.name + '.staging')
    assert not dest.exists(), 'already staged; inspect rather than overwrite'
    assert not tmp.exists()
    shutil.copytree(source, tmp, symlinks=True)
    assert inv(source) == inv(tmp)
    os.rename(tmp, dest)
record = P/'lease-gas'/'deployment.json'
assert hashlib.sha256(record.read_bytes()).hexdigest() == '1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089', 'the staged lease-gas record changed'
plan = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': 'post-adoption production files staged, no active config or service changed',
  'release': str(P/items[0]), 'image': str(P/items[1]), 'measurement': MEASUREMENT, 'commit': INV['commit'],
  'supersedes': {'release': str(P/'metal-51516b778'), 'image': str(P/'dist-leasegas-51516b778'),
                 'measurement': '9fcbd925ada7a67a7b175e933f83f10681be06d86fc4b6ad46000809f9e82628e28fee5a50e1a591e23082b25f0ca0b4'},
  'leaseGas': {'recordFile': str(record), 'digest': 'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089',
               'rpcs': ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io'],
               'relays': ['https://134.199.235.187', 'https://134.209.248.172'], 'quorum': 2},
  'apps': {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': 'https://da09d0f2.app.enclave.host/',
           '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c': 'https://9eb4e600.app.enclave.host/ping'},
  'sourceInventory': {name: inv(S/name) for name in items}}
(A/'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
print(json.dumps({k: v for k, v in plan.items() if k != 'sourceInventory'}, indent=2))
