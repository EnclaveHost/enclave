#!/usr/bin/env python3
"""insert_lock_entry.py <Cargo.lock>: insert EXACTLY ONE [[package]] entry for the path member base-bytecode-check into a
copy of the base 5476069f Cargo.lock, at cargo's sort position (name, version), with its direct dependencies written the
way cargo writes them (bare name when the lock has one version; "name version" otherwise). Refuses if the entry exists,
a dependency is missing, or the result is not the original plus exactly that block. cargo --locked is the final judge."""
import sys, tomllib
DEPS = ['alloy-primitives', 'reth-db', 'reth-db-api', 'reth-primitives-traits', 'revm-bytecode', 'serde_json']
NAME, VERSION = 'base-bytecode-check', '0.0.0'
p = sys.argv[1]; src = open(p).read(); lock = tomllib.loads(src)
pk = lock['package']
if any(x['name'] == NAME for x in pk): sys.exit(f'{NAME} already in the lock')
dep_lines = []
for d in sorted(DEPS):
    vs = [x for x in pk if x['name'] == d]
    if len(vs) != 1: sys.exit(f'{d}: {len(vs)} lock versions (expected exactly 1; qualified form not prepared)')
    dep_lines.append(f' "{d}",')
block = f'[[package]]\nname = "{NAME}"\nversion = "{VERSION}"\ndependencies = [\n' + '\n'.join(dep_lines) + '\n]\n\n'
parts = src.split('[[package]]\n')
head, entries = parts[0], parts[1:]
names = [tomllib.loads('[[package]]\n' + e)['package'][0]['name'] for e in entries]
if names != sorted(names, key=lambda n: n) and names != [x['name'] for x in pk]: sys.exit('unexpected lock layout')
i = next(k for k, n in enumerate(names) if n > NAME)
out = head + ''.join('[[package]]\n' + e for e in entries[:i]) + block + ''.join('[[package]]\n' + e for e in entries[i:])
new = tomllib.loads(out)['package']
if len(new) != len(pk) + 1 or [x for x in new if x['name'] != NAME] != pk: sys.exit('result is not the original plus one entry')
if out.replace(block, '', 1) != src: sys.exit('textual diff is not exactly the inserted block')
open(p, 'w').write(out); print(f'inserted {NAME} before {names[i]} ({len(DEPS)} deps)')
