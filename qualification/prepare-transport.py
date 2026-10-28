#!/usr/bin/env python3
"""Execute only after exact-file review. Creates encrypted transport, not a build.
Usage: prepare-transport.py BASE TASK_STATE_DIRECTORY EXPECTED_SOURCE_SHA
Never dispatches a workflow or changes production. Refuses preexisting resources.
"""
import hashlib, json, os, re, secrets, shutil, subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

os.umask(0o077)
root=Path(__file__).resolve().parent.parent
base=Path(sys.argv[1]).resolve()
state_dir=Path(sys.argv[2]).resolve()
commit=sys.argv[3]
assert re.fullmatch(r'[0-9a-f]{40}',commit)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==commit
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
subprocess.run([sys.executable,str(root/'qualification/verify-image.py'),str(base)],check=True)
assert state_dir.is_dir() and not state_dir.is_symlink()
tag='reaper-input-20261028-'+secrets.token_hex(6)
local=state_dir/tag; local.mkdir(mode=0o700)
now=int(time.time())
s={'repository':'EnclaveHost/enclave','environment':'reaper-artifact-20261028-'+tag.rsplit('-',1)[1],
   'branch':'build/lease-reaper-artifact-20261028','sourceSha':commit,'tag':tag,
   'createdAt':now,'expiresAt':now+23*3600,'localTransportDirectory':str(local),
   'environmentId':None,'releaseId':None,'runId':None}
state=state_dir/(tag+'.json')
def save():
    tmp=state.with_suffix('.tmp'); tmp.write_text(json.dumps(s,indent=2)+'\n'); tmp.replace(state)
