"""Read-only check of the scheduled updater; never changes a task or runtime."""
import contextlib,datetime,io,json,pathlib,runpy
base=pathlib.Path('work/resume-after-checkpoint-20261022/node-updater-readonly')
expected=datetime.datetime(2026,10,23,3,13,36,tzinfo=datetime.timezone.utc)
if datetime.datetime.now(datetime.timezone.utc)<expected+datetime.timedelta(seconds=10):
    print('NOT DUE: scheduled updater observation starts after 03:13:46Z')
    raise SystemExit(3)
buf=io.StringIO()
with contextlib.redirect_stdout(buf):runpy.run_path(str(base/'current-window.py'))
r=json.loads(buf.getvalue())
if 'error' in r:
    print('Host observation failed; no healthy-state receipt written')
    raise SystemExit(2)
u=r['update']
last=datetime.datetime.fromisoformat(u['last'].replace('Z','+00:00'))
host=r['hostSha'].lower();chain=r['chainSha'].lower()
o={'observedAt':r['at'],'updater':u,'scheduledRunObserved':last>=expected,'matchesReviewedRuntime':host=='ea0f6b8ab9562e95cc20e82ea0d6cc6c7a242445d0a8608195f50ebb711c00de' and chain=='3e9fae0392497841f5c4e084c9d11f6c01243d339b0bdf3395b569f921a12938','hostSha256':host,'chainSha256':chain,'runningApps':len(r['deployments']),'deployments':r['deployments'],'limitation':'Native observation of this scheduled run only. Lease values are not independent cryptographic proofs; source release completeness and future updates are not established.'}
out=pathlib.Path('outputs/decentralization-audit/windows-node-updater-0313-postcheck-20261023.json')
out.write_text(json.dumps(o,indent=2)+'\n')
print(json.dumps({k:v for k,v in o.items() if k!='deployments'}))
if not o['scheduledRunObserved']:raise SystemExit(3)
if u['result']!=0 or not o['matchesReviewedRuntime'] or o['runningApps']!=9:raise SystemExit(1)
