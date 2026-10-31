import copy, importlib.util, json, os
from pathlib import Path
import tempfile,time,unittest
ROOT=Path(__file__).resolve().parents[2]
def load(name,relative):
 spec=importlib.util.spec_from_file_location(name,ROOT/relative);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
p=load('protocol','rpc/storage_protocol.py');prepare=load('prepare','rpc/prepare_attachment.py')
guest=load('guest','rpc/guest/attach_storage.py')
BOOT='11111111-1111-1111-1111-111111111111';SERVER='22222222-2222-2222-2222-222222222222'
def encode(v):return json.dumps(v).encode()
def fixture():
 now=time.time_ns();attempt='ab'*16
 server={'attempt':attempt,'instance':'rpc-owned-protocol-fixture','bootId':SERVER,'createdUtcNs':now-1_000_000_000,'deadlineUtcNs':now-1_000_000_000+p.WINDOW,'roles':{}}
 credentials={'schema':'owned-rpc-credentials/1','attempt':attempt,'instance':server['instance'],'roles':{}}
 roles={}
 for role in p.UUIDS:
  name='rpc-storage-'+attempt+'-'+role
  server['roles'][role]={'host':'192.0.2.1','port':10809 if role=='l1' else 10810,'tlsName':name,'bytes':p.BYTES}
  credentials['roles'][role]={'tlsName':name,'clientDN':'CN=rpc-client-'+attempt+'-'+role,'caSha256':'c'*64,'clientCertificateSha256':'d'*64}
  roles[role]={'export':'rpc-'+attempt+'-'+role,'bytes':p.BYTES,'authenticated':True,'flush':True,'fua':True}
 raw=encode(server);ready=p.make_ready(server,p.sha(raw),roles,'e'*32,now)
 return raw,encode(ready),encode(credentials),now
class Tests(unittest.TestCase):
 def test_current_producer_to_actual_guest_parser(self):
  server,ready,cred,now=fixture();c=p.compose(server,ready,cred,BOOT,now)
  for role in p.UUIDS:guest.validate_config(c,role,now,BOOT)
  p.validate_ready(p.decode(ready),c,now)
  self.assertEqual(c['serverReadySha256'],p.sha(ready));self.assertEqual(c['createdUtcNs'],p.decode(server)['createdUtcNs'])
 def test_wrong_contract_or_origin(self):
  for field,value in [('contractSha256','0'*64),('bootId',BOOT),('instance','rpc-owned-another-fixture'),('attempt','cd'*16),('createdUtcNs',0),('deadlineUtcNs',1)]:
   s,r,k,now=fixture();r=p.decode(r);r[field]=value
   with self.assertRaises(ValueError):p.compose(s,encode(r),k,BOOT,now)
 def test_unnegotiated_or_incomplete_metadata(self):
  for field,value in [('authenticated',False),('fua',False),('flush',1),('export','default'),('bytes',True)]:
   s,r,k,now=fixture();r=p.decode(r);r['roles']['l1'][field]=value
   with self.assertRaises(ValueError):p.compose(s,encode(r),k,BOOT,now)
 def test_no_metadata_rpc_or_fence_claim(self):
  for field,value in [('rpcReady',True),('writersFenced',True),('exclusiveCow',True)]:
   s,r,k,now=fixture();r=p.decode(r);r[field]=value
   with self.assertRaises(ValueError):p.compose(s,encode(r),k,BOOT,now)
 def test_expired_or_future_receipt(self):
  s,r,k,now=fixture()
  with self.assertRaises(ValueError):p.compose(s,r,k,BOOT,now+p.WINDOW)
  r=p.decode(r);r['atUtcNs']=now+1
  with self.assertRaises(ValueError):p.compose(s,encode(r),k,BOOT,now)
 def test_credentials_cannot_switch_guest_or_role(self):
  for field,value in [('attempt','cd'*16),('instance','rpc-owned-foreign-fixture')]:
   s,r,k,now=fixture();k=p.decode(k);k[field]=value
   with self.assertRaises(ValueError):p.compose(s,r,encode(k),BOOT,now)
  s,r,k,now=fixture();k=p.decode(k);k['roles']['l1']=k['roles']['base']
  with self.assertRaises(ValueError):p.compose(s,r,encode(k),BOOT,now)
 def test_duplicate_json_and_legacy_receipt_refused(self):
  with self.assertRaises(ValueError):p.decode(b'{"attempt":1,"attempt":2}')
  s,_,k,now=fixture()
  with self.assertRaises(ValueError):p.compose(s,encode({'exclusiveCow':True,'originalsReadOnly':True}),k,BOOT,now)
 def test_actual_exclusive_file_bundle(self):
  os.umask(0o077);root=Path('/work');root.mkdir(mode=0o700,exist_ok=True);root.chmod(0o700)
  with tempfile.TemporaryDirectory(dir=root) as td:
   d=Path(td);s,r,k,now=fixture();config={'instance':p.decode(s)['instance'],'guestBootId':BOOT,'output':str(d/'output')}
   for field,raw in [('serverContract',s),('serverReady',r),('credentialReceipt',k)]:
    path=d/(field+'.json');path.write_bytes(raw);config[field]={'path':str(path),'sha256':p.sha(raw)}
   result=prepare.prepare(config);self.assertFalse(result['rpcReady']);self.assertFalse(result['writersFenced'])
   self.assertEqual((d/'output/server-ready.json').read_bytes(),r)
   for file in (d/'output').iterdir():self.assertEqual(file.stat().st_mode&0o777,0o600)
   with self.assertRaises(FileExistsError):prepare.prepare(config)
   bad=copy.deepcopy(config);bad['output']=str(d/'bad');bad['serverReady']['sha256']='0'*64
   with self.assertRaises(ValueError):prepare.prepare(bad)
   self.assertFalse((d/'bad').exists())
   bad=copy.deepcopy(config);bad['output']=str(d/'public');Path(bad['serverReady']['path']).chmod(0o644)
   with self.assertRaises(ValueError):prepare.prepare(bad)
   self.assertFalse((d/'public').exists())
if __name__=='__main__':unittest.main(verbosity=2)
