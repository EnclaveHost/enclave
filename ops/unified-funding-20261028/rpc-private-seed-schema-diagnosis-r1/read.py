from pathlib import Path
import json,os
from jsonschema.validators import validator_for
root=Path('/home/controladmin/rpc-private-guest-8ee4452b174746c2b606b9b68f0fa623')
p=root/'output/readback/user-data';assert p.stat().st_size<24*1024**2
c=json.loads(p.read_text().split('\n',1)[1]);schema_path=Path('/usr/lib/python3/dist-packages/cloudinit/config/schemas/schema-cloud-config-v1.json')
s=json.loads(schema_path.read_text());v=validator_for(s)(s)
errors=[]
for e in v.iter_errors(c):
 errors.append({'path':list(e.absolute_path),'validator':e.validator,'schemaPath':list(e.absolute_schema_path)})
 assert len(errors)<32
print(json.dumps({'errors':errors,'schema':str(schema_path),'schemaDialect':s.get('$schema'),'invocation':os.environ.get('INVOCATION_ID'),'privateValuesDisclosed':False}))
