from pathlib import Path
import subprocess,json,datetime,hashlib
A=Path('work/linux-lease-root-release/activation')
files={'/etc/nan-relay/linux-leasegas-measurements.env':(A/'measurement.env').read_text(),'/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf':(A/'measurement-dropin.conf').read_text()}
script='''from pathlib import Path
import subprocess,json,os
files=FILES
for name in files:assert not Path(name).exists(), 'admission file already exists; inspect first'
assert subprocess.check_output(['systemctl','is-active','enclave-api-relay.service'],text=True).strip()=='active'
written=[]
try:
 for name,body in files.items():
  p=Path(name);p.write_text(body);p.chmod(0o644);written.append(p)
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=45)
 subprocess.run(['systemctl','is-active','--quiet','enclave-api-relay.service'],check=True)
 print('ADMISSION-INSTALLED API service active')
except BaseException:
 for p in written:
  assert p.read_text()==files[str(p)];p.unlink()
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=45)
 raise
'''.replace('FILES',repr(files))
args=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo -n python3 -']
r=subprocess.run(args,input=script,text=True,capture_output=True,timeout=60)
(A/'admission-apply.out').write_text(r.stdout+r.stderr)
print(r.stdout+r.stderr,end='')
if r.returncode:raise SystemExit(r.returncode)
d=json.loads((A/'admission.json').read_text());d.update(stage='installed; public endpoint recheck pending',installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),files={n:hashlib.sha256(b.encode()).hexdigest() for n,b in files.items()});(A/'admission.json').write_text(json.dumps(d,indent=2)+'\n')
