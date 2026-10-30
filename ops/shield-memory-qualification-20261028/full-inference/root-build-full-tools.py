from pathlib import Path
import os,subprocess,hashlib,json,shutil
m=Path(__file__).resolve().parent
out=m/'full-tools-build-r1';out.mkdir(exist_ok=False)
iso=Path('/home/steven/enclave-prod/iso-sdshield-1c3cdbb8')
env=dict(os.environ,CGO_ENABLED='0',GOMAXPROCS='1',GOPROXY='off',GOTOOLCHAIN='local')
subprocess.run(['go','build','-p','1','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',str(out/'bundletool'),'./cmd/bundle'],cwd=iso/'isolation/contract',env=env,check=True)
shutil.copy2(iso/'isolation/m2/fwd/main.go',out/'fwd-main.go')
subprocess.run(['go','build','-p','1','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',str(out/'fwd'),'./fwd'],cwd=iso/'isolation/m2',env=env,check=True)
pins={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [out/'bundletool',out/'fwd',out/'fwd-main.go',iso/'isolation/contract/cmd/bundle/main.go']}
(out/'BUILD.json').write_text(json.dumps(pins,indent=2)+'\n')
print('Offline bundle and loopback-forwarder tools built; no guest or GPU started')
