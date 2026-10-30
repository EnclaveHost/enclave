import pathlib,json,hashlib,os,sys,time,resource
from capture import capture
p=pathlib.Path(__file__).resolve().parent
resource.setrlimit(resource.RLIMIT_FSIZE,(4<<20,4<<20))
b=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/payload-v2/bin/reth')
assert hashlib.file_digest(b.open('rb'),'sha256').hexdigest()=='8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250'
assert os.sched_getaffinity(0)=={1}
assert os.readlink('/proc/self/ns/net')!=os.readlink('/proc/1/ns/net')
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'netns':os.readlink('/proc/self/ns/net'),'disposableParserOnly':True},f)
out={}
for case in ('positive','negative'):
 argv=[str(b),'node','--config',str(p/(case+'.toml')),'--chain','mainnet','--datadir','/proc/enclave-rpc-parser-r1','--log.file.max-files','0','--disable-discovery','--disable-dns-discovery','--disable-auth-server','--ipcdisable','--nat','none']
 r=capture(argv,10,limit=262144);out[case]=r
 assert r['rc'] not in (None,0) and not r['reason'] and not r['truncated'],case+' did not reach bounded refusal'
positive=out['positive']['stdout']+out['positive']['stderr'];negative=out['negative']['stdout']+out['negative']['stderr']
negativeOK=('Failed to parse TOML' in negative and ('invalid type' in negative or 'expected' in negative))
positiveOK=('Failed to parse TOML' not in positive and '/proc/enclave-rpc-parser-r1' in positive and any(v in positive.lower() for v in ('no such file','permission denied','read-only','failed to create')))
assert not pathlib.Path('/proc/enclave-rpc-parser-r1').exists()
result={'status':'PARSER_QUALIFIED_NOT_RUNTIME' if positiveOK and negativeOK else 'HARNESS_EXPECTATION_NOT_SATISFIED','positiveAcceptedThenDatadirRefused':positiveOK,'negativeTypedConfigRejected':negativeOK,'results':out,'sourceProfileAppliedToProduction':False,'databaseCreated':False}
with (p/'RESULT.json').open('x') as f:json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k!='results'}))
raise SystemExit(0 if positiveOK and negativeOK else 2)
