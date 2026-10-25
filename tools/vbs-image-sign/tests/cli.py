#!/usr/bin/env python3
"""CLI qualification with a caller-supplied unsigned IGVM and an in-memory test key.
No private key is saved. Outputs go only in a new temporary directory.
Requires Python cryptography for an implementation independent of RustCrypto.
"""
import argparse, hashlib, json, os, struct, subprocess, tempfile, zlib
from pathlib import Path
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

ap=argparse.ArgumentParser();ap.add_argument('--tool',required=True);ap.add_argument('--input',required=True);a=ap.parse_args()
tool=str(Path(a.tool).resolve());source=Path(a.input).resolve();h=lambda b:hashlib.sha256(b).hexdigest()
raw=source.read_bytes();key=ec.generate_private_key(ec.SECP384R1())
pem=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
pub=key.public_key().public_numbers();public=struct.pack('<II',0x33534345,48)+pub.x.to_bytes(48,'big')+pub.y.to_bytes(48,'big')
passed=[]
def invoke(args,stdin=b'',ok=True,reason=None):
 p=subprocess.run([tool,*map(str,args)],input=stdin,capture_output=True,timeout=60)
 assert (p.returncode==0)==ok,(args,p.returncode,p.stdout.decode(errors='replace'),p.stderr.decode(errors='replace'))
 assert pem not in p.stdout+p.stderr
 if reason:assert reason in p.stderr.decode(),p.stderr.decode()
 return json.loads(p.stdout) if ok else None

