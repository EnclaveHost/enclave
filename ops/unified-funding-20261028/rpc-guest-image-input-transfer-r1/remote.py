import pathlib,sys,os,time,hashlib,json
root=pathlib.Path('/home/controladmin/rpc-guest-image-20261031-r1')
assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
assert 0<=time.time()-1793439615.6557317<=300
origin=time.monotonic();root.mkdir(mode=0o700)
def guard():
 mem=next(int(x.split()[1])*1024 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
 v=os.statvfs(root)
 assert mem>=2*1024**3 and v.f_bavail*v.f_frsize>=16*1024**3 and time.monotonic()-origin<150
for row in [{'name': 'source.qcow2', 'bytes': 621284352, 'sha256': '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'}, {'name': 'runtime.tar', 'bytes': 397926400, 'sha256': '3f0bb020ee6c8b67217c55b4bd0208dd1a6c83ed76df21dbfdf34c6daa718e6c'}, {'name': 'bundle.json', 'bytes': 2694, 'sha256': 'b347c8ca66c6fc7ed5adaab31a469f509828524bda50eaaef79a3b60bd205b6a'}, {'name': 'inject_image.py', 'bytes': 11398, 'sha256': 'ef130ca34e4e6df3efd445a39f7e08c740d5dcb0fd1b15620078908bdf595378'}, {'name': 'config.json', 'bytes': 1061, 'sha256': '160a0f0b43a88a5b4a31cd54bbcf9185e55501966147e7c70c817ceac762e939'}]:
 guard();left=row['bytes'];h=hashlib.sha256()
 with (root/row['name']).open('xb') as f:
  while left:
   guard();b=sys.stdin.buffer.read(min(left,1024**2));assert b;f.write(b);h.update(b);left-=len(b)
  f.flush();os.fsync(f.fileno())
 assert h.hexdigest()==row['sha256'];os.chmod(root/row['name'],0o400)
print(json.dumps({'root':str(root),'files':[dict(name=r['name'],bytes=r['bytes'],sha256=r['sha256']) for r in [{'name': 'source.qcow2', 'bytes': 621284352, 'sha256': '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'}, {'name': 'runtime.tar', 'bytes': 397926400, 'sha256': '3f0bb020ee6c8b67217c55b4bd0208dd1a6c83ed76df21dbfdf34c6daa718e6c'}, {'name': 'bundle.json', 'bytes': 2694, 'sha256': 'b347c8ca66c6fc7ed5adaab31a469f509828524bda50eaaef79a3b60bd205b6a'}, {'name': 'inject_image.py', 'bytes': 11398, 'sha256': 'ef130ca34e4e6df3efd445a39f7e08c740d5dcb0fd1b15620078908bdf595378'}, {'name': 'config.json', 'bytes': 1061, 'sha256': '160a0f0b43a88a5b4a31cd54bbcf9185e55501966147e7c70c817ceac762e939'}]],'seconds':time.monotonic()-origin,'invocation':os.environ.get('INVOCATION_ID')}))
