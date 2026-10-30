from pathlib import Path
import subprocess,json,hashlib
m=Path(__file__).resolve().parent
out=m/'full-firmware-predictions-r1.json'
if out.exists():raise SystemExit('predictions already exist')
b=json.loads((m/'full-images-build-r1/BUILD.json').read_text());fw=json.loads((m/'fwbuild-candidate-r1/candidate-debug.json').read_text())
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
if sha(fw['firmware'])!=fw['sha256']:raise SystemExit('candidate firmware drift')
proofs={}
for case in ['control4-r1','control8-r1','control4-testqemu-r2','notable-r2','substitution-r2']:
 p=m/('fw-boot-candidate-debug-'+case)/'RESULT.json';r=json.loads(p.read_text())
 if not r['accepted'] or r['spec']['firmware_sha256']!=fw['sha256']:raise SystemExit('debug boot qualification absent')
 proofs[str(p)]=sha(p)
rel=Path('/home/steven/enclave-prod/release-5cab66e4');release=json.loads((rel/'release.json').read_text())
for name in ['kernel','firmware.fd']:
 if sha(rel/name)!=release['files'][name]['sha256']:raise SystemExit('original release drift')
record={'scope':'new DEBUG firmware predictions, not original production release or full-model attestation','firmware':fw['firmware'],'firmware_sha256':fw['sha256'],'qualification_receipts':proofs,'arms':{}}
for arm,v in b['arms'].items():
 if sha(v['image'])!=v['sha256']:raise SystemExit('image drift')
 cmd=['/home/steven/.local/bin/sev-snp-measure','--mode','snp','--vcpus','16','--vcpu-family','26','--vcpu-model','2','--vcpu-stepping','1','--vmm-type','QEMU','--ovmf',fw['firmware'],'--kernel',str(rel/'kernel'),'--initrd',v['image'],'--append',release['cmdline']]
 pred=subprocess.check_output(cmd,text=True,timeout=120).strip()
 if len(pred)!=96 or any(c not in '0123456789abcdef' for c in pred):raise SystemExit('bad prediction output')
 record['arms'][arm]={'image':v['image'],'sha256':v['sha256'],'measurement':pred}
out.write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,indent=2))
