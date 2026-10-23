"""Read only the relay's public factory/book settings and source hashes, never secret values."""
import subprocess,json,pathlib,datetime
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo python3 -']
remote=r'''
import subprocess,pathlib,json,hashlib,re,datetime
pid=int(subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip());assert pid>1
allowed={'SESSIONS_FACTORY','ADDRESS_BOOK_ADDRESS','CUSTODY_VAULT','CUSTODY_VAULT_V2'}
public={k:None for k in allowed}
for entry in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
 key,sep,val=entry.partition(b'=')
 if sep and key.decode() in allowed:
  value=val.decode();public[key.decode()]=value if re.fullmatch(r'0x[0-9a-fA-F]{40}',value) else {'present':True,'validAddress':False}
root=pathlib.Path('/opt/nan-relay');hashes=[]
for name in ['api-relay.js','sessions.js','network-api.js','relay/sessions.mjs','network/owner-signature.mjs']:
 p=root/name
 hashes.append({'path':name,'exists':p.is_file(),'sha256':hashlib.file_digest(open(p,'rb'),'sha256').hexdigest() if p.is_file() else None})
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'pid':pid,'publicEnvironment':public,'sourceHashes':hashes,'limits':['Only public address settings emitted; no secret values, raw environment or private configuration printed. No restart or configuration change.']}))
'''
r=subprocess.run(ssh,input=remote,text=True,capture_output=True,timeout=40)
if r.returncode:raise SystemExit('Read-only relay probe failed: '+r.stderr[-250:])
out=json.loads(r.stdout);pathlib.Path('work/custody-v2-live-20261023/evidence/relay-session-authority.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
