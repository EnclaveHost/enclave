from pathlib import Path
import hashlib,json,subprocess,time,sys
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
S=P/'finality-stage/a1-original-game'
rc=P/'logs/root-a1-recheck-repaired-2139.rc'
end=time.monotonic()+1800
while not rc.exists():
    if time.monotonic()>end: raise SystemExit('A1 offline tests still pending; no live start')
    time.sleep(15)
if rc.read_text().strip()!='0': raise SystemExit('A1 offline test failed; no live start')
s=json.loads((S/'logs/mutants/summary.json').read_text())
assert s['killed']==s['total']==10 and s['notGenuinelyKilled']==0,s
assert hashlib.sha256((S/'a1-recheck.mjs').read_bytes()).hexdigest()=='f591f3247fe672f6470685f2be36eb529ceb9280044c03c6a2396174bb0ad9d8'
out='/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/l1-a1-recheck-after-2140'
r=subprocess.run(['bash',str(P/'jobs/q.sh'),'root-a1-live-after-2140','256','python3','-I',str(S/'run-recheck.py'),out],cwd=P)
actual=P/'logs/root-a1-live-after-2140.rc'
result={'wrapperExit':r.returncode,'queueExit':int(actual.read_text()) if actual.exists() else None,'output':out}
(P/'logs/root-a1-live-after-2140-result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result));sys.exit(0 if result['queueExit']==0 else 1)
