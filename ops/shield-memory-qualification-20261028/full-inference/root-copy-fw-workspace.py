from pathlib import Path
import subprocess,json,hashlib
m=Path(__file__).resolve().parent
src=Path('/home/steven/.cache/enclave-isolation/fwbuild/src/edk2')
out=m/'fwbuild-candidate-r1';out.mkdir(exist_ok=False)
dst=out/'src';dst.mkdir()
head=subprocess.check_output(['git','-C',str(src),'rev-parse','HEAD'],text=True).strip()
if head!='2970e5699ba6267f3384ffab20f96647578aebc8':raise SystemExit('original revision drift')
status=subprocess.check_output(['git','-C',str(src),'status','--porcelain'],text=True)
if status.strip()!='M OvmfPkg/AmdSev/Grub/grub.sh':raise SystemExit('unexpected source changes')
patch=subprocess.check_output(['git','-C',str(src),'diff','--','OvmfPkg/AmdSev/Grub/grub.sh'])
(out/'original-grub.patch').write_bytes(patch)
subprocess.run(['/home/steven/.local/bin/rsync','-a','--exclude=.git','--exclude=Build','--exclude=__pycache__','--exclude=Conf/BuildEnv.sh',str(src)+'/',str(dst)+'/'],check=True)
# Generated absolute-path setup must not refer to original workspace.
if (dst/'Conf/BuildEnv.sh').exists():raise SystemExit('original environment copied')
(out/'COPY.json').write_text(json.dumps({'head':head,'dirty':status,'grub_patch_sha256':hashlib.sha256(patch).hexdigest(),'source':str(src),'copy':str(dst)},indent=2)+'\n')
print('Isolated workspace copied; original untouched')
