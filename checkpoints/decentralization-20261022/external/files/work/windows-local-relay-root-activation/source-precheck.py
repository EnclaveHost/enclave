from pathlib import Path
import subprocess,hashlib,json,datetime
p=Path('work/windows-local-relay-migration/root')
a=(p/'relay-source-common.sh').read_text();b=(p/'do-source-stop.sh').read_text()
needle='. "$(dirname "$0")/relay-source-common.sh"'
assert b.count(needle)==1
script=b.replace(needle,a)
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','us-west','sudo','bash','-s','--','--check'],input=script.encode(),capture_output=True,timeout=45)
Path('work/windows-local-relay-root-activation/source-precheck.out').write_bytes(r.stdout+r.stderr)
print(r.stdout.decode(errors='replace'));print(r.stderr.decode(errors='replace'))
Path('outputs/decentralization-audit/windows-relay-source-precheck.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'readOnly':True,'combinedScriptSha256':hashlib.sha256(script.encode()).hexdigest(),'sourceStopped':False,'output':r.stdout.decode(errors='replace')},indent=2)+'\n')
raise SystemExit(r.returncode)
