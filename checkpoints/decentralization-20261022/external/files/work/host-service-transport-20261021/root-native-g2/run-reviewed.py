import pathlib,hashlib,tarfile,io,subprocess,json,datetime
base=pathlib.Path(__file__).resolve().parent; src=base.parent/'native-g2'
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert h(base.parent/'tree/network/wg-provider/kernel.mjs')=='d5fd0e98a24ba5ce09605452682f443fc49e6c928da5b8db2715e87f521a88e5'
files=['MANIFEST.sha256','frozen/SHA256SUMS']
for manifest,prefix in [(src/'MANIFEST.sha256',''),(src/'frozen/SHA256SUMS','frozen/')]:
 for line in manifest.read_text().splitlines():
  digest,name=line.split('  ',1);rel=prefix+name;p=src/rel
  assert p.is_file() and not p.is_symlink() and h(p)==digest,(rel,'drift')
  assert '..' not in pathlib.PurePosixPath(rel).parts and not rel.startswith('/')
  files.append(rel)
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w:gz') as tf:
 for f in sorted(set(files)):tf.add(src/f,arcname=f,recursive=False)
script=r'''set -eu
[ "$(id -u)" = 0 ]
d=$(mktemp -d /var/tmp/enclave-native-g2-root-XXXXXXXX)
cleanup(){ case "$d" in /var/tmp/enclave-native-g2-root-*) rm -rf -- "$d";; *) exit 8;; esac; test ! -e "$d" && echo ROOT_STAGE_CLEANED; }
trap cleanup EXIT
umask 077
tar -xzf - -C "$d"
echo ROOT_HOST_BEFORE
ip -o link show | cut -d: -f1,2
systemctl show enclave-public-directory -p MainPID -p ActiveState
set +e
bash "$d/run.sh" --allow-module-autoload
rc=$?
set -e
echo ROOT_HOST_AFTER
ip -o link show | cut -d: -f1,2
systemctl show enclave-public-directory -p MainPID -p ActiveState
systemctl list-units --no-legend --all 'enclave-native-g2-*'
echo "ROOT_NATIVE_EXIT=$rc"
exit "$rc"
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','ca-east',script],input=buf.getvalue(),capture_output=True,timeout=110)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':'ca-east','kernelSourceSha256':h(base.parent/'tree/network/wg-provider/kernel.mjs'),'harnessManifestSha256':h(src/'MANIFEST.sha256'),'frozenManifestSha256':h(src/'frozen/SHA256SUMS'),'exit':r.returncode,'stdout':r.stdout.decode(errors='replace'),'stderr':r.stderr.decode(errors='replace')}
(base/'receipt.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2));raise SystemExit(r.returncode)
