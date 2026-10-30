#!/usr/bin/env python3
"""Startup resource floor only. Does not certify chain readiness or change config."""
from pathlib import Path
import json
MEMORY_FLOOR_KIB = 16 * 1024 * 1024
RUNTIME_LIMIT_KIB = 1536 * 1024
values = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
available = values['MemAvailable']
print(json.dumps({'hostAvailableKiB': available, 'requiredKiB': MEMORY_FLOOR_KIB + RUNTIME_LIMIT_KIB}))
if available < MEMORY_FLOOR_KIB + RUNTIME_LIMIT_KIB:
    raise SystemExit('refusing verifier startup: preserve 16 GiB host floor plus the runtime allocation')
