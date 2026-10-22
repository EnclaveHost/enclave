set -euo pipefail
python3 - <<'METADATA'
import grp,pwd,os,stat,json,subprocess
p='/etc/enclave-indexd/indexd.yml'
s=os.lstat(p);d=os.stat(os.path.dirname(p));g=grp.getgrnam('enclave-indexd');u=pwd.getpwnam('enclave-indexd')
unit=subprocess.run(['systemctl','show','enclave-indexd.service','--property=User,Group,SupplementaryGroups,ActiveState,ActiveEnterTimestamp'],capture_output=True,text=True,timeout=10,check=True)
print(json.dumps({'config':{'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),'regular':stat.S_ISREG(s.st_mode),'nlink':s.st_nlink},'directory':{'uid':d.st_uid,'mode':oct(stat.S_IMODE(d.st_mode))},'serviceUser':{'name':u.pw_name,'uid':u.pw_uid,'gid':u.pw_gid},'serviceGroup':{'name':g.gr_name,'gid':g.gr_gid,'members':g.gr_mem,'primaryUsers':sorted(x.pw_name for x in pwd.getpwall() if x.pw_gid==g.gr_gid)},'unit':dict(x.split('=',1) for x in unit.stdout.splitlines() if '=' in x)},indent=2))
METADATA
