from pathlib import Path
import hashlib,subprocess
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
S=P/'consumer-cutover-remaining-20261026';T=P/'relay-consumer-source'
assert (P/'logs/root-credit-read-authority-0228.rc').read_text().strip()=='0'
assert (P/'logs/root-credit-bundle-0230.rc').read_text().strip()=='0'
assert subprocess.check_output(['git','-C',str(T),'rev-parse','HEAD'],text=True).strip()=='b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604'
subprocess.run(['sha256sum','-c','--quiet',str(S/'BASE-b6ac5d657.sha256')],cwd=T,check=True)
runs=list((S/'run').glob('*'));assert len(runs)==1
C=runs[0]/'cand';subprocess.run(['sha256sum','-c','--quiet',str(S/'CANDIDATE.sha256')],cwd=C,check=True)
paths=[]
for line in (S/'CANDIDATE.sha256').read_text().splitlines():
 sha,f=line.split();a,b=C/f,T/f
 assert hashlib.sha256(a.read_bytes()).hexdigest()==sha
 mode=b.stat().st_mode&0o777 if b.exists() else 0o644
 b.parent.mkdir(parents=True,exist_ok=True);b.write_bytes(a.read_bytes());b.chmod(mode)
 paths.append(f)
assert len(paths)==4
subprocess.run(['git','-C',str(T),'add','--',*paths],check=True)
subprocess.run(['git','-C',str(T),'diff','--cached','--check'],check=True)
subprocess.run(['git','-C',str(T),'-c','user.name=SteveDeFacto','-c','user.email=5148995+SteveDeFacto@users.noreply.github.com','commit','-m','Honor site release read authority on the credit page'],check=True)
subprocess.run(['git','-C',str(T),'push','github','HEAD'],check=True)
print('Exact4 tested files applied;31 checks and both actual credit bundle modes PASS; source only.')
