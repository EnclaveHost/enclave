import pathlib,subprocess,json,sys,time,datetime
root=pathlib.Path(__file__).resolve().parent
host=sys.argv[1];assert host in ['us-west','eu-central','ap-southeast','ca-east']
stage='/opt/enclave-retained/shield-public-c7084346'
free=int(subprocess.check_output(['ssh','-o','BatchMode=yes',host,'df -Pm /opt | tail -1 | awk \'{print $4}\''],text=True).strip());assert free>1500,(host,free)
subprocess.run(['ssh','-o','BatchMode=yes',host,'mkdir -p '+stage+'/network '+stage+'/wasm'],check=True)
files=['manifest.json','install.py']+[p.name for p in root.glob('*.car')]
subprocess.run(['scp','-q']+[str(root/x) for x in files]+[host+':'+stage+'/'],check=True)
for part in ['network/replicate-artifacts.py','wasm/ipfs_fetch.py']:
 subprocess.run(['scp','-q',str(root/part),host+':'+stage+'/'+part],check=True)
p=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3 '+stage+'/install.py'],text=True,capture_output=True)
(root/(host+'-install.log')).write_text(p.stdout+p.stderr);print(p.stdout,flush=True);p.check_returncode()
(root/(host+'-publication.json')).write_text(json.dumps({'host':host,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':json.loads(p.stdout.strip().splitlines()[-1])},indent=2)+'\n')
