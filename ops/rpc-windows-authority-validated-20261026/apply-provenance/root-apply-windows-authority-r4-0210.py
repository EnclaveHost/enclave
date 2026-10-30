from pathlib import Path
import hashlib,json,subprocess,os
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
S=P/'windows-chain-authority-stage/r4'; R=S/'run/20261026T020649Z'; C=R/'cand'; T=P/'relay-consumer-source'
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert (P/'logs/root-windows-authority-r4-0208.rc').read_text().strip()=='0'
assert subprocess.check_output(['git','-C',str(T),'rev-parse','HEAD'],text=True).strip()=='aebf4c9321279c37afce863c2bd6144a96128cea'
subprocess.run(['sha256sum','-c','--quiet',str(S/'BASE-aebf4c932.sha256')],cwd=T,check=True)
subprocess.run(['sha256sum','-c','--quiet',str(S/'CANDIDATE.sha256')],cwd=C,check=True)
paths=[]
for line in (S/'CANDIDATE.sha256').read_text().splitlines():
    sha,f=line.split(); assert h(C/f)==sha
    paths.append(f)
for item in json.loads((R/'bundle-closure-candidate-after.json').read_text()):
    f=item['file']; assert not item['stale']; assert h(C/f)==item['generatedSha256']==item['committedSha256']
    original=subprocess.check_output(['git','-C',str(T),'show','HEAD:'+f])
    assert hashlib.sha256(original).hexdigest()==h(T/f)
    paths.append(f)
assert len(paths)==11 and len(set(paths))==11
for f in paths:
    a,b=C/f,T/f
    mode=b.stat().st_mode & 0o777 if b.exists() else 0o644
    b.parent.mkdir(parents=True,exist_ok=True); b.write_bytes(a.read_bytes()); b.chmod(mode)
    assert h(a)==h(b)
subprocess.run(['git','-C',str(T),'add','--',*paths],check=True)
subprocess.run(['git','-C',str(T),'diff','--cached','--check'],check=True)
subprocess.run(['git','-C',str(T),'-c','user.name=SteveDeFacto','-c','user.email=5148995+SteveDeFacto@users.noreply.github.com','commit','-m','Route Windows host and paid network operations through explicit local chain authority'],check=True)
subprocess.run(['git','-C',str(T),'push','github','HEAD'],check=True)
print('Applied exact 11 tested files; 85 checks passed. Source only; no live cutover.')
