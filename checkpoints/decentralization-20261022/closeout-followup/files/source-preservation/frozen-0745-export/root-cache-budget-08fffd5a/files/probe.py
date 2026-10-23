import importlib.util, pathlib,tempfile,json,os,hashlib,datetime
base=pathlib.Path(__file__).resolve().parent
pin=json.loads((base/'PIN.json').read_text()); assert hashlib.sha256((base/'budget.frozen.py').read_bytes()).hexdigest()==pin['sha256']
s=importlib.util.spec_from_file_location('frozen_budget',base/'budget.frozen.py');b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
with tempfile.TemporaryDirectory(prefix='enclave-budget-review-') as tmp:
 p=pathlib.Path(tmp);f=p/'tiny.img';ledger=p/'ledger.json';host='ab'*16
 doc={'format':b.FORMAT,'capBytes':b.CAP,'targetBytes':b.TARGET,'hosts':[{'machineId':host,'label':'fixture','shareBytes':1},{'machineId':'cd'*16,'label':'declared only, no remote allocation','shareBytes':b.CAP-1}],'reservations':[{'id':'test','host':host,'owner':'fixture','kind':'preallocated-files','maxBytes':1,'slackBytes':0,'files':[{'path':str(f),'bytes':1}]}]}
 ledger.write_text(json.dumps(doc));os.chmod(ledger,0o600)
 b.validate(doc);made=b.allocate(str(ledger),'test',host,require_root_owned=False)
 summary=b.verify(str(ledger),'test',host,require_root_owned=False)
 allocated={pathlib.Path(x).name:os.stat(x).st_blocks*512 for x in made}
 total=sum(allocated.values())
 assert summary['chargedBytes']==1 and total>summary['shareBytes']
 result={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':pin,'fixture':'Real small temporary files; ledger root-ownership check disabled through test seam only. No privileged commands, devices, actual node-cache allocation or remote allocation. Temporary files removed.','ledgerHostShares':sum(h['shareBytes'] for h in doc['hosts']),'declaredLocalShareBytes':1,'chargedBytes':summary['chargedBytes'],'actualCreatedFileAllocationBytes':allocated,'actualCreatedBytes':total,'verifyAccepted':True,'finding':'Per-file extent allowance is not charged to reservation slack or host share; zero-slack non-block-aligned allocations and marker files can exceed a declared hard maximum. This does not assert a live 250 GB overrun.'}
 pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/decentralization-audit/cache-budget-allocation-accounting-20261023.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
