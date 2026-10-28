#!/usr/bin/env python3
"""Delete only recorded, identity-checked temporary transport resources.
State contains public IDs/paths, never credentials. Idempotent; fail closed on mismatch.
Usage: cleanup-transport.py STATE [--expired]
Run directly after retrieval/failure and through the persistent 23-hour fallback timer.
"""
import datetime, json, os, re, shutil, subprocess, sys, time
from pathlib import Path

state_path=Path(sys.argv[1]).resolve()
s=json.loads(state_path.read_text())
assert s['repository']=='EnclaveHost/enclave'
assert s['environment']=='reaper-artifact-20261028'
assert s['branch']=='build/lease-reaper-artifact-20261028'
assert re.fullmatch(r'[0-9a-f]{40}',s['sourceSha'])
assert re.fullmatch(r'reaper-input-20261028-[0-9a-f]{12}',s['tag'])
assert 0 < s['expiresAt']-s['createdAt'] <= 23*3600
if '--expired' in sys.argv and time.time()<s['expiresAt']:
    raise SystemExit(0)

def api(path,method='GET'):
    r=subprocess.run(['gh','api','--method',method,'repos/'+s['repository']+'/'+path],capture_output=True,text=True)
    if r.returncode:
        if 'HTTP 404' in r.stderr: return None
        raise RuntimeError('GitHub operation failed: '+method+' '+path)
    return json.loads(r.stdout) if r.stdout.strip() else {}

# Remove the secret before any asset cleanup. Verify this environment is ours.
environment=api('environments/'+s['environment'])
if environment:
    assert environment['id']==s['environmentId'], 'environment was replaced; refusing deletion'
    api('environments/'+s['environment']+'/secrets/REAPER_AGE_IDENTITY','DELETE')
    api('environments/'+s['environment'],'DELETE')

# Never delete a live run's transport until it has stopped. On TTL expiry cancel our run.
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

if s.get('releaseId'):
    release=api('releases/'+str(int(s['releaseId'])))
    if release:
        assert release['tag_name']==s['tag'] and release['draft'] is True
        assert release['target_commitish']==s['sourceSha']
        api('releases/'+str(s['releaseId']),'DELETE')
ref=api('git/ref/tags/'+s['tag'])
if ref:
    assert ref['object']['type']=='commit' and ref['object']['sha']==s['sourceSha']
    api('git/refs/tags/'+s['tag'],'DELETE')

# Local cleanup is confined to the recorded task-owned directory, never production.
local_raw=Path(s['localTransportDirectory'])
assert not local_raw.is_symlink()
local=local_raw.resolve()
assert local.parent == state_path.parent
assert local.name == s['tag']
if local.exists(): shutil.rmtree(local)
s['cleanedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
state_path.write_text(json.dumps(s,indent=2)+'\n')
print('Owned temporary transport resources removed; original image and retrieved result retained.')
