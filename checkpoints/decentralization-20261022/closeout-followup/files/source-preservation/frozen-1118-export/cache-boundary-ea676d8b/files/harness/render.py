#!/usr/bin/env python3
"""Render the EXACT production storage scripts for the guest test, plus the fixture ledger.

Renderers (unmodified, byte-pinned):
  * S's holder.storage_script() from fresh-witness-supply 959e56fd (vendor/holder/holder.py c73a4351)
  * P's l1pair.storage_script() from rpc-l1-source-package f8351487 (vendor/l1pair/l1pair.py a25bd4ea)
Both fill S's holder-storage.sh.in (eb6a209d) by replacing @CONSTANTS@ only.

SCALE/PATH SEAM (the only difference from a production config, listed in seam.json): the configs are built directly
(the validators' production minima - origin >= 1.5 TB, cache data >= 1 GiB - are NOT changed and NOT run) with
  * sizes: origin 160 MiB / 32 MiB, cache data 64 MiB / 8 MiB, metadata 16 MiB / 8 MiB, free margins 0
  * paths: /usbtest (guest ext4 on a rotational test disk) instead of /mnt/usb (NTFS), /vmtest (guest ext4 on dm-crypt
    on a non-rotational test disk) instead of /vm, budget tool at /src/vendor/holder/budget.py
Everything else (commands, ordering, checks, mapping table, names, ledger rules) is production code.
The ledger is a FIXTURE written only inside the throwaway guest at the canonical path."""
import hashlib, importlib.util, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = Path(sys.argv[1])
MiB = 1 << 20
FIXTURE_MACHINE_ID = '0e0f0e0f0e0f0e0f0e0f0e0f0e0f0e0f'   # guest-only fixture (the host's id never enters the guest)
BUDGET_TOOL = '/src/vendor/holder/budget.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


H = load('holder', ROOT / 'vendor/holder/holder.py')
L = load('l1pair', ROOT / 'vendor/l1pair/l1pair.py')
B = H.BUDGET


def cfg(name, owner, mnt, origin_bytes, data, meta, rid, origin_dir, cache_dir):
    files = [{'path': f'{cache_dir}/cache-data.img', 'bytes': data}, {'path': f'{cache_dir}/cache-meta.img', 'bytes': meta}]
    slack = B.required_headroom({'blockBytes': 4096, 'files': files})      # EXACTLY the minimum: accounting at its limit
    return {'serviceUser': owner, 'datadir': f'{mnt}/data',
            'storage': {'layout': 'loop-ext4-image', 'mountPoint': mnt,
                        'origin': {'imagePath': f'{origin_dir}/origin.img', 'bytes': origin_bytes},
                        'cache': {'mechanism': 'dm-cache', 'mode': 'writethrough', 'policy': 'smq',
                                  'dataImagePath': files[0]['path'], 'dataBytes': data,
                                  'metadataImagePath': files[1]['path'], 'metadataBytes': meta,
                                  'blockBytes': 262144, 'slackBytes': slack},
                        'nvmeBudget': {'ledgerPath': B.CANONICAL_PATH, 'reservationId': rid},
                        'originFreeMarginBytes': 0, 'nvmeFreeMarginBytes': 0}}


holder = cfg('enclave-base-holder', 'enclave-holder', '/srv/enclave-base-holder', 160 * MiB, 64 * MiB, 16 * MiB,
             'base-holder-dm-cache', '/usbtest/enclave-base-holder', '/vmtest/enclave-base-holder-cache')
pair = cfg('enclave-l1-pair', 'enclave-l1', '/srv/enclave-l1-pair', 32 * MiB, 8 * MiB, 8 * MiB,
           'l1-pair-dm-cache', '/usbtest/enclave-l1-pair', '/vmtest/enclave-l1-pair-cache')
reservations = []
for c, owner in ((holder, 'enclave-base-holder'), (pair, 'enclave-l1-pair')):
    k = c['storage']['cache']
    reservations.append({'id': c['storage']['nvmeBudget']['reservationId'], 'host': FIXTURE_MACHINE_ID, 'owner': owner,
                         'kind': 'preallocated-files', 'blockBytes': 4096,
                         'maxBytes': k['dataBytes'] + k['metadataBytes'] + k['slackBytes'], 'slackBytes': k['slackBytes'],
                         'files': [{'path': k['dataImagePath'], 'bytes': k['dataBytes']},
                                   {'path': k['metadataImagePath'], 'bytes': k['metadataBytes']}]})
