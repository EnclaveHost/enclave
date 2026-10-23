#!/usr/bin/env python3
"""Read the signed production snapshot's aggregate size offline; never emit key material or object names."""
import hashlib,json,os,re,subprocess,uuid
from pathlib import Path
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
base=root/'work/resume-after-checkpoint-20261022'
binary=base/'sia-whole-bucket-recovery/target/x86_64-unknown-linux-gnu/debug/sia-s3'
snapshot=root/'work/private/sia-direct-recovery/20261022T195643Z-c16c22ef/snapshot.json'
want='0e5b28c9dc53a5ac65e1bace6cf7409c8f6369599c114fb1878503acec210da1'
if hashlib.sha256(snapshot.read_bytes()).hexdigest()!=want:raise SystemExit('Snapshot hash differs from trusted receipt')
out=root/'work/private/sia-direct-recovery'/('size-only-'+uuid.uuid4().hex)
env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy') and k not in ('ENCLAVE_CONFIG','SIAS3_CONFIG','ENCLAVE_EGRESS')}
env['SIA_RECOVERY_KEY_FILE']=str(root/'work/private/sia-direct-recovery/app.seed')
p=subprocess.run(['timeout','20','unshare','-rn',str(binary),'recovery','restore',str(snapshot),want,str(out),'0','5'],env=env,capture_output=True,timeout=25)
m=re.search(rb'the snapshot holds ([0-9]+) bytes, above the 0-byte budget: nothing written',p.stderr)
record={'mode':'offline size-only zero-budget refusal','snapshotSha256':want,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'exit':p.returncode,'outputCreated':out.exists(),'network':'unshare -rn','sizeDetermined':bool(m)}
if m:record['totalObjectBytes']=int(m.group(1))
if out.exists():raise SystemExit('Unexpected output created during zero-budget preflight')
if not m:
    err=root/'work/private/sia-direct-recovery/size-only-error.log';err.write_bytes(p.stderr);err.chmod(0o600)
receipt=root/'outputs/decentralization-audit/storage-whole-recovery-size-20261023.json';receipt.write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
raise SystemExit(0 if m and p.returncode else 1)
