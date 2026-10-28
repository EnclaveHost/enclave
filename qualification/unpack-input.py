#!/usr/bin/env python3
"""Accept precisely the four pinned regular files; never general tar extraction."""
import hashlib, json, shutil, sys, tarfile
from pathlib import Path
pins=json.loads((Path(__file__).parent/'input-pins.json').read_text())['files']
target=Path(sys.argv[2]); seen=set()
with tarfile.open(sys.argv[1], 'r:') as archive:
    for item in archive:
        assert item.name in pins and item.name not in seen, 'unexpected/duplicate input'
        assert item.isfile() and item.size == pins[item.name]['bytes'], 'invalid input type/size'
        with archive.extractfile(item) as src, (target/item.name).open('xb') as dst:
            shutil.copyfileobj(src,dst,1024*1024)
        with (target/item.name).open('rb') as src:
            assert hashlib.file_digest(src,'sha256').hexdigest() == pins[item.name]['sha256']
        seen.add(item.name)
assert seen == pins.keys(), 'missing input'
