import importlib.util,pathlib,json
H=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('e',H/'evaluate-before.py');e=importlib.util.module_from_spec(s);s.loader.exec_module(e)
g=dict(e.EXPECT,**{'pg.synchronous_commit':'on','config.stat':'600 enclave-indexd:enclave-indexd 980','disk.var_lib_free_bytes':str(59<<30),'state.du_bytes':'561190789','db.size_bytes':'29832895','binary.is_symlink':'no','releases_dir':'absent','unit.dropins':'','db.count.objects':'1491','db.count.slabs':'559','db.count.contracts':'71','pg.server_version':'18.6','mem.available_mib':'3200','digest.objects':'1491|abc'})
assert e.evaluate(g)['verdict']=='READY_FOR_FRESH_BACKUP'
r=[]
for k,v in [('disk.var_lib_free_bytes','unreadable'),('state.du_bytes','timeout'),('db.size_bytes','NaN'),('db.count.objects','ERROR'),('db.count.slabs','ERROR'),('db.count.contracts','ERROR'),('mem.available_mib','not-a-number'),('disk.var_lib_free_bytes','-1')]:
 x=e.evaluate(dict(g,**{k:v}));r.append({'key':k,'value':v,'verdict':x['verdict']})
with (H/'repro-result.json').open('x') as f:json.dump(r,f,indent=2)
print(json.dumps(r,indent=2))
assert any(x['verdict']=='READY_FOR_FRESH_BACKUP' for x in r),'expected old false-green not reproduced'
