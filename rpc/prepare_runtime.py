#!/usr/bin/env python3
"""Prepare a pinned owner runtime request; no network, delivery or submission."""
import importlib.util,json,os,time
from pathlib import Path

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
HERE=Path(__file__).resolve().parent
owner=load('attachment_preparer',HERE/'prepare_attachment.py')
runtime=load('runtime_start',HERE/'guest/start_runtime.py')
p=owner.protocol
INPUTS=('activationRequest','activationReady','attachmentReceipt','imageReceipt','seedReceipt')

def prepare(config):
 if set(config)!={*INPUTS,'phase','output'} or config['phase'] not in ('l1','base'):raise ValueError('Exact runtime preparation parameters required')
 wall=time.time_ns();mono=time.monotonic_ns()
 raw={key:owner.read_pinned(config[key])for key in INPUTS};v={key:p.decode(value)for key,value in raw.items()}
 ar=v['activationRequest'];ready=v['activationReady'];bundle=v['attachmentReceipt'];seed=v['seedReceipt'];image=v['imageReceipt']
 if set(ar)!={'bundle','resultSha256','runtimePins'} or set(ar['runtimePins'])!=set(runtime.a.required_pins()):raise ValueError('Exact activation request closure required')
 if (bundle['schema']!='owned-rpc-attachment-bundle/1' or image['schema']!='rpc-offline-image/1'
     or ar['resultSha256']!=p.sha(raw['attachmentReceipt']) or Path(ar['bundle']).name!=bundle['attempt']
     or ready['attempt']!=bundle['attempt'] or ready['bootId']!=bundle['guestBootId']
     or ready['requestSha256']!=p.sha(raw['activationRequest']) or ready['contractSha256']!=bundle['files']['attachment.json']
     or seed['instance']!=bundle['instance'] or seed['seedContainsPrivateCredentials'] is not True
     or ready['rpcReady'] is not False or ready['writersFenced'] is not False):raise ValueError('Artifact/activation bindings differ')
 def current():
  now=time.time_ns();elapsed=time.monotonic_ns()-mono
  if elapsed>5_000_000_000 or abs(now-wall-elapsed)>2_000_000_000:raise ValueError('Preparation clock or duration changed')
  created=bundle['createdUtcNs'];deadline=bundle['deadlineUtcNs']
  if type(created)is not int or type(deadline)is not int or deadline-created!=900_000_000_000 or not created<=now<deadline:
   raise ValueError('Original startup window required')
 current()
 for path,pin in ar['runtimePins'].items():
  if seed['records'].get(path,{}).get('sha256')!=pin:raise ValueError('Activation uses another seed runtime')
 pins={}
 for path,mode in runtime.required_pins().items():
  if path in seed['records']:
   record=seed['records'][path];actual_mode=int(record['mode'],8)
  else:
   record=image['installedFiles'].get(path.lstrip('/'),{});actual_mode=record.get('mode')
  if actual_mode!=mode or record.get('private')is True:raise ValueError('Missing or incorrect runtime artifact mode')
  p.digest(record.get('sha256'));pins[path]=record['sha256']
 request={'phase':config['phase'],'activationReadySha256':p.sha(raw['activationReady']),
          'activationRequestSha256':p.sha(raw['activationRequest']),'runtimePins':pins}
 data=json.dumps(request,sort_keys=True,indent=2).encode()+b'\n'
 output=Path(config['output']);owner.directory(output.parent);output.mkdir(mode=0o700)
 owner.write_new(output/('runtime-start-'+config['phase']+'.json'),data)
 for key in INPUTS:
  if owner.read_pinned(config[key])!=raw[key]:raise ValueError('Input changed during preparation')
 current()
 result={'schema':'owned-rpc-runtime-request/1','phase':config['phase'],'attempt':bundle['attempt'],
         'bootId':bundle['guestBootId'],'instance':bundle['instance'],'deadlineUtcNs':bundle['deadlineUtcNs'],
         'requestSha256':p.sha(data),'inputHashes':{k:p.sha(v)for k,v in raw.items()},
         'clientsStarted':False,'rpcReady':False,'adopted':False,'writersFenced':False}
 owner.write_new(output/'RESULT.json',json.dumps(result,sort_keys=True,indent=2).encode()+b'\n')
 fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 return result

if __name__=='__main__':
 import sys
 print(json.dumps(prepare(p.decode(Path(sys.argv[1]).read_bytes()))))
