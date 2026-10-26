#!/usr/bin/env python3
"""host_verdict.py OUT RC FLOOR_MIB -> HOST-VERDICT.json on stdout. PASS only with: runner rc 0, guest '## systemd-canary rc=0', the guest
verdict.json pass, >= 2 HOST /proc/meminfo samples (the physical host) all readable and >= FLOOR_MIB, and no floor breach record."""
import json, pathlib, sys

o, rc, floor = pathlib.Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
samples = []
hm = o / 'host-memavail.txt'
if hm.exists():
    for l in hm.read_text().splitlines():
        p = l.split()
        samples.append(int(p[1]) if len(p) == 2 and p[1].isdigit() else None)
gv = o / 'result/out/verdict.json'
guest = json.loads(gv.read_text()) if gv.exists() else None
gout = (o / 'guest.out').read_text(errors='replace') if (o / 'guest.out').exists() else ''
checks = {'runner rc 0': rc == 0,
          'guest script rc 0': '## systemd-canary rc=0' in gout.splitlines(),
          'guest verdict pass': bool(guest and guest.get('pass') is True),
          'host watchdog evidence (>= 2 readable samples)': len(samples) >= 2 and None not in samples,
          f'host MemAvailable >= {floor} MiB throughout': bool(samples) and None not in samples and min(samples) >= floor,
          'no host floor breach': not (o / 'floor.txt').exists()}
print(json.dumps({'run': o.name, 'pass': all(checks.values()), 'checks': checks, 'hostMinAvailMiB': min([s for s in samples if s is not None], default=None),
                  'hostSamples': len(samples), 'guestRequired': (guest or {}).get('required'), 'guestInformational': (guest or {}).get('informational')},
                 indent=1, sort_keys=True))
sys.exit(0 if all(checks.values()) else 1)                    # r3: the runner exits on this, never on the JSON print alone
