"""APPEND the frozen-0318 material to closeout-followup/MANIFEST.json without recapturing any existing (mutable) source.

Unlike capture-latest.py (which regenerates the whole manifest from live paths), this script:
* never re-reads an existing entry's source: it checks every existing entry's STORED file against its manifest sha256
  and that the manifest JSON round-trips byte-identically before anything is written;
* copies only the new paths below, each pinned by hash in frozen-0318-export/INVENTORY.json (or here), refusing any
  byte change since the export, any path already in the manifest and any overwrite of an existing stored file;
* appends the new entries (labelled) and an `appends` record; existing entries, unchangedAlreadyPreserved, status,
  exclusions and supersessions are left exactly as they are.
Writes only inside the checkpoint's closeout-followup/ (MANIFEST.json, README.md, new files/...).
"""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
repo = root / 'work/source-checkpoint-20261022/main-repo'
dest = repo / 'checkpoints/decentralization-20261022/closeout-followup'
fx = sp / 'frozen-0318-export'
CK = '7b477d578973dd11ebada8cc448bc1b3913f3bd9'
pins = json.loads((sp / 'frozen-0318-pins.json').read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


assert git('rev-parse', 'HEAD').strip() == CK and not git('status', '--porcelain').strip(), 'checkpoint repo not clean at 7b477d57'
mpath = dest / 'MANIFEST.json'
raw = mpath.read_text()
m = json.loads(raw)
assert json.dumps(m, indent=2) + '\n' == raw, 'MANIFEST.json does not round-trip byte-identically'
tracked = set(git('ls-files', '--', 'checkpoints/decentralization-20261022/closeout-followup/files').splitlines())
bad, untracked = [], []
for e in m['entries']:
    p = dest / e['stored']
    if sha(p.read_bytes()) != e['sha256']:
        bad.append(e['stored'])
    if str(p.relative_to(repo)) not in tracked:
        untracked.append(e['stored'])
assert not bad and not untracked, ('existing stored entries', bad[:5], untracked[:5])
existing_sources = {e['source'] for e in m['entries']}

# ---- what to append -------------------------------------------------------------------------------------------------
for name, want in pins.items():
    assert sha((fx / name).read_bytes()) == want, f'NOT CAPTURED: frozen-0318-export/{name} changed'
inv = json.loads((fx / 'INVENTORY.json').read_text())
add = []   # (path, label)
for name in pins:
    add.append((fx / name, None))
for side in inv['sides'].values():
    for patch in side['patches']:
        p = fx / patch['file']
        assert sha(p.read_bytes()) == patch['sha256'], f'NOT CAPTURED: {patch["file"]} differs'
        add.append((p, None))
    folder = fx / Path(side['patches'][0]['file']).parts[0] / 'files'
    for f in side['changedFiles']:
        if f['status'] != 'D':
            p = folder / f['path']
            assert sha(p.read_bytes()) == f['sha256'], f'NOT CAPTURED: {p} differs from its commit blob'
            add.append((p, None))
for group in ('frozenSources', 'rootEvidence'):
    for name, want in inv[group].items():
        p = base / name
        assert sha(p.read_bytes()) == want, f'NOT CAPTURED: {name} changed after the frozen-0318 export'
        add.append((p, None))
for name, want in inv['receipts'].items():
    p = root / 'outputs/decentralization-audit' / name
    assert sha(p.read_bytes()) == want, f'NOT CAPTURED: receipt {name} changed after review'
    add.append((p, None))
for name in ('export-frozen-0318.py', 'verify-frozen-0318-export.py', 'capture-frozen-0318.py', 'frozen-0318-pins.json',
             'frozen-0318-export.sh', 'frozen-0318-capture.sh', 'frozen-0318-q.sh'):
    add.append((sp / name, None))

LABELS = {
    'source-preservation/frozen-0318-export/': 'FROZEN 03:18Z commits exported from Git objects (never worktrees); every commit tree '
                                               'rebuilt exactly from the prior pushed exports + these patches (REPRODUCE-CHECK.txt). '
                                               'SOURCE + OFFLINE TESTS ONLY: not merged into the normal tree, not imaged, not deployed',
    'source-preservation/frozen-0318-export/witness-enclave-bfbd649d/': 'witness-failover Enclave bfbd649d (2 patches on A\'s 9fdc1418c): '
        'gateway verifies each block-hash-pinned eth_getProof/eth_getCode answer with the native witness-check against a root '
        'from a signed head, fails over to the next untrusted source, content-addressed re-verified cache, bounded reads; '
        'offline proof/availability tests only (JS 30/30 + 1 skip, real recorded witnesses). NOT production, NOT RPC '
        'independence: with every fresh witness source down only cached block-pinned history remains',
    'source-preservation/frozen-0318-export/witness-helios-1ec2c1a5/': 'Helios fork 1ec2c1a5 on eeffcc9: exact witness-check proof-check '
        'source (Helios\'s own SequencerCommitment::verify / payload_to_block / proof verifiers + exact request binding); '
        'Rust 6/6 debug. No binary (helper 42a8a841 not stored), no cargo cache or vendor download. The worker\'s newer '
        'UNCOMMITTED edits are not captured',
    'source-preservation/frozen-0318-export/d-linux-wallet-review-b744ba19/': 'UNREADY CANDIDATE D b744ba19 (on 09ff3ed5): lease-permit '
        'epoch, failed-stop slice retention, stream/egress cut. Root LATER found a permit-capture window (tryClaim builds its '
        'send gate after awaiting openForUs, so a withdrawal during that await is absorbed: ROOT-LINUX-DECISION-WINDOW-REVIEW) '
        'and other teardown paths still free the slice on an unconfirmed stop; worker D is repairing. Not imaged, not deployed',
    'witness-failover/': 'witness-failover worker report files at their stable bytes (hash-frozen at export): describe exactly '
                         'bfbd649d / 1ec2c1a5; source + offline tests only, NOT production or RPC independence',
    'linux-wallet-unknown/RESULT-REVIEW.md': 'D\'s report for b744ba19 at its stable bytes. SUPERSEDED IN PART: root later found the '
                                             'tryClaim permit-capture window; UNREADY candidate, no image or deployment',
    'ROOT-LINUX-DECISION-WINDOW-REVIEW.txt': 'ROOT source review (02:51Z) of D working source db73a7f2: permit captured after an await '
                                             'in tryClaim; review only, the fix is pending in D',
    'root-linux-decision-window': 'ROOT offline probe (queue 256): the ACTUAL gate functions in vm with a synthetic allow->await->'
                                  'withdrawal->gate ordering; gate built after withdrawal returns null (accepts). Not a full '
                                  'tryClaim run, not a production transaction',
    'ROOT-VERIFIER-DEADLINE-REVIEW.txt': 'ROOT review (02:34Z) of worker A source 921d60c2: LeaseReader.agreed deadline does not '
                                         'bound a never-settling callback; no production outage claimed',
    'root-verifier-deadline': 'ROOT offline probe (queue 256, unshare -rn): actual LeaseReader.agreed with a 100 ms deadline still '
                              'pending at 401 ms. A\'s probed source (3d1850b2) is ACTIVE and not captured here',
    'ROOT-VERIFIER-POSITIVE-CONSUMER-REVIEW.txt': 'HISTORICAL ROOT review (02:50Z): proof-refusal tests are not positive consumer '
                                                  'evidence. Worker A has since moved to Reth positives; NOT final, nothing verified',
    'node-updater-readonly/check-0313.py': 'ROOT source: read-only check of the 03:13Z scheduled updater run (one status query); '
                                           'writes the windows-node-updater-0313-postcheck receipt',
    'check-dns-tls-current.py': 'ROOT source: public HTTPS/TLS check of the current DNS addresses; writes the enclavedns-tls-'
                                'followup receipt',
    'dns-tls-0317.guard.log': 'queue guard line for root\'s 03:17Z DNS/TLS check (exit 0)',
    'storage-worker-steering-interrupt.json': 'ROOT note: SIGINT of the storage worker CLI to deliver scheduling steering; no '
                                              'production operation',
    'ROOT-BRIDGE-HALFCLOSE-REVIEW.txt': 'ROOT real-socket review (02:38Z) of S bridge runner 160db08b: _room() evicts an actively '
                                        'transferring half-closed connection. REVIEW ONLY; S is active with fixes, no final claim. '
                                        'Byte-identical copy also at work/storage-restore-memory/',
    'root-bridge-halfclose/': 'ROOT offline probe (queue 256, unshare -rn) + its snapshot of S runner 160db08b (the reviewed '
                              'DEFECTIVE version, never a release): healthy half-closed transfer terminated, halfClosedEvicted=1',
    'outputs/decentralization-audit/windows-node-updater-0313-postcheck': 'ROOT receipt: the 03:13:37Z scheduled updater run kept the '
        'reviewed runtime (host ea0f6b8a, chain 3e9fae03), 9 apps running; native observation only, future updates unproven',
    'outputs/decentralization-audit/enclavedns-tls-followup-20261023T0317Z': 'ROOT receipt: REAL live observation 03:17Z: both current '
        'DNS addresses served HTTPS 200 with a trusted ZeroSSL cert expiring 2027-01-20. Future renewal and provider '
        'independence UNPROVEN',
    'outputs/decentralization-audit/storage-failed-attempt-cleanup': 'ROOT receipt: failed whole-recovery attempt staging removed; '
        'counts only, not a verified inventory. The OOM FAILURE remains the LATEST full-restore status (NOT passed)',
    'outputs/decentralization-audit/rpc-hdd-feasibility-primary-source': 'ROOT receipt: primary-source Base node requirements + '
        'read-only USB RAID observation; HDD-only suitability UNSUPPORTED and unbenchmarked; no NVMe hosting, sync, format '
        'or purchase',
    'source-preservation/': 'frozen-0318 checkpoint tooling (Git-object export, offline tree verifier, append-only capture)',
}

entries, total = [], 0
seen = set()
for p, _ in add:
    assert p not in seen, p
    seen.add(p)
    assert p.is_file() and not p.is_symlink(), p
    data = p.read_bytes()
    assert len(data) < 5_000_000, p
    data.decode('utf-8')
    rel = p.relative_to(base) if p.is_relative_to(base) else Path('outputs') / p.relative_to(root / 'outputs')
    source = str(p.relative_to(root))
    assert source not in existing_sources, f'already in the manifest (not recaptured): {source}'
    out = dest / 'files' / rel
    assert not out.exists(), f'refusing to overwrite an existing stored file: {out}'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    out.chmod(0o644 | (p.stat().st_mode & 0o111))
    label = max(((k, v) for k, v in LABELS.items() if str(rel).startswith(k)), key=lambda kv: len(kv[0]), default=(None, None))[1]
    entries.append({**({'label': label} if label else {}), 'source': source, 'stored': str(out.relative_to(dest)),
                    'sha256': sha(data), 'bytes': len(data)})
    total += len(data)
unlabelled = [e['source'] for e in entries if 'label' not in e]
assert not unlabelled, unlabelled
before = len(m['entries'])
m['entries'].extend(entries)
m.setdefault('appends', []).append({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'by': 'source-preservation/capture-frozen-0318.py',
    'onCheckpoint': CK, 'entriesBefore': before, 'added': len(entries), 'bytes': total,
    'note': 'append-only: existing entries were verified against their stored bytes and not recaptured from their (mutable) '
            'sources; capturedAt above is the last full capture-latest.py run'})
mpath.write_text(json.dumps(m, indent=2) + '\n')
readme = dest / 'README.md'
text = readme.read_text()
marker = 'Latest whole-bucket Sia recovery status (2026-10-23)'
assert marker in text
line = ('\nFrozen 03:18Z append (2026-10-23): witness failover Enclave bfbd649d + Helios witness-check 1ec2c1a5 (source and offline '
        'proof/availability tests only; not production, not RPC independence) and the UNREADY Linux hold candidate b744ba19 '
        '(root later found a tryClaim permit-capture window; worker repairing), with root reviews/probes and receipts. '
        'See `MANIFEST.json` `appends`. The whole-bucket OOM failure above remains the latest full-restore status.\n')
i = text.index('\n', text.index(marker))
readme.write_text(text[:i + 1] + line + text[i + 1:])
print(json.dumps({'before': before, 'added': len(entries), 'after': len(m['entries']), 'bytes': total}))
