from pathlib import Path
import os,json,time,ipaddress,re,base64
from capture_local import capture
p=Path(__file__).resolve().parent;assert os.sched_getaffinity(0)=={1}
with(p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'readOnly':True},f)
result={'readOnly':True,'admitted':False}
def call(label,argv,seconds):
 r=capture(argv,seconds,limit=65536);result[label]=r;(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');assert r['rc']==0 and not r['reason'] and not r['truncated'],label;return r['stdout']
route=json.loads(call('localRoute',['/usr/bin/ip','-j','route','get','192.168.8.238'],3));assert len(route)==1
src=str(ipaddress.IPv4Address(route[0]['prefsrc']));dev=route[0]['dev'];assert re.fullmatch('[a-zA-Z0-9_.:-]{1,32}',dev)
call('localAddress',['/usr/bin/ip','-j','address','show','dev',dev],3)
result['sourceIp']=src;result['interface']=dev;result['linkMetadata']={}
for n in ('speed','duplex','mtu','operstate'):
 try:result['linkMetadata'][n]=(Path('/sys/class/net')/dev/n).read_text()[:128].strip()
 except OSError:result['linkMetadata'][n]=None
ps=(p/'windows.ps1').read_text().replace('__SOURCE_IP__',src);arg='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(ps.encode('utf-16le')).decode()
ssh=['/usr/bin/ssh','-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none']
call('windowsTopology',ssh+['minipc',arg],15)
ref=ssh+['-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc','-oHostKeyAlias=[127.0.0.1]:32423','-oUserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','controladmin@172.17.28.159','/usr/bin/timeout 3 /usr/sbin/ip -j route get '+src]
call('controlReferenceRoute',ref,10)
result['completedAt']=time.time();(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