save()
def gh(args, data=None):
    result=subprocess.run(['gh',*args],input=data,capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub operation failed (details withheld to protect transport identity): '+args[0])
    return result.stdout
def api(path, method='GET', data=None):
    args=['api','--method',method,'repos/EnclaveHost/enclave'+('/'+path if path else '')]
    if data is not None: args+=['--input','-']
    out=gh(args,json.dumps(data).encode() if data is not None else None)
    return json.loads(out) if out.strip() else {}

# Refuse to overwrite any environment and require the already-pushed reviewed branch.
environments=api('environments?per_page=100')['environments']
assert len(environments)<100, 'manual pagination review needed'
assert not any(e['name']==s['environment'] for e in environments)
assert api('git/ref/heads/'+s['branch'])['object']['sha']==commit

# Record the actual remote default-branch workflow events before any release creation.
# Reject release/create/delete/workflow_run event handlers; no ad-hoc production hooks.
import base64
def review_default_workflows():
    repo=api(''); assert repo['default_branch']=='main'
    main_sha=api('git/ref/heads/main')['object']['sha']
    workflow_review={'defaultBranch':'main','commit':main_sha,'reviewedAt':int(time.time()),'files':[]}
    for entry in api('contents/.github/workflows?ref='+main_sha):
        if not entry['name'].endswith(('.yml','.yaml')): continue
        source=api('contents/.github/workflows/'+entry['name']+'?ref='+main_sha)
        body=base64.b64decode(source['content']).decode()
        match=re.search(r'^on:\s*\n((?:[ \t].*\n|\s*\n)*)',body,re.M)
        assert match, 'unrecognized workflow event syntax requires manual review'
        events=match.group(1)
        assert not re.search(r'^  (release|create|delete|workflow_run):',events,re.M), 'unexpected remote workflow hook'
        workflow_review['files'].append({'path':entry['path'],'gitBlobSha':source['sha'],
                                        'sha256':hashlib.sha256(body.encode()).hexdigest(),'eventBlock':events})
    return workflow_review
workflow_review=review_default_workflows()
main_sha=workflow_review['commit']
s['defaultBranchWorkflowReview']=workflow_review; save()

# Exact persistent fallback files are generated from this reviewed source.
unit='enclave-'+tag+'-cleanup'
units=Path.home()/'.config/systemd/user'; units.mkdir(parents=True,exist_ok=True)
service=units/(unit+'.service'); timer=units/(unit+'.timer')
assert not service.exists() and not timer.exists()
import datetime
deadline=datetime.datetime.fromtimestamp(s['expiresAt'],datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
q=lambda value: json.dumps(str(value))
service.write_text('[Unit]\nDescription=Cleanup owned encrypted reaper transport\nStartLimitIntervalSec=0\n'
    '[Service]\nType=oneshot\nEnvironment=PATH=/usr/sbin:/usr/bin:/sbin:/bin\n'
    'ExecStart='+q(sys.executable)+' '+q(root/'qualification/cleanup-transport.py')+' '+q(state)+' --expired\n'
    'Restart=on-failure\nRestartSec=300\nTimeoutStartSec=300\nMemoryMax=128M\nCPUQuota=10%\n')
timer.write_text('[Unit]\nDescription=23 hour encrypted reaper transport expiry\n[Timer]\nOnCalendar='+deadline+
    '\nPersistent=true\nAccuracySec=1s\nUnit='+unit+'.service\n[Install]\nWantedBy=timers.target\n')
s['cleanupUnit']=unit; save()
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now',unit+'.timer'],check=True,capture_output=True)
subprocess.run(['systemctl','--user','is-active','--quiet',unit+'.timer'],check=True)


# Bounded official tool download, verified before executing either binary.
url='https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz'
with urllib.request.urlopen(url,timeout=60) as response:
    blob=response.read(32*1024*1024+1)
assert len(blob)<=32*1024*1024
assert hashlib.sha256(blob).hexdigest()=='cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'
import io
with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as archive:
    for name in ['age/age','age/age-keygen']:
        member=archive.getmember(name); assert member.isfile() and member.size<32*1024*1024
        binary=local/Path(name).name
        with archive.extractfile(member) as src,binary.open('xb') as dst: shutil.copyfileobj(src,dst)
        binary.chmod(0o700)
identity=local/'identity.agekey'
with identity.open('xb') as key:
    subprocess.run([str(local/'age-keygen')],stdout=key,stderr=subprocess.DEVNULL,check=True)
identity.chmod(0o600)
s['recipient']=subprocess.check_output([str(local/'age-keygen'),'-y',str(identity)],text=True).strip()
assert re.fullmatch(r'age1[0-9a-z]{58}',s['recipient'])
encrypted=local/'input.tar.age'
proc=subprocess.Popen([str(local/'age'),'-r',s['recipient'],'-o',str(encrypted)],stdin=subprocess.PIPE)
try:
    with tarfile.open(fileobj=proc.stdin,mode='w|') as archive:
        for name in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json']:
            archive.add(base/name,arcname=name,recursive=False)
    proc.stdin.close()
    assert proc.wait(timeout=60)==0
finally:
    if proc.poll() is None: proc.kill(); proc.wait()
with encrypted.open('rb') as f: s['inputSha256']=hashlib.file_digest(f,'sha256').hexdigest()
save()


try:
    s['environmentCreateIntent']={'at':int(time.time()),'name':s['environment'],'sourceSha':commit,
        'policy':{'protected_branches':False,'custom_branch_policies':True}}
    save()
    environment=api('environments/'+s['environment'],'PUT',{'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}})
    s['environmentId']=environment['id']; save()
    api('environments/'+s['environment']+'/deployment-branch-policies','POST',{'name':s['branch'],'type':'branch'})
    check=api('environments/'+s['environment'])['deployment_branch_policy']
    assert check=={'protected_branches':False,'custom_branch_policies':True}
    policies=api('environments/'+s['environment']+'/deployment-branch-policies')['branch_policies']
    assert len(policies)==1 and policies[0]['name']==s['branch'] and policies[0]['type']=='branch'
    gh(['secret','set','REAPER_AGE_IDENTITY','--repo',s['repository'],'--env',s['environment']],identity.read_bytes())
    s['prePublicationWorkflowReview']=review_default_workflows()
    assert s['prePublicationWorkflowReview']['commit']==main_sha, 'default branch changed since event review'
    save()
    s['releaseCreateIntent']={'at':int(time.time()),'tag':tag,'sourceSha':commit,
        'name':'Temporary encrypted reaper build input','draft':False,'prerelease':True,
        'body':'Ciphertext-only reaper transport '+tag+' at '+commit+'. Expires within 24 hours. Not a CPU or application release.'}
    save()
    release=api('releases','POST',{'tag_name':tag,'target_commitish':commit,'name':s['releaseCreateIntent']['name'],
       'body':s['releaseCreateIntent']['body'],
       'draft':False,'prerelease':True,'make_latest':'false','generate_release_notes':False})
    s['releaseId']=release['id']; save()
    gh(['release','upload',tag,str(encrypted),'--repo',s['repository']])
    assets=api('releases/'+str(s['releaseId'])+'/assets')
    assert len(assets)==1 and assets[0]['name']=='input.tar.age'
    s['assetId']=assets[0]['id']; save()
    expected_url='https://github.com/EnclaveHost/enclave/releases/download/'+tag+'/input.tar.age'
    assert assets[0]['browser_download_url']==expected_url
    # Independent anonymous streaming read before any second build: no auth header,
    # bounded buffers/bytes/time, and no local second copy of the ciphertext.
    h=hashlib.sha256(); size=0; started=time.monotonic()
    with urllib.request.urlopen(expected_url,timeout=30) as response:
        while True:
            chunk=response.read(1024*1024)
            if not chunk: break
            size+=len(chunk); assert size<=encrypted.stat().st_size
            assert time.monotonic()-started<180, 'anonymous transfer verification timeout'
            h.update(chunk)
    assert size==encrypted.stat().st_size and h.hexdigest()==s['inputSha256']
    s['anonymousRetrieval']={'url':expected_url,'bytes':size,'sha256':h.hexdigest(),'verifiedAt':int(time.time())}
    save()
except BaseException:
    # Preserve nonsecret state on any ambiguous failure; fallback identity-checks before deletion.
    subprocess.run([sys.executable,str(root/'qualification/cleanup-transport.py'),str(state)],check=False)
    raise
print(json.dumps({'state':str(state),'assetId':s['assetId'],'inputSha256':s['inputSha256'],
                  'recipient':s['recipient'],'expiresAt':s['expiresAt'],'sourceSha':commit},indent=2))
