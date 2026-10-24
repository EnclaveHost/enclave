"""Read public custody settings and sealed-blob metadata only; never read state blob contents or signer environment."""
import pathlib,subprocess,json,datetime
unit='enclave-custodian-v2.service'
r=subprocess.run(['systemctl','--user','show',unit,'-p','MainPID','--value'],capture_output=True,text=True,timeout=10,check=True)
pid=int(r.stdout.strip());assert pid>1
args=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode().split('\0')
assert any(x == '/home/steven/enclave-prod/custodian-v2/host.mjs' for x in args),'Unexpected service command'
i=next(i for i,x in enumerate(args) if x == '/home/steven/enclave-prod/custodian-v2/host.mjs');cfgPath=pathlib.Path(args[i+1]);cfgPath=cfgPath if cfgPath.is_absolute() else pathlib.Path(f'/proc/{pid}/cwd').resolve()/cfgPath;assert cfgPath.is_absolute() and cfgPath.suffix=='.json'
cfg=json.loads(cfgPath.read_text());allowed=['dist','stateDir','endpoint','registryEndpoint','registryId','vault','committeeId','genesis','cpus','memMiB','hostPort','mgmtPort','tunnelName']
public={k:cfg[k] for k in allowed if k in cfg}
state=pathlib.Path(cfg['stateDir']);assert state.is_absolute()
blobs=[]
for f in sorted(state.glob('state.bin*')):
 st=f.stat();blobs.append({'name':f.name,'bytes':st.st_size,'modified':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'mode':oct(st.st_mode&0o777)})
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'pid':pid,'configPath':str(cfgPath),'publicConfig':public,'sealedBlobMetadata':blobs,'limits':['No state blob bytes or signer environment values read.','File count is current directory metadata, not an exhaustive backup inventory.','No service or VM changed.']}
pathlib.Path('work/custody-v2-live-20261023/evidence/local-config-retention.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
