"""Inert pipe fixture only. No owner authorization, signatures or systemd."""
import hashlib,json,os,struct,sys,time
from pathlib import Path

def read():
    header=sys.stdin.buffer.read(4)
    if not header:raise SystemExit(0)
    n=struct.unpack('!I',header)[0]
    if n>4<<20:raise SystemExit(2)
    raw=sys.stdin.buffer.read(n)
    if len(raw)!=n:raise SystemExit(3)
    return raw

def write(raw):
    sys.stdout.buffer.write(struct.pack('!I',len(raw))+raw);sys.stdout.buffer.flush()

cfg=json.loads(Path(sys.argv[1]).read_text());mode=cfg.get('mode','normal')
if mode=='no-read':time.sleep(5);raise SystemExit(0)
raw=read()
if mode=='die':raise SystemExit(0)
if mode=='oversize':sys.stdout.buffer.write(struct.pack('!I',2049));sys.stdout.buffer.flush();time.sleep(5)
if mode=='truncated':sys.stdout.buffer.write(struct.pack('!I',9)+b'x');sys.stdout.buffer.flush();raise SystemExit(0)
if mode=='stderr':sys.stderr.buffer.write(b'x'*8193);sys.stderr.buffer.flush();time.sleep(5)
if 'journal' not in cfg:
    write(raw)
    if mode=='unsolicited':sys.stdout.buffer.write(b'x');sys.stdout.buffer.flush()
    while True:write(read())
root=Path(cfg['journal']);out=Path(cfg['output'])
proof=json.dumps(cfg['proof']).encode()  # preserve spaces to expose reencoding
p=root/('proof-'+cfg['requestSha']);p.write_bytes(proof);p.chmod(0o400)
(out/'signer-started.json').write_text(json.dumps(cfg['started']));(out/'signer-started.json').chmod(0o600)
write(proof)
while True:
    raw=read();permit=json.loads(raw)
    if permit.get('schema')=='enclave-rpc-serving-prepare/1':
        reply=json.dumps({'schema':'enclave-rpc-serving-prepared/1','requestSha256':hashlib.sha256(raw).hexdigest(),'l1':'a'*128,'base':'b'*128}).encode()
        if mode=='bad-prepare-response':reply=reply.replace(hashlib.sha256(raw).hexdigest().encode(),b'0'*64)
        if mode!='missing-prepare-journal':
            p=root/('serving-prepare-'+cfg['requestSha']+'-proof');p.write_bytes(reply);p.chmod(0o400)
        write(reply);continue
    reply=json.dumps({'permit':permit,'l1':'a'*128,'base':'b'*128}).encode()
    if mode!='missing-journal':
        p=root/('continuation-%s-%016x-proof'%(cfg['requestSha'],permit['sequence']));p.write_bytes(reply);p.chmod(0o400)
    write(reply)
