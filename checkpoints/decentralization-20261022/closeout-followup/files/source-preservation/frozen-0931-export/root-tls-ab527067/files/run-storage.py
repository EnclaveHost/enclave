import subprocess,pathlib,json,sys,datetime
p=pathlib.Path(__file__).parent;apply='--apply'in sys.argv
cmd=['ssh','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32422','-o','BatchMode=yes','-o','ConnectTimeout=6','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@172.17.29.188','sudo python3 -'+(' --apply'if apply else '')]
r=subprocess.run(cmd,input=(p/'repair-storage.py').read_text(),capture_output=True,text=True,timeout=80)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'apply':apply,'exit':r.returncode,'out':r.stdout,'err':r.stderr[-800:]}
f=pathlib.Path('outputs/decentralization-audit')/('nucbox-tls-storage-retry-'+('apply-'if apply else'preflight-')+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json');f.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o));print('Saved',f);raise SystemExit(r.returncode)
