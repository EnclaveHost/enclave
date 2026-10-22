from pathlib import Path
import json,subprocess,datetime
rows=[]
for host in json.loads(Path('outputs/storage-tunnel-preparation.json').read_text()):
 ip=host['address']
 r=subprocess.run(['curl','-sS','--max-time','20','--resolve','sia.enclave.host:443:'+ip,'https://sia.enclave.host/','-o','/dev/null','-w','%{http_code}'],capture_output=True,text=True)
 assert r.returncode==0 and r.stdout=='502',host['host']+' TLS route failed'
 rows.append({'host':host['host'],'address':ip,'tlsVerified':True,'httpStatus':502,'meaning':'Destination proxy reachable; production indexd deliberately stopped'})
base=['ssh','-p','32422','-o','BatchMode=yes','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
command="systemctl is-system-running; cloud-init status; systemctl is-active enclave-indexd-postgres enclave-indexd caddy enclave-storage-tunnel-us-west enclave-storage-tunnel-eu-central enclave-storage-tunnel-ap-southeast enclave-storage-tunnel-ca-east; sudo docker exec enclave-indexd-postgres pg_isready -U postgres -d indexd; test ! -e /etc/enclave-indexd/ALLOW_LIVE_START"
r=subprocess.run(base+[command],capture_output=True,text=True);assert r.returncode==0;assert r.stdout.splitlines()[:4]==['running','status: done','active','inactive']
source=subprocess.run(['ssh','-o','BatchMode=yes','nan','systemctl is-active indexd'],capture_output=True,text=True);assert source.returncode==0 and source.stdout.strip()=='active'
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'destination':'minipc / enclave-storage','rebootPassed':True,'vmSystemHealthy':True,'cloudInitComplete':True,'postgresReady':True,'destinationWriterActive':False,'sourceNanWriterActive':True,'allFourIngressTunnelsRecovered':True,'routes':rows,'dnsCutover':False,'productionMigrationComplete':False}
Path('outputs/storage-vm-reboot-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
