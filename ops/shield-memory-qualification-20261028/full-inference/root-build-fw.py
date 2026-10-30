from pathlib import Path
import os,sys,subprocess,json,hashlib,shutil,time
m=Path(__file__).resolve().parent;out=m/'fwbuild-candidate-r1';dst=out/'src'
mode=sys.argv[1]
if mode not in ('base-release','candidate-release','candidate-debug'):raise SystemExit('invalid mode')
if mode.startswith('candidate')!=(out/'PREPARE.json').exists():raise SystemExit('source phase mismatch')
report=out/(mode+'.json')
if report.exists():raise SystemExit('already built')
# Preflight original release and source pins, separate output only.
rel=Path('/home/steven/enclave-prod/release-5cab66e4/firmware.fd')
if hashlib.sha256(rel.read_bytes()).hexdigest()!='142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9':raise SystemExit('original firmware drift')
env=dict(os.environ,WORKSPACE=str(dst),EDK_TOOLS_PATH=str(dst/'BaseTools'),CONF_PATH=str(dst/'Conf'),PYTHON_COMMAND='python3')
env['PATH']='/home/steven/.cache/enclave-isolation/fwbuild/tools/bin:'+env['PATH']
for k in ('PACKAGES_PATH','EDK_TOOLS_BIN'):env.pop(k,None)
target='DEBUG' if mode.endswith('debug') else 'RELEASE'
cmd='. ./edksetup.sh BaseTools && build -p OvmfPkg/AmdSev/AmdSevX64.dsc -a X64 -t GCC -b '+target+' -n 1'
start=time.time()
with (out/(mode+'.log')).open('w') as log:
 r=subprocess.run(['bash','-c',cmd],cwd=dst,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1500)
if r.returncode:raise SystemExit(r.returncode)
files=list((dst/'Build').glob('**/'+target+'_GCC/FV/OVMF.fd'))
if len(files)!=1:raise SystemExit('ambiguous firmware output '+str(files))
fw=out/('OVMF.'+mode+'.fd');shutil.copy2(files[0],fw)
record={'mode':mode,'firmware':str(fw),'sha256':hashlib.sha256(fw.read_bytes()).hexdigest(),'bytes':fw.stat().st_size,'elapsed_sec':time.time()-start,'command':cmd,'source_copy':json.loads((out/'COPY.json').read_text()),'production_unchanged':hashlib.sha256(rel.read_bytes()).hexdigest()=='142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9'}
report.write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,indent=2))
