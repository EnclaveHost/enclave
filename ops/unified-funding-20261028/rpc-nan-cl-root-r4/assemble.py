"""Pure local source assembly; no runtime actions. One exclusive output directory."""
from pathlib import Path
import json,hashlib,shutil,ast,sys,shlex
p=Path(__file__).resolve().parent;s=p/'source';dest=p/'runtime'
assert not dest.exists(),'immutable assembled output already exists'
sha=lambda f:hashlib.file_digest(f.open('rb'),'sha256').hexdigest()
for f in s.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
m=json.loads((s/'MANIFEST.json').read_text());m['ownedBootstrapUnits']=['enclave-rpc-nan-bootstrap-n4.service']
m['ownedUnits']=[*m['ownedSlices'],*m['ownedBootstrapUnits'],'enclave-rpc-nan-helper-n4.service','enclave-rpc-nan-watch-n4.service','enclave-rpc-nan-nbd-n4.service','enclave-rpc-nan-cl-trial-n4.service','enclave-rpc-nan-verify-n4.service','enclave-rpc-nan-request-stop-n4.service','enclave-rpc-nan-socket-clear-n4.service']
# Extract generated remote command strings without invoking functions/importing runner.
tree=ast.parse((s/'run-body.py').read_text());commands=[]
bootstrap=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='bootstrap')
commands.append(next(ast.literal_eval(n.value) for n in bootstrap.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='command' for t in n.targets)))
for action in ('main','verify','request-stop','socket-clear'):
 if action=='main':unit='enclave-rpc-nan-helper-n4';slice_name='enclavenanattachn4.slice';runtime=330;stop_seconds=95;post=" '--property=ExecStopPost=/usr/bin/python3 -B /run/enclave-rpc-nan-client-n4/program.py wait-cleanup'"
 elif action=='verify':unit='enclave-rpc-nan-verify-n4';slice_name='enclavenanguardn4.slice';runtime=130;stop_seconds=10;post=''
 else:unit='enclave-rpc-nan-'+action+'-n4';slice_name='enclavenanguardn4.slice';runtime=20;stop_seconds=5;post=''
 commands.append('/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --slice='+slice_name+' --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=64 --property=RuntimeMaxSec='+str(runtime)+' --property=TimeoutStopSec='+str(stop_seconds)+' --property=KillMode=control-group --property=UMask=0077'+post+' /usr/bin/python3 -B /run/enclave-rpc-nan-client-n4/program.py '+action)
m['transportCommands']=commands;m['transportArgv']=[v for c in commands for v in (shlex.split(c),shlex.split(c)[2:])]
dest.mkdir(mode=0o700)
for name in ('capture-local.py','capture-remote.py','transport-helpers.py','nan-admission.py','ownership.py','client-operations.py','client-main.py','run-body.py','trial-chain-service.py','disks.json','payload-manifest.json'):
 shutil.copy2(s/name,dest/name)
program='\n'.join((dest/n).read_text() for n in ('capture-remote.py','transport-helpers.py','nan-admission.py','ownership.py','client-operations.py','client-main.py'))
# ownership module imports no conflicting global identifiers.
(dest/'remote-program.py').write_text(program);m['programSha256']=sha(dest/'remote-program.py')
(dest/'run.py').write_text((dest/'capture-local.py').read_text()+'\n'+(dest/'run-body.py').read_text())
for key,name in [('manifest.json','payload-manifest.json'),('chain_service.py','trial-chain-service.py'),('disks.json','disks.json')]:
 row=m['payloadFiles'][key];row['localSource']=str(dest/name);row['sha256']=sha(dest/name);row['bytes']=(dest/name).stat().st_size
assert json.loads((dest/'payload-manifest.json').read_text())['mounts']['l1']==json.loads((dest/'disks.json').read_text())['disks'][0]['mount']==m['expectedProductionMount']
(dest/'MANIFEST.json').write_text(json.dumps(m,indent=2)+'\n')
external=json.loads((s/'EXTERNAL-PINS.json').read_text())
# Keep exact qualified tool bytes; add public NBD copy from its existing qualification receipt.
q=Path(m['localNbdClient']);assert q.stat().st_size==56376 and sha(q)==m['client']['sha256']
external.append({'path':str(q),'realpath':str(q.resolve()),'bytes':56376,'sha256':m['client']['sha256']})
(dest/'EXTERNAL-PINS.json').write_text(json.dumps(external,indent=2)+'\n')
for f in dest.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
(dest/'PINS.json').write_text(json.dumps({f.name:sha(f) for f in sorted(dest.iterdir()) if f.is_file()},indent=2)+'\n')
print(json.dumps({'output':str(dest),'sourceAssembledOnly':True,'nativeAdmitted':False,'admissionAuthorized':m['admission']['authorized']}))
