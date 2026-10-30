#!/usr/bin/env python3
"""Print the [prune] and [static_files] sections of a reth.toml (parsed and raw), for evidence logs."""
import sys, tomllib
raw = open(sys.argv[1], 'rb').read()
doc = tomllib.loads(raw.decode())
print('   parsed prune:', doc.get('prune'), '| static_files:', doc.get('static_files'))
keep, out = False, []
for line in raw.decode().splitlines():
    if line.startswith('['):
        keep = line.startswith('[prune') or line.startswith('[static_files')
    if keep and line.strip():
        out.append('   | ' + line)
print('\n'.join(out))