share = B.BOOKKEEPING_BYTES + sum(r['maxBytes'] for r in reservations)      # the host share EXACTLY full
ledger = {'format': B.FORMAT, 'capBytes': B.CAP, 'targetBytes': B.TARGET,
          'hosts': [{'machineId': FIXTURE_MACHINE_ID, 'label': 'guest-fixture', 'shareBytes': share}],
          'reservations': reservations}
B.validate(ledger)
over = json.loads(json.dumps(ledger))                                          # one more 4 KiB file: must be refused
extra = [{'path': '/vmtest/extra/one.img', 'bytes': 4096}]
over['reservations'].append({'id': 'one-more', 'host': FIXTURE_MACHINE_ID, 'owner': 'test', 'kind': 'preallocated-files',
                             'blockBytes': 4096, 'slackBytes': B.required_headroom({'blockBytes': 4096, 'files': extra}),
                             'maxBytes': 4096 + B.required_headroom({'blockBytes': 4096, 'files': extra}), 'files': extra})
try:
    B.validate(over)
    over_refused = None
except B.BudgetError as e:
    over_refused = str(e)
assert over_refused, 'the next reservation must be refused at a full share'

OUT.mkdir(parents=True, exist_ok=True)
files = {'holder-storage.sh': H.storage_script(holder, budget_tool=BUDGET_TOOL),
         'pair-storage.sh': L.storage_script(pair, budget_tool=BUDGET_TOOL),
         'ledger.json': json.dumps(ledger, indent=1) + '\n',
         'ledger-over.json': json.dumps(over, indent=1) + '\n',
         'holder.json': json.dumps(holder, indent=1) + '\n', 'pair.json': json.dumps(pair, indent=1) + '\n'}
tpl = (ROOT / 'vendor/holder/holder-storage.sh.in').read_text()
head, tail = tpl.split('@CONSTANTS@')
fixed = (ROOT / 'fixes/holder-storage.sh.in').read_text()
fh, ft = fixed.split('@CONSTANTS@')
pc = files['pair-storage.sh'][len(head):len(files['pair-storage.sh']) - len(tail)]
files['pair-storage.fixed.sh'] = fh + pc + ft                     # SAME constants block; only the template fix differs
for n in ('holder-storage.sh', 'pair-storage.sh'):
    s = files[n]
    assert s.startswith(head) and s.endswith(tail), f'{n}: template body differs from eb6a209d'
for n, t in files.items():
    (OUT / n).write_text(t)
    (OUT / n).chmod(0o755 if n.endswith('.sh') else 0o644)
seam = {'renderers': {'holder.py': hashlib.sha256((ROOT / 'vendor/holder/holder.py').read_bytes()).hexdigest(),
                      'l1pair.py': hashlib.sha256((ROOT / 'vendor/l1pair/l1pair.py').read_bytes()).hexdigest(),
                      'template': hashlib.sha256(tpl.encode()).hexdigest(),
                      'budget.py': hashlib.sha256((ROOT / 'vendor/holder/budget.py').read_bytes()).hexdigest()},
        'templateBodyIdentical': True,
        'constants': {n: files[n][len(head):len(files[n]) - len(tail)] for n in ('holder-storage.sh', 'pair-storage.sh')},
        'productionValues': {'origin.bytes': '3,100,000,000,000 (S example; validator minimum 1.5e12)', 'cache.dataBytes': '197,999,984,640 (S example; minimum 1 GiB)',
                             'cache.metadataBytes': '1,073,741,824', 'freeMargins': '500e9 / 200e9', 'originDir': '/mnt/usb (NTFS)', 'cacheDir': '/vm (ext4 on dm-crypt)'},
        'ledger': {'shareBytes': share, 'bookkeeping': B.BOOKKEEPING_BYTES, 'reservations': {r['id']: r['maxBytes'] for r in reservations},
                   'slack': {r['id']: r['slackBytes'] for r in reservations}, 'nextReservationRefused': over_refused},
        'fixedTemplate': hashlib.sha256(fixed.encode()).hexdigest(),
        'files': {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items()}}
(OUT / 'seam.json').write_text(json.dumps(seam, indent=1) + '\n')
print(json.dumps({'rendered': sorted(files), 'share': share, 'nextReservationRefused': over_refused[:140]}, indent=1))
