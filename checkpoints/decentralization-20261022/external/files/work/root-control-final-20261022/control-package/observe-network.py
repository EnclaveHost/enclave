"""Bounded orchestration only. Each read-only network probe runs in the shared memory queue."""
from pathlib import Path
import subprocess,json,time,datetime
P=Path(__file__).resolve().parent; ROOT=P.parents[2]
expected=set(json.loads((P/'helper/runs/preflight-20261022T022125Z.json').read_text())['coverage']['expectedIds'])
out=P/'observation';out.mkdir(exist_ok=True)
with (out/'attempt.json').open('x') as f:json.dump({'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'samples':16,'intervalSeconds':120,'scope':'sampled network health, not continuous availability or provider independence'},f)
rows=[];start=time.monotonic();next_due=start
for i in range(16):
 while time.monotonic()<next_due:time.sleep(min(30,next_due-time.monotonic()))
 target=out/f'sample-{i:02}.json';attempt=0
 while True:
  guard=out/f'sample-{i:02}-attempt-{attempt}.guard.log'
  cmd=['python3',str(ROOT/'work/claude-test-queue.py'),'--mib','256','--log',str(guard),'--','python3',str(P/'root-network-status.py'),str(target)]
  r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)
  (out/f'sample-{i:02}-attempt-{attempt}.out').write_text(r.stdout+r.stderr)
  if r.returncode!=98:break
  attempt+=1
  if attempt>=8:break
  time.sleep(15)
 if r.returncode!=0:raise SystemExit(f'Observation not complete: probe {i} exit {r.returncode}')
 j=json.loads(target.read_text());s=j['result'];apps={a['id']:a for a in s.get('apps',[])}
 checks={'fresh':0<=s.get('ageMs',-1)<5000,'egress':expected<=set(s.get('egressIds',[])),'ready':all(apps.get(x,{}).get('ready') is True for x in expected),'noErrors':all(apps.get(x,{}).get('errorPresent') is False for x in expected)}
 row={'at':j['checkedAt'],'sample':i,'checks':checks};rows.append(row)
 elapsed=time.monotonic()-start
 (out/'progress.json').write_text(json.dumps({'rows':rows,'elapsedSeconds':elapsed,'complete':i==15 and elapsed>=1800 and all(all(x['checks'].values()) for x in rows)},indent=2)+'\n')
 print(json.dumps(row),flush=True)
 if not all(checks.values()):raise SystemExit('Observation failed: root investigates, no automatic restart')
 next_due=time.monotonic()+120
print('OBSERVATION COMPLETE: 16 successful samples spanning at least 30 minutes',flush=True)
