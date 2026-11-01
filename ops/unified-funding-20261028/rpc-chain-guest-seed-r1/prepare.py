from pathlib import Path
import json,subprocess,hashlib,base64,zlib
w=Path('/home/steven/Documents/Codex/2026-10-18/wo');s=w/'work/rpc-production-final-20261025/source';u=s.parent/'unified-funding-20261028';read=u/'rpc-chain-guest-admission-r1';old=u/'rpc-runtime-guest-seed-r1';p=Path(__file__).resolve().parent
obs=json.loads((read/'RESULT.json').read_text())['observation'];spec=json.loads((read/'SPEC.json').read_text());blob=json.loads((old/'CONFIG.json').read_text())
for key in ('openssl','ssh-keygen'):assert blob['tools'][key]['sha256']==obs['files'][blob['tools'][key]['path']]['sha256']
assert blob['config']['storageReceipt']['sha256']==obs['files'][blob['config']['archive']]['sha256']
assert blob['config']['xorrisoSha256']==obs['files'][blob['config']['xorriso']]['sha256']
blob.pop('existingCredential');blob.update(root=spec['root'],attempt=spec['attempt'],bootId=obs['boot'],admissionObservationUtcNs=obs['atUtcNs']);cfg=blob['config'];cfg.update(instance=spec['instance'],bootId=obs['boot'],output=spec['root']+'/output')
pins={}
for dest,row in cfg['payload'].items():
 if dest.startswith('/etc/systemd/system/'):src=s/'rpc/guest/units'/dest.removeprefix('/etc/systemd/system/')
 elif dest.endswith('/storage_library.py'):src=s/'rpc/guest/prepare_storage_client.py'
 elif dest.endswith('/storage_protocol.py'):src=s/'rpc/storage_protocol.py'
 else:src=s/'rpc/guest'/Path(dest).name
 raw=src.read_bytes();assert hashlib.sha256(raw).hexdigest()==row['sha256'] and raw==base64.b64decode(row['content']),dest
 pins[str(src)]=row['sha256']
for name in ('credentials.py','prepare_seed.py'):
 src=s/'rpc/guest'/name;raw=src.read_bytes();blob['sources'][name]={'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()};pins[str(src)]=hashlib.sha256(raw).hexdigest()
code=(old/'build.py').read_text().replace("generated=blob['existingCredential'];guard()", "generated=credentials.generate(root,blob['attempt'],blob['config']['instance'],blob['tools']);guard()")
code=code.replace('# Retain the existing identity; seed rendering verifies its immutable public receipt and every key pair.','# New exclusive successor identity; original credentials remain unchanged.')
code=code.replace("'sourcePins':{name:row['sha256'] for name,row in blob['sources'].items()}","'sourcePins':{name:row['sha256'] for name,row in blob['sources'].items()},'credentialPublic':generated['public'],'pid':os.getpid(),'processStart':Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]")
(p/'build.py').write_text(code);(p/'CONFIG.json').write_text(json.dumps(blob,indent=2)+'\n')
remote=json.loads((old/'REMOTE.json').read_text());remote[-2]=code;remote[-1]=base64.b64encode(zlib.compress(json.dumps(blob).encode(),9)).decode()
remote=[x.replace('enclave-rpc-runtime-guest-seed-r1-20261031','enclave-rpc-chain-guest-seed-r1-20261101')for x in remote]
assert remote[-3]=='-c';(p/'REMOTE.json').write_text(json.dumps(remote)+'\n');(p/'SSH.json').write_bytes((old/'SSH.json').read_bytes())
run=(old/'run.py').read_text();needle="with (p/'ATTEMPT.json').open('x')"
head="""s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
import hashlib
for name,sha in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==sha
admit=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert admit['authenticated'] and not admit['unreadUnits'] and admit['availableMiB']-admit['pendingMiB']-512>=max(27648,admit['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(admit)+'\\n')
"""
run=run.replace(needle,head+needle);(p/'run.py').write_text(run)
for name in ('CONFIG.json','REMOTE.json','SSH.json','build.py','run.py'):pins[str(p/name)]=hashlib.sha256((p/name).read_bytes()).hexdigest()
(p/'PINS.json').write_text(json.dumps(pins,indent=2)+'\n')
(p/'ROOT-REVIEW.md').write_text('New exclusive successor credentials and NoCloud seed using unchanged maintained credentials.generate/prepare_seed.build. Fresh Control read pins tool/archive/boot and measured available memory/disk; requires2GiB+128MiB guard/16GiB disk/100s builder and128MiB120s unit. Local authenticated pending-aware27648floor+512allowance. All17 payload sources exactly match maintained. Two new TLS roles and guest SSH host identity; normal Warden login key stays local; original credentials/media untouched. Private artifact never public. No VM/provider/startupclock/export/payments. Remote supervisor independent120s/killgroup/noSwap/CPU1/PrivateNetwork; transport exit not exact death. Independently read back result and exact process death before further action. storage_library payload resolves to maintained prepare_storage_client.py.\n')
cmd=[x.replace(old.name,p.name).replace('20261031','20261101')for x in json.loads((old/'COMMAND.json').read_text())]
(p/'COMMAND.json').write_text(json.dumps(cmd,indent=2)+'\n');subprocess.run(cmd,check=True)
print(json.dumps({'attempt':spec['attempt'],'vmAttempt':spec['vmAttempt'],'pinnedFiles':len(pins)}))
