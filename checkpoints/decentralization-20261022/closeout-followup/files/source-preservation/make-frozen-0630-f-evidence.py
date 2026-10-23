"""Digest of F's terminal host-service-lifecycle job logs (6c38c048): per job the sha256/size of the full .out, its exit code,
the queue guard line and only the queue/summary/failure/skip/scan/mutant lines. The raw logs stay local (not preserved)."""
from pathlib import Path
import hashlib, re
d = Path(__file__).resolve().parents[1] / 'host-service-lifecycle/logs'
keep = re.compile(r'^\s*(\[queue\]|\[memory-guard\]|ℹ (tests|pass|fail|skipped|cancelled|todo)|✖ |# (pass|fail|skip|tests)|.*KILLED|.*SURVIVED|.*killed|.*no leaks|.*scan-crypto-keys|.*\[job\]|.*\[t\d|.*exit=)')
out = ['# F host-service-lifecycle (6c38c048) terminal job log digest; generated from host-service-lifecycle/logs; full logs stay local.']
for job in sorted({p.name.split('.')[0] for p in d.iterdir()}):
    o = d / f'{job}.out'; g = d / f'{job}.guard.log'; rc = d / f'{job}.rc'
    data = o.read_bytes() if o.exists() else b''
    out.append(f"\n## {job}  out-sha256 {hashlib.sha256(data).hexdigest()}  bytes {len(data)}  rc {rc.read_text().strip() if rc.exists() else 'absent'}")
    if g.exists(): out += ['    ' + l for l in g.read_text().splitlines()]
    out += ['    ' + l.rstrip()[:240] for l in data.decode('utf-8', 'replace').splitlines() if keep.match(l)][:80]
Path(__file__).with_name('frozen-0630-f-test-evidence.txt').write_text('\n'.join(out) + '\n')
print(len(out))
