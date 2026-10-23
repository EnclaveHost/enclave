import subprocess,pathlib,json,sys,datetime
p=pathlib.Path(__file__).parent;apply='--apply'in sys.argv
hosts={'ca-east':348549,'eu-central':352111,'ap-southeast':358333,'us-west':0}
rows=[]
for h,pid in hosts.items():
 cmd=['ssh',*(['-J','us-west']if h!='us-west'else[]),'-o','BatchMode=yes','-o','ConnectTimeout=6',h,'sudo python3 - '+str(pid)+' 1792744245'+(' --apply'if apply else'')]
 r=subprocess.run(cmd,input=(p/'receiver.py').read_text(),capture_output=True,text=True,timeout=25)
 rows.append({'host':h,'exit':r.returncode,'out':r.stdout,'err':r.stderr[-500:]})
 if r.returncode:break
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'apply':apply,'rows':rows}
f=pathlib.Path('outputs/decentralization-audit')/('nucbox-tls-receivers-'+('apply-'if apply else'preflight-')+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json');f.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out));print('Saved',f);raise SystemExit(0 if all(r['exit']==0 for r in rows)and len(rows)==4 else 2)
