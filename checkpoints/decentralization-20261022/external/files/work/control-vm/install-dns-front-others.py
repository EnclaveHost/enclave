import subprocess
for h in ['eu-central','ap-southeast','ca-east']:
 cmd='if ! command -v dnsdist >/dev/null; then systemctl mask dnsdist.service && apt-get update -qq && DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq dnsdist; fi'
 r=subprocess.run(['ssh',h,cmd],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:]
 subprocess.run(['python3','work/control-vm/prepare-dns-front.py',h],check=True)
 print(h+': installed and prepared',flush=True)
