"""Mutation check: each mutant is a deliberate regression in a temporary copy of l1pair.py. The unit suite
(test_l1pair.py, run against the mutant via L1PAIR_UNDER_TEST) must FAIL for every mutant. Prints KILLED/SURVIVED."""
import os, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
SRC = (HERE.parent / 'l1pair.py').read_text()
MUTANTS = {
    'nat-any': ("'--nat', p['nat'],", "'--nat', 'any',"),
    'public-http': ("'--http', '--http.addr', '127.0.0.1'", "'--http', '--http.addr', '0.0.0.0'"),
    'public-engine': ("'--authrpc.addr', '127.0.0.1'", "'--authrpc.addr', '0.0.0.0'"),
    'minimal-prune': ("'--full', '--prune.receipts.distance', str(e['receiptsRetentionBlocks']),", "'--minimal',"),
    'receipts-floor': ("e['receiptsRetentionBlocks'], MIN_RECEIPTS, 10_000_000)", "e['receiptsRetentionBlocks'], 10_064, 10_000_000)"),
    'custody-any': ("if k['custody'] not in ('semi-supernode', 'supernode'):", "if False:"),
    'upnp-on': ("'--disable-upnp', ", ""),
    'tx-gossip-on': ("'--disable-tx-gossip', ", ""),
    'broadcast-default-on': ("tb = e.get('txBroadcast', 'disabled')", "tb = e.get('txBroadcast', 'local-raw-propagate')"),
    'local-propagation-on': (", '--txpool.no-local-transactions-propagation']", "]"),
    'overlap-ignored': ("            if _overlap(mine, other):", "            if False:"),
    'holder-reservation-reuse': ("if out['cache']['mechanism'] != 'none' and out['nvmeBudget']['reservationId'] == 'base-holder-dm-cache':", "if False:"),
    'budget-constants-dropped': ("'LEDGER': (s.get('nvmeBudget') or {}).get('ledgerPath', '')", "'LEDGER': ''"),
    'genesis-allowed': ("    if mode == 'genesis':", "    if False:"),
    'one-provenance': ("len(prov) < 2", "len(prov) < 1"),
    'stale-checkpoint': ("if age > 14 * 86400:", "if age > 10 ** 12:"),
    'inherit-env': ("return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': d,", "return {**os.environ, 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': d,"),
    'jwt-mode': ("if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o037:", "if not stat.S_ISREG(st.st_mode):"),
    'gate-chainid-only': ("return {'ready': all(x['ok'] for x in checks), 'checks': checks}", "return {'ready': checks[0]['ok'], 'checks': checks}"),
    'gate-no-custody': ("n >= MAIN['numberOfCustodyGroups'] // 2", "n >= 0"),
    'url-default': ("    if ck['mode'] == 'file':\n        a += ['--checkpoint-state'", "    a += ['--checkpoint-sync-url', 'https://checkpoint.example/']\n    if ck['mode'] == 'file':\n        a += ['--checkpoint-state'"),
    'mount-tmp': ("    for r in ('/tmp', '/var/tmp', '/dev', '/run', '/proc', '/sys', '/vm'):", "    for r in ():"),
}
killed = 0
for name, (a, b) in MUTANTS.items():
    if SRC.count(a) != 1:
        print(f'BROKEN {name}: anchor found {SRC.count(a)} times'); sys.exit(2)
    with tempfile.TemporaryDirectory() as d:
        m = Path(d) / 'l1pair.py'
        m.write_text(SRC.replace(a, b))
        os.symlink(HERE.parent / 'PINS.json', Path(d) / 'PINS.json'); os.symlink(HERE.parent / 'vendor', Path(d) / 'vendor')
        r = subprocess.run([sys.executable, '-I', str(HERE / 'test_l1pair.py')], env={'PATH': '/usr/bin:/bin', 'L1PAIR_UNDER_TEST': str(m)},
                           capture_output=True, text=True, timeout=300)
        ok = r.returncode != 0
        killed += ok
        first = next((l for l in r.stderr.splitlines() if l.startswith(('FAIL:', 'ERROR:'))), '')
        print(f"{'KILLED' if ok else 'SURVIVED'} {name}  {first[:110]}")
print(f'{killed}/{len(MUTANTS)} killed')
sys.exit(0 if killed == len(MUTANTS) else 1)
