#!/usr/bin/env python3
"""Render the EXACT composed storage scripts for the guest delta test, plus labelled controls and the fixture ledger.

Renderers (unmodified, read from the composed repos with git show into vendor/):
  * S holder.storage_script()  (rpc-storage-final-compose/s 92b7178)  -> holder-storage.sh, probe-storage.sh
  * P l1pair.storage_script()  (rpc-storage-final-compose/p f8c999e)  -> pair-storage.sh
Both fill the composed template cab32bbe (asserted), replacing @CONSTANTS@ only.
Controls (labelled, NOT production): old-holder-storage.sh = the PRE-fix S template eb6a209d with the IDENTICAL constants
block; mutant-credit-symlink.sh = the composed pair render with the `[ ! -L "$1" ]` credit guard removed (S mutant
sh:credit-symlink).
SCALE/PATH SEAM, as in cache-native-boundary: sizes (origin 160/32/16 MiB, cache data 64/8/4 MiB, metadata 16/8/8 MiB),
free margins 0 (the guest substitutes ONLY the NVME_FREE_MARGIN constant line at run time for the credit cases), guest
paths /usbtest (rotational ext4), /vmtest (ext4 on dm-crypt, non-rotational), /vmtest2 (a second non-rotational ext4,
for the other-filesystem case), budget tool /src/vendor/s/budget.py, fixture ledger at the canonical path in the guest."""
import hashlib, importlib.util, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent; ROOT = HERE.parent; OUT = Path(sys.argv[1])
MiB = 1 << 20
MID = '0e0f0e0f0e0f0e0f0e0f0e0f0e0f0e0f'
TOOL = '/src/vendor/s/budget.py'
COMPOSED = 'cab32bbe9967d56e75366ee573ff0cf4173ba66080e6b5fc58bc8c857ca8f222'


def load(n, p):
    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


H = load('holder', ROOT / 'vendor/s/holder.py'); L = load('l1pair', ROOT / 'vendor/p/l1pair.py'); B = H.BUDGET
for t in (ROOT / 'vendor/s/holder-storage.sh.in', ROOT / 'vendor/p/vendor/holder/holder-storage.sh.in'):
    assert hashlib.sha256(t.read_bytes()).hexdigest() == COMPOSED, t


def cfg(owner, mnt, origin_dir, origin_bytes, cdir, mdir, data, meta, rid):
    files = [{'path': f'{cdir}/cache-data.img', 'bytes': data}, {'path': f'{mdir}/cache-meta.img', 'bytes': meta}]
    return {'serviceUser': owner, 'datadir': f'{mnt}/data',
            'storage': {'layout': 'loop-ext4-image', 'mountPoint': mnt, 'origin': {'imagePath': f'{origin_dir}/origin.img', 'bytes': origin_bytes},
                        'cache': {'mechanism': 'dm-cache', 'mode': 'writethrough', 'policy': 'smq', 'dataImagePath': files[0]['path'], 'dataBytes': data,
                                  'metadataImagePath': files[1]['path'], 'metadataBytes': meta, 'blockBytes': 262144,
                                  'slackBytes': B.required_headroom({'blockBytes': 4096, 'files': files})},
                        'nvmeBudget': {'ledgerPath': B.CANONICAL_PATH, 'reservationId': rid}, 'originFreeMarginBytes': 0, 'nvmeFreeMarginBytes': 0}}


holder = cfg('enclave-holder', '/srv/enclave-base-holder', '/usbtest/enclave-base-holder', 160 * MiB,
             '/vmtest/enclave-base-holder-cache', '/vmtest/enclave-base-holder-cache', 64 * MiB, 16 * MiB, 'base-holder-dm-cache')
pair = cfg('enclave-l1', '/srv/enclave-l1-pair', '/usbtest/enclave-l1-pair', 32 * MiB,
           '/vmtest/enclave-l1-pair-cache', '/vmtest/enclave-l1-pair-cache', 8 * MiB, 8 * MiB, 'l1-pair-dm-cache')
probe = cfg('enclave-holder', '/srv/enclave-probe', '/usbtest/probe', 16 * MiB,
            '/vmtest/probe-cache', '/vmtest2/probe-meta', 4 * MiB, 8 * MiB, 'probe-dm-cache')   # CMETA on ANOTHER filesystem
res = []
for c, owner in ((holder, 'enclave-base-holder'), (pair, 'enclave-l1-pair'), (probe, 'credit-probe')):
    k = c['storage']['cache']
    res.append({'id': c['storage']['nvmeBudget']['reservationId'], 'host': MID, 'owner': owner, 'kind': 'preallocated-files', 'blockBytes': 4096,
                'maxBytes': k['dataBytes'] + k['metadataBytes'] + k['slackBytes'], 'slackBytes': k['slackBytes'],
                'files': [{'path': k['dataImagePath'], 'bytes': k['dataBytes']}, {'path': k['metadataImagePath'], 'bytes': k['metadataBytes']}]})
ledger = {'format': B.FORMAT, 'capBytes': B.CAP, 'targetBytes': B.TARGET,
          'hosts': [{'machineId': MID, 'label': 'guest-fixture', 'shareBytes': B.BOOKKEEPING_BYTES + sum(r['maxBytes'] for r in res)}], 'reservations': res}
B.validate(ledger)

files = {'holder-storage.sh': H.storage_script(holder, budget_tool=TOOL), 'pair-storage.sh': L.storage_script(pair, budget_tool=TOOL),
         'probe-storage.sh': H.storage_script(probe, budget_tool=TOOL)}
tpl = (ROOT / 'vendor/s/holder-storage.sh.in').read_text(); head, tail = tpl.split('@CONSTANTS@')
for n, s in files.items():
    assert s.startswith(head) and s.endswith(tail), n
old = (ROOT / 'vendor/s-old/holder-storage.sh.in').read_text(); oh, ot = old.split('@CONSTANTS@')
hc = files['holder-storage.sh'][len(head):len(files['holder-storage.sh']) - len(tail)]
files['old-holder-storage.sh'] = oh + hc + ot                                   # CONTROL: pre-fix template, same constants
guard = 'if [ -f "$1" ] && [ ! -L "$1" ] && '
assert files['pair-storage.sh'].count(guard) == 1
files['mutant-credit-symlink.sh'] = files['pair-storage.sh'].replace(guard, 'if [ -f "$1" ] && ')   # CONTROL: S mutant
for name, c in (('holder', holder), ('pair', pair), ('probe', probe)):
    files[f'{name}.json'] = json.dumps(c, indent=1) + '\n'
files['ledger.json'] = json.dumps(ledger, indent=1) + '\n'
OUT.mkdir(parents=True, exist_ok=True)
for n, t in files.items():
    (OUT / n).write_text(t); (OUT / n).chmod(0o755 if n.endswith('.sh') else 0o644)
seam = {'composedTemplate': COMPOSED, 'oldTemplate': hashlib.sha256(old.encode()).hexdigest(),
        'renderers': {'s/holder.py': hashlib.sha256((ROOT / 'vendor/s/holder.py').read_bytes()).hexdigest(),
                      'p/l1pair.py': hashlib.sha256((ROOT / 'vendor/p/l1pair.py').read_bytes()).hexdigest(),
                      'budget.py': hashlib.sha256((ROOT / 'vendor/s/budget.py').read_bytes()).hexdigest()},
        'files': {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items()},
        'ledgerShare': ledger['hosts'][0]['shareBytes'], 'reservations': {r['id']: r['maxBytes'] for r in res}}
(OUT / 'seam.json').write_text(json.dumps(seam, indent=1) + '\n')
print(json.dumps(seam, indent=1))
