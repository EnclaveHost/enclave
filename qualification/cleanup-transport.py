#!/usr/bin/env python3
"""Identity-checked cleanup. On expiry local key retirement precedes all remote calls.
Usage: cleanup-transport.py STATE [--expired]
"""
import datetime, json, re, shutil, subprocess, sys, time
from pathlib import Path

state_path=Path(sys.argv[1]).resolve()
s=json.loads(state_path.read_text())
assert s['repository']=='EnclaveHost/enclave'
assert s['branch']=='build/lease-reaper-artifact-20261028'
assert re.fullmatch(r'[0-9a-f]{40}',s['sourceSha'])
assert re.fullmatch(r'reaper-input-20261028-[0-9a-f]{12}',s['tag'])
assert s['environment']=='reaper-artifact-20261028-'+s['tag'].rsplit('-',1)[1]
assert 0 < s['expiresAt']-s['createdAt'] <= 23*3600
expired=time.time()>=s['expiresAt']
if '--expired' in sys.argv and not expired: raise SystemExit(0)
local_raw=Path(s['localTransportDirectory'])
assert not local_raw.is_symlink()
local=local_raw.resolve()
assert local.parent==state_path.parent and local.name==s['tag']

def save():
    tmp=state_path.with_suffix('.tmp')
    tmp.write_text(json.dumps(s,indent=2)+'\n'); tmp.replace(state_path)

def retire_local():
    if local.exists(): shutil.rmtree(local)
    s['localKeyRetiredAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()

# Remote failures cannot retain the local identity past expiry. Even a cancellation
# retry or a broken GitHub connection leaves only nonsecret state for remote retries.
if expired: retire_local()

def api(path,method='GET'):
    r=subprocess.run(['gh','api','--method',method,'repos/'+s['repository']+'/'+path],capture_output=True,text=True,timeout=45)
    if r.returncode:
        if 'HTTP 404' in r.stderr: return None
        raise RuntimeError('GitHub operation failed: '+method+' '+path)
    return json.loads(r.stdout) if r.stdout.strip() else {}

def created_during_intent(value,intent):
    timestamp=datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    assert intent['at']-5 <= timestamp <= min(s['expiresAt'],intent['at']+300), 'resource creation outside intent window'

# If PUT succeeded but its response was lost, reconcile only this nonce-bearing
# name, written-ahead intent, source/branch, exact policy and creation window.
environment=api('environments/'+s['environment'])
if environment:
    if s.get('environmentId') is None:
        intent=s['environmentCreateIntent']
        assert intent['name']==s['environment'] and intent['sourceSha']==s['sourceSha']
        assert environment['name']==s['environment']
        created_during_intent(environment['created_at'],intent)
        assert environment['deployment_branch_policy']==intent['policy']=={'protected_branches':False,'custom_branch_policies':True}
        assert api('git/ref/heads/'+s['branch'])['object']['sha']==s['sourceSha']
        policies=api('environments/'+s['environment']+'/deployment-branch-policies')['branch_policies']
        assert policies==[], 'unknown environment ID cannot already have our later policy step'
        assert api('environments/'+s['environment']+'/secrets')['secrets']==[], 'unknown environment ID cannot already have our later secret step'
        s['environmentId']=environment['id']; save()
    assert environment['id']==s['environmentId'], 'environment was replaced; refusing deletion'
    api('environments/'+s['environment']+'/secrets/REAPER_AGE_IDENTITY','DELETE')
    api('environments/'+s['environment'],'DELETE')

if s.get('runId'):
    run=api('actions/runs/'+str(int(s['runId'])))
    if run:
        assert run['head_sha']==s['sourceSha'] and run['head_branch']==s['branch']
        if run['status']!='completed':
            api('actions/runs/'+str(s['runId'])+'/cancel','POST')
            raise RuntimeError('Owned run cancellation requested; retry cleanup after it stops')
        for artifact in api('actions/runs/'+str(s['runId'])+'/artifacts')['artifacts']:
            assert artifact['name']=='reaper-artifact-'+str(s['runId'])
            api('actions/artifacts/'+str(artifact['id']),'DELETE')

release=None
if s.get('releaseId'):
    release=api('releases/'+str(int(s['releaseId'])))
elif s.get('releaseCreateIntent'):
    matches=[]
    for page in range(1,11):
        rows=api('releases?per_page=100&page='+str(page))
        matches.extend(r for r in rows if r['tag_name']==s['tag'])
        if len(rows)<100: break
    else: raise RuntimeError('Release reconciliation pagination limit reached')
    assert len(matches)<=1
    if matches: release=matches[0]
if release:
    intent=s['releaseCreateIntent']
    assert intent['tag']==s['tag'] and intent['sourceSha']==s['sourceSha']
    assert release['tag_name']==s['tag'] and release['draft'] is False and release['prerelease'] is True
    assert intent['draft'] is False and intent['prerelease'] is True
    assert release['name']==intent['name']=='Temporary encrypted reaper build input'
    assert release['target_commitish']==s['sourceSha'] and release['body']==intent['body']
    created_during_intent(release['created_at'],intent)
    if s.get('releaseId') is None:
        # Upload cannot have begun before releaseId was saved.
        assert release['assets']==[]
        s['releaseId']=release['id']; save()
    assert release['id']==s['releaseId']
    api('releases/'+str(s['releaseId']),'DELETE')
ref=api('git/ref/tags/'+s['tag'])
if ref:
    assert s.get('releaseCreateIntent')
    assert ref['object']['type']=='commit' and ref['object']['sha']==s['sourceSha']
    api('git/refs/tags/'+s['tag'],'DELETE')
if not expired: retire_local()
s['cleanedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat(); save()
print('Owned temporary transport resources removed; original image and retrieved result retained.')
