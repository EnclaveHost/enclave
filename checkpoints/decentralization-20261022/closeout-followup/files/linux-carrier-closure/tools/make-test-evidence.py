"""TEST-EVIDENCE.txt: per queued job the sha256/size of its full log, its exit code, the queue guard line and only the
queue/group/summary/failure/skip/scan lines. The raw logs stay local (rawlogs/)."""
from pathlib import Path
import hashlib, re
B = Path(__file__).resolve().parents[1]; d = B / 'rawlogs'
keep = re.compile(r'^\s*(\[queue\]|\[memory-guard\]|\[ok\]|\[FAIL\]|\[t[1234]\]|\[scan\]|\[forge\]|=== |== |--- scripts|Error: |✖ |﹣ |ℹ (tests|pass|fail|skipped|cancelled)|.*no leaks found|T[1234]-DONE|C0-OK|B2-DONE|\[before\]|\[after\])')
out = ['# linux-carrier-closure test evidence digest, generated from rawlogs/ (full logs stay local).',
       '# Per job: sha256 and size of the full .out, exit code, guard line, then only queue/group/summary/failure/skip/scan lines.']
for job in ['c0-repo', 't1-tests', 't2-compose', 't3-final', 't4-head']:
    o = d / f'{job}.out'; data = o.read_bytes()
    out.append(f"\n## {job}  out-sha256 {hashlib.sha256(data).hexdigest()}  bytes {len(data)}  rc {(d / f'{job}.rc').read_text().strip()}")
    out += ['    ' + l for l in (d / f'{job}.guard.log').read_text().splitlines()]
    seen = set()
    for l in data.decode('utf-8', 'replace').splitlines():
        if keep.match(l):
            t = '    ' + l.rstrip()[:240]
            if l.startswith('✖ ') and t in seen: continue      # node:test repeats failing names in its summary
            seen.add(t); out.append(t)
(B / 'TEST-EVIDENCE.txt').write_text('\n'.join(out) + '\n'); print(len(out))
