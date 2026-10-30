from pathlib import Path
import ast,json,hashlib,types,urllib.request,os
p=Path(__file__).resolve().parent;old=p.with_name('rpc-control-vm-l1-client-root-r4')
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
pins=json.loads((p/'PINS.json').read_text());assert all(sha(p/n)==h for n,h in pins.items())
with (p/'ROOT-CHECK-ATTEMPT.json').open('x') as f:json.dump({'sourceOnly':True,'native':False},f)
for f in p.glob('*.py'):ast.parse(f.read_text())
parts=['capture-remote.py','transport-helpers.py','client-operations.py','client-main.py']
assert (p/'remote-program.py').read_text()=='\n'.join((p/n).read_text() for n in parts)
assert (p/'run.py').read_text()==(p/'capture-local.py').read_text()+'\n'+(p/'run-body.py').read_text()
m=json.loads((p/'MANIFEST.json').read_text());pm=json.loads((p/'payload-manifest.json').read_text());ds=json.loads((p/'disks.json').read_text())
assert pm['mounts']['l1']==ds['disks'][0]['mount']==m['expectedProductionMount']
for n in ['original-reth.toml','proposed-reth.toml']:assert (p/n).read_bytes()==(old/n).read_bytes()
for row in m['payloadFiles'].values():assert sha(Path(row['localSource']))==row['sha256']
oldtree=ast.parse((old/'trial-chain-service.py').read_text());newtree=ast.parse((p/'trial-chain-service.py').read_text())
for name in ['run','prune_args','low_memory_args','mount','binary']:
 a=next(n for n in oldtree.body if isinstance(n,ast.FunctionDef) and n.name==name);b=next(n for n in newtree.body if isinstance(n,ast.FunctionDef) and n.name==name);assert ast.dump(a)==ast.dump(b),name
fn=next(n for n in ast.parse((p/'client-operations.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='sample_rpc')
class Response:
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self,n):assert n==65537;return payload
calls=[]
def urlopen(req,timeout):assert req.full_url=='http://127.0.0.1:18645' and timeout==1;calls.append(req.full_url);return Response()
g={'json':json,'urllib':types.SimpleNamespace(request=types.SimpleNamespace(Request=urllib.request.Request,urlopen=urlopen))};exec(compile(ast.Module(body=[fn],type_ignores=[]),'rpc-response-fixture','exec'),g)
cases=[({'jsonrpc':'2.0','id':1,'result':'0x0'},True),({'jsonrpc':'2.0','id':1,'result':'0xabc'},True),({'jsonrpc':'2.0','id':1,'result':'0x00'},False),({'jsonrpc':'2.0','id':True,'result':'0x1'},False),({'jsonrpc':'2.0','id':2,'result':'0x1'},False),({'jsonrpc':'2.0','id':1,'result':'0xGG'},False),({'jsonrpc':'2.0','id':1,'result':'0x'},False),({'jsonrpc':'2.0','id':1,'result':'0x1','error':{}},False),([1],False)]
for obj,valid in cases:
 payload=json.dumps(obj).encode();assert (g['sample_rpc']()['el'].get('validBlockNumber') is True)==valid
payload=b' '*65537;assert g['sample_rpc']()['el'].get('validBlockNumber') is not True
result={'sourceChecks':'composition, exactRethAST/TOML/payload/mountbindings','rpcCases':10,'inputDrift':[n for n,h in pins.items() if sha(p/n)!=h],'native':False};assert not result['inputDrift'];(p/'ROOT-CHECK-RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
