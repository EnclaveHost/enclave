#!/usr/bin/env python3
"""holder/BINARY.json: the reviewed official binary (from tools/stage_release.py's staged.json) and its actual
offline help evidence (jobs/binary-help.sh). Usage: record_binary.py STAGED_JSON HELP_DIR > holder/BINARY.json"""
import hashlib, json, sys
from pathlib import Path
st = json.load(open(sys.argv[1])); hd = Path(sys.argv[2])
help_txt = (hd / 'rpc-help.txt').read_text()
flags = json.load(open(Path(__file__).resolve().parent.parent / 'holder' / 'FLAGS.json'))['flags']
out = {'format': 'enclave-base-holder-binary/v1', 'release': st['release'],
       'tarball': st['assets']['base-v1.5.1-x86_64-unknown-linux-gnu.tar.gz'],
       'binary': {'member': st['binary']['member'], 'size': st['binary']['size'], 'sha256': st['binary']['sha256']},
       'version': (hd / 'version.txt').read_text().strip(),
       'help': {n: hashlib.sha256((hd / f'{n}.txt').read_bytes()).hexdigest() for n in ('help', 'rpc-help')},
       'flagsInRpcHelp': sorted(f for f in flags if f != '--chain' and f'      {f}' in help_txt),
       'executedOffline': True,
       'note': 'every rendered flag must appear in the pinned binary help; preflight re-checks on the installed bytes'}
print(json.dumps(out, indent=1, sort_keys=True))
