"""Read only service names, selected public paths/addresses and listeners; no full argv or environments."""
import subprocess, pathlib, json, datetime
units=subprocess.run(['systemctl','--user','list-units','--all','--no-legend','--plain'],capture_output=True,text=True,timeout=10,check=True).stdout.splitlines()
selected=[]
for line in units:
 cols=line.split()
 if cols and any(x in cols[0].lower() for x in ['enclave','caddy','custody']):selected.append({'unit':cols[0],'load':cols[1],'active':cols[2],'sub':cols[3]})
listeners=subprocess.run(['ss','-ltnH'],capture_output=True,text=True,timeout=10,check=True).stdout.splitlines()
ports=[]
for line in listeners:
 cols=line.split()
 if len(cols)>3:ports.append(cols[3])
commands=[]
for unit in selected:
 if unit['active']!='active' or not unit['unit'].endswith('.service'):continue
 p=subprocess.run(['systemctl','--user','show',unit['unit'],'-p','MainPID','--value'],capture_output=True,text=True,timeout=10,check=True).stdout.strip()
 if not p.isdigit() or int(p)<2:continue
 try:
  args=pathlib.Path(f'/proc/{p}/cmdline').read_bytes().decode().split('\0')
  commands.append({'unit':unit['unit'],'pid':int(p),'program':pathlib.Path(args[0]).name,'paths':[v for v in args[1:] if v.startswith('/') and v.endswith(('.mjs','.js','.json','.sh'))],'cwd':str(pathlib.Path(f'/proc/{p}/cwd').resolve())})
 except OSError:pass
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'units':selected,'listenerAddresses':ports,'selectedProcessPaths':commands,'limits':['Metadata only, no secret/config/environment values or full argv. No service changed.']}
pathlib.Path('work/custody-v2-live-20261023/evidence/local-network-inventory.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
