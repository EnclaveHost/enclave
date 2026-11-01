from pathlib import Path
import hashlib,importlib.util,json
p=Path(__file__).resolve().parent
raw=(p/'ACTUAL-R2-RECEIPTS.jsonl').read_bytes();assert hashlib.sha256(raw).hexdigest()=='54337908b5606edfdfcce4acb93be09f37722ad8334ef8fd00e45cb495831a21'
spec=importlib.util.spec_from_file_location('guard',p/'frozen/test/rpc-server/qualify_boot_guardian.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=[json.loads(line) for line in raw.splitlines()];assert len(rows)==7
checks=[]
for r in rows:
 m.check_shutdown(r['mode'],r['returncode']);checks.append({'mode':r['mode'],'actualExitVerified':r['returncode']})
 if r['mode'] not in ('future','overflow','expired'):
  try:m.check_shutdown(r['mode'],125)
  except AssertionError:checks.append({'mode':r['mode'],'failedRebootFallbackRefused':True})
  else:raise AssertionError('fallback accepted')
result={'checks':checks,'actualR2ReceiptSha256':hashlib.sha256(raw).hexdigest(),'nativeReplay':False}
(p/'output/EXIT-VERIFIED.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))
