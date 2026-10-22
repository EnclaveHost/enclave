"""Root-reviewed rollout coordinator; queue reads, then execute the reviewed activation.
No signatures, funds transfers, private data output, or edits to the previous rollback.
"""
from pathlib import Path
import subprocess,json,time,hashlib,datetime,shutil
W=Path('/home/steven/Documents/Codex/2026-10-18/wo')
A=W/'work/linux-corrected-release/activation'
L=A.parent
assert not (A/'result.json').exists() and not (A/'preflight-used.json').exists()
plan=json.loads((A/'plan.json').read_text())
inventory=json.loads((L/'ARTIFACT-INVENTORY.json').read_text())
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert h(A/'activate.py')==inventory['scripts']['activation/activate.py']
ad=json.loads((A/'admission.json').read_text())
assert ad['stage']=='verified active; old control still connected'
assert ad['added']==plan['measurement']
for name,r in inventory['image']['files'].items():
    assert h(Path(plan['image'])/name)==r['sha256'],name
for name,want in inventory['input']['changedFiles'].items():
    assert h(Path(plan['release'])/name)==want,name
for attempt in range(1,13):
    print(datetime.datetime.now(datetime.timezone.utc).isoformat(),'fresh funding preflight attempt',attempt,flush=True)
    r=subprocess.run(['python3',str(W/'work/claude-test-queue.py'),'--mib','512','--log',str(L/f'root-preflight-{attempt}.guard.log'),'--','node',str(W/'work/linux-lease-root-release/live-preflight.mjs')],cwd=W)
    if r.returncode!=98:break
    time.sleep(2)
else:raise RuntimeError('Preflight never started; no production control change made')
assert r.returncode==0,'preflight failed; do not activate'
prepath=W/'outputs/decentralization-audit/linux-conduit-funding-preflight.json'
pre=json.loads(prepath.read_text())
assert set(x['id'] for x in pre['rows'])==set(plan['adoptionRequired'])
assert all(x['active'] and x['hostActive'] and x['runnerOperator'].lower()=='0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab' for x in pre['rows'])
age=time.time()-int(pre['block']['timestamp'])
assert 0<=age<360
assert all(int(x['leaseRemainingSeconds'])-age>780 for x in pre['rows']),'lease margin insufficient; leave old control active and retry after renewal'
shutil.copy2(prepath,A/'preflight-used.json')
print('Fresh preflight passed; executing reviewed activation with automatic both-app rollback gate.',flush=True)
subprocess.run(['python3',str(A/'activate.py')],cwd=W,check=True)
