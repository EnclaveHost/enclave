import importlib.util,json,os,pathlib,tempfile,time
p=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
s=importlib.util.spec_from_file_location('ready',p/'base-finality-proof-stage/r6/readiness/require_ready.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert not pathlib.Path('/proc/999999999').exists()
with tempfile.TemporaryDirectory() as t:
 report=pathlib.Path(t)/'latest.json';report.write_text(json.dumps({'format':'enclave-rpc-readiness/v1','overall':'READY','acceptance':True,'finishedAt':time.time(),'gates':{'post-anchor-finality':{'status':'pass','info':{'pid':999999999,'freshN':1000,'freshBlockHash':'0x'+'11'*32}}}}));report.chmod(0o600)
 ok,why=m.ready(report,owner_uid=os.getuid());assert ok is True,(ok,why)
 result={'counterexampleReproduced':True,'consumerAdmission':ok,'reason':why,'provenPidExists':False,'scope':'Real require_ready.ready helper accepts fresh cached READY report with dead proof process. This demonstrates missing live process revalidation; systemd behavior was not executed.'}
 (p/'logs/r6-stale-ready-counterexample.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