def headers(b):
 start,size=struct.unpack_from('<II',b,8);end=start+size
 while start<end:
  typ,n=struct.unpack_from('<II',b,start);yield typ,start+8,n
  start+=8+((n+7)//8)*8
 assert start==end

def fix_crc(b):
 struct.pack_into('<I',b,20,0);start,size=struct.unpack_from('<II',b,8)
 struct.pack_into('<I',b,20,zlib.crc32(b[start:start+size],zlib.crc32(b[:24])))

with tempfile.TemporaryDirectory(prefix='enclave-vbs-sign-test-') as tmp:
 d=Path(tmp);out=d/'signed'
 options=['--input',source,'--expected-input-sha256',h(raw),'--expected-signer',h(public),'--product-id','1818455653','--module-id','1734437220','--svn','13']
 summary=invoke(['inspect','--input',source]);assert summary['identity'] is None
 manifest=invoke(['sign',*options,'--output',out],pem)
 signed=(out/'image.igvm').read_bytes()
 assert manifest==json.loads((out/'manifest.json').read_text())
 assert manifest['unsignedImageSha256']==h(raw) and manifest['signedImageSha256']==h(signed)
 assert manifest['launchMeasurement']==summary['launchMeasurement']
 assert manifest['identity']=={'signer':h(public),'productId':1818455653,'moduleId':1734437220}
 assert manifest['guestSvn']==13
 assert (out/'public-cng.bin').read_bytes()==public
 assert manifest['productionAdmission'] is False and manifest['hardwareAttestation'] is False
 assert sorted(p.name for p in out.iterdir())==['image.igvm','manifest.json','public-cng.bin']
 if os.name=='posix':assert out.stat().st_mode&0o777==0o700
 passed.append('sign actual input; manifest, public key, hashes, measurement and output permissions')
 measurement_headers=[(o,n) for typ,o,n in headers(signed) if typ==0x311];assert len(measurement_headers)==1
 offset,n=measurement_headers[0];assert n==864
 header=signed[offset:offset+n];fields=struct.unpack_from('<8I',header)
 assert fields==(1,1,1818455653,1734437220,13,0,1,1)
 assert header[32:64].hex()==summary['launchMeasurement']
 assert header[64:96]==bytes(32) and header[192:352]==bytes(160) and header[456:864]==bytes(408)
 assert header[352:456]==public
 payload=header[4:32]+header[32:64];sig=header[96:192]
 der=utils.encode_dss_signature(int.from_bytes(sig[:48],'big'),int.from_bytes(sig[48:],'big'))
 key.public_key().verify(der,payload,ec.ECDSA(hashes.SHA384()))
 try:key.public_key().verify(der,payload,ec.ECDSA(hashes.SHA256()))
 except InvalidSignature:pass
 else:raise AssertionError('wrong signature hash accepted')
 passed.append('independent cryptography library verifies P384/SHA384 payload and refuses SHA256')
 repeat=d/'repeat';invoke(['sign',*options,'--output',repeat],pem);assert (repeat/'image.igvm').read_bytes()==signed;assert (repeat/'manifest.json').read_bytes()==(out/'manifest.json').read_bytes()
 passed.append('repeat signing with same key is byte-identical')
 verify=['verify','--input',out/'image.igvm','--expected-input-sha256',h(signed),'--expected-measurement',summary['launchMeasurement'],
         '--expected-signer',h(public),'--product-id','1818455653','--module-id','1734437220','--minimum-svn','13']
 assert invoke(verify)['verified']
 passed.append('verify all independent artifact, measurement, authority and SVN pins')
 inspected=invoke(['inspect','--input',out/'image.igvm']);assert inspected['identity']==manifest['identity'] and inspected['guestSvn']==13
 passed.append('inspect signed image returns the verified identity and SVN')
 unsigned_verify=verify.copy();unsigned_verify[unsigned_verify.index('--input')+1]=source;unsigned_verify[unsigned_verify.index('--expected-input-sha256')+1]=h(raw)
 invoke(unsigned_verify,ok=False,reason='image is unsigned');passed.append('verify refuses unsigned image')
 newer_options=options.copy();newer_options[newer_options.index('--svn')+1]='14'
 newer=d/'newer';newer_manifest=invoke(['sign',*newer_options,'--output',newer],pem)
 newer_verify=verify.copy();newer_verify[newer_verify.index('--input')+1]=newer/'image.igvm';newer_verify[newer_verify.index('--expected-input-sha256')+1]=newer_manifest['signedImageSha256']
 assert invoke(newer_verify)['guestSvn']==14;passed.append('verify accepts SVN above the pinned minimum')
 for field,value in [('--expected-input-sha256','a1'*32),('--expected-measurement','a1'*32),('--expected-signer','a1'*32),
                     ('--product-id','1'),('--module-id','1'),('--minimum-svn','14')]:
  changed=verify.copy();changed[changed.index(field)+1]=value;invoke(changed,ok=False,reason='input SHA256' if field=='--expected-input-sha256' else 'does not satisfy')
  passed.append('verify refuses '+field)
 for field,value in [('--expected-input-sha256','a1'*32),('--expected-signer','a1'*32),('--svn','12'),('--svn','4294967296'),
                     ('--product-id','-1'),('--module-id','0x123'),('--expected-signer','0'*64)]:
  changed=options.copy();changed[changed.index(field)+1]=value;dest=d/('refused-'+str(len(passed)))
  reason={'--expected-input-sha256':'input SHA256','--expected-signer':'zero signer' if value=='0'*64 else 'signing key does not match','--svn':'SVN floor' if value=='12' else 'outside u32','--product-id':'unsigned decimal','--module-id':'unsigned decimal'}[field]
  invoke(['sign',*changed,'--output',dest],pem,ok=False,reason=reason);assert not dest.exists();passed.append('sign refuses '+field+'='+value)
 for private in [b'',b'not a private key',b'x'*16385,
    ec.generate_private_key(ec.SECP256R1()).private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())]:
  dest=d/('bad-key-'+str(len(passed)));invoke(['sign',*options,'--output',dest],private,ok=False,reason='exceeds 16 KiB' if len(private)>16384 else 'must be unencrypted P384 PKCS8 PEM');assert not dest.exists();passed.append('refuse invalid, oversized or wrong-curve key')
 sentinel=d/'existing';sentinel.mkdir();(sentinel/'keep').write_text('keep')
 invoke(['sign',*options,'--output',sentinel],pem,ok=False,reason='already exists');assert (sentinel/'keep').read_text()=='keep'
 link=d/'output-link';link.symlink_to(sentinel,target_is_directory=True)
 invoke(['sign',*options,'--output',link],pem,ok=False,reason='already exists');assert list(sentinel.iterdir())==[sentinel/'keep']
 passed.append('refuse existing and symlink output without overwriting')
 for extra in [['--unknown','x'],['--svn','13']]:
  invoke(['sign',*options,'--output',d/'extra',*extra],pem,ok=False);assert not (d/'extra').exists()
 passed.append('refuse duplicate and unknown options')
 changed=options.copy();changed[changed.index('--input')+1]=out/'image.igvm';changed[changed.index('--expected-input-sha256')+1]=h(signed)
 invoke(['sign',*changed,'--output',d/'resign'],pem,ok=False,reason='already signed');assert not (d/'resign').exists()
 passed.append('refuse adding or replacing an existing signature')
 for relative,label in [(12,'module'),(16,'svn'),(96,'signature'),(192,'signature-padding'),(456,'public-padding')]:
  damaged=bytearray(signed);damaged[offset+relative]^=1;fix_crc(damaged);file=d/'altered.igvm';file.write_bytes(damaged)
  invoke(['inspect','--input',file],ok=False,reason='padding' if label.endswith('padding') else 'SHA384/P384 signature failed');passed.append('refuse CRC-correct altered '+label)
 # The input hash is indispensable: header CRC does not cover every page.
 damaged=bytearray(raw);damaged[-1]^=1;file=d/'changed-unsigned.igvm';file.write_bytes(damaged)
 changed=options.copy();changed[changed.index('--input')+1]=file
 invoke(['sign',*changed,'--output',d/'changed-output'],pem,ok=False,reason='input SHA256');assert not (d/'changed-output').exists()
 passed.append('unsigned page tamper refused by independent input artifact pin')
 fifo=d/'input-fifo';os.mkfifo(fifo);invoke(['inspect','--input',fifo],ok=False,reason='regular file');passed.append('FIFO input refused without waiting for a writer')
 invoke(['inspect','--input',d],ok=False,reason='regular file');passed.append('directory input refused')
 huge=d/'oversized';huge.touch()
 with huge.open('r+b') as f:f.truncate((256<<20)+1)
 invoke(['inspect','--input',huge],ok=False,reason='at most 256 MiB');passed.append('oversized sparse input refused before loading')

print(json.dumps({'passed':True,'checks':len(passed),'cases':passed,'unsignedImageSha256':h(raw),
                 'launchMeasurement':summary['launchMeasurement'],'signedTestImageSha256':h(signed),'testSigner':h(public),
                 'privateKeyPersisted':False,'testOutputRemoved':True,'productionAdmission':False},indent=2))
