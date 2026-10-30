from pathlib import Path
import subprocess,json,hashlib,shutil,difflib,os
m=Path(__file__).resolve().parent;c=m/'firmware-candidate';out=m/'fwbuild-candidate-r1';dst=out/'src'
if (m/'claude-firmware-candidate.rc').read_text().strip()!='0':raise SystemExit('Claude task not successful')
if (out/'PREPARE.json').exists():raise SystemExit('already prepared')
paths=['OvmfPkg/PlatformPei/AmdSev.c','OvmfPkg/PlatformPei/PlatformPei.inf']
original={p:(dst/p).read_bytes() for p in paths}
for p in paths:(dst/p).write_bytes(original[p].replace(b'\r\n',b'\n'))
patch=(c/'CHANGE.patch').read_text();patch=patch[patch.index('--- a/'):]
for extra in (['--dry-run'],[]):
 subprocess.run(['patch','--fuzz=0','-p1',*extra],input=patch,text=True,cwd=dst,check=True)
shutil.copy2(c/'src/OvmfPkg/PlatformPei/SnpBootWindow.h',dst/'OvmfPkg/PlatformPei/SnpBootWindow.h')
# Original files retain original CRLF style; generated patch is normalized text for review.
diff=''.join(''.join(difflib.unified_diff(original[p].decode().replace('\r\n','\n').splitlines(True),(dst/p).read_text().splitlines(True),fromfile='a/'+p,tofile='b/'+p)) for p in paths)
(out/'applied.patch').write_text(diff)
for p in paths:(dst/p).write_bytes((dst/p).read_bytes().replace(b'\n',b'\r\n'))
test=c/'tests/test_snp_boot_window.c'
subprocess.run(['cc','-include','stddef.h','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(dst/'OvmfPkg/PlatformPei'),'-o',str(out/'snpwin-test'),str(test)],check=True)
subprocess.run([str(out/'snpwin-test')],check=True)
(out/'PREPARE.json').write_text(json.dumps({'files':{p:hashlib.sha256((dst/p).read_bytes()).hexdigest() for p in paths+['OvmfPkg/PlatformPei/SnpBootWindow.h']},'test_sha256':hashlib.sha256(test.read_bytes()).hexdigest(),'original':{p:hashlib.sha256(b).hexdigest() for p,b in original.items()}},indent=2)+'\n')
