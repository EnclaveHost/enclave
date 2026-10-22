#!/usr/bin/env python3
"""make-manifest.py -- LOCAL. stage/fixture-manifest.json: sha256 of every other stage file (Fixture.exe re-checks each on the host)."""
import hashlib, json, pathlib
S = pathlib.Path(__file__).resolve().parent.parent / 'stage'
files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(S.iterdir()) if p.is_file() and p.name != 'fixture-manifest.json'}
(S / 'fixture-manifest.json').write_text(json.dumps({'format': 'config-native-fixture-manifest/v1', 'files': files}, indent=1) + '\n'); print(len(files), 'files')
