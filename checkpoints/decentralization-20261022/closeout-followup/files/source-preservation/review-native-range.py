"""Scan an immutable candidate range; classify every finding or refuse publication."""
from pathlib import Path
import hashlib, importlib.util, json, re, subprocess, sys
root=Path(__file__).resolve().parents[3]; base=root/'work/resume-after-checkpoint-20261022'; repo=base/'native-front-abort/repo'
start='ca3118202359da8ce84f5b917fcc5ed85b2c6730'; end=sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}',end)
span=start+'..'+end
out=base/'public-validation'/('native-range-'+end[:9]+'.json')
def git(*args):return subprocess.check_output(['git','-C',str(repo),*args])
spec=importlib.util.spec_from_file_location('scanner',repo/'.githooks/scan-crypto-keys.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
diff=git('log','--no-color','-p','-U0','--no-ext-diff','--diff-filter=AMCR','--format=commit:%H',span).decode()
findings=mod.scan_diff(diff.splitlines()); cache={}
def file(commit,path):
 key=(commit,path)
 if key not in cache:cache[key]=git('show',commit+':'+path).decode()
 return cache[key]
words=(repo/'.githooks/bip39-english.txt').read_text().strip(); assert len(words.splitlines())==2048
published=file(start,'metal/guest/platform-api.bundle.mjs')
def digest_reason(commit,line):
 m=re.search(r'"([^"]+)"\s*:\s*"([0-9a-f]{64})"',line);assert m
 try:data=git('show',commit+':'+m[1])
 except subprocess.CalledProcessError:data=(repo/m[1]).read_bytes()
 assert hashlib.sha256(data).hexdigest()==m[2]
 return 'Recomputed public source SHA256: '+m[1]
crypto=[]
for f in findings:
 text=file(f.commit,f.path);line=text.splitlines()[f.line-1];name=Path(f.path).name
 if f.rule=='mnemonic' and name=='platform-api.bundle.mjs':
  assert text.count(words)==1
  first=text[:text.index(words)].count('\n')+1;assert first<=f.line<first+2048
  assert ' '.join(f.value.split()) in ' '.join(words.splitlines())
  reason='Inside complete public BIP39 English dictionary'
 elif f.rule=='eth-key' and name=='platform-api.bundle.mjs':
  assert 'BOOK_KEY_REGISTRY' in line and bytes.fromhex(f.value).rstrip(b'\0')==b'registry'
  reason='Public AddressBook registry bytes32 label'
 elif f.rule=='eth-key' and name.endswith('.manifest.json'):reason=digest_reason(f.commit,line)
 else:raise AssertionError('Unclassified crypto finding '+f.rule+' '+f.path+':'+str(f.line))
 crypto.append({'commit':f.commit,'path':f.path,'line':f.line,'rule':f.rule,'classification':reason})
report=base/'source-preservation'/('gitleaks-native-'+end[:9]+'.json')
r=subprocess.run([str(Path.home()/'.local/bin/gitleaks'),'git',str(repo),'--config',str(repo/'.gitleaks.toml'),'--log-opts='+span,'--redact','--no-banner','--report-format','json','--report-path',str(report)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
assert r.returncode in (0,1),(r.returncode,r.stderr[-500:])
gitleaks=[]
for f in json.loads(report.read_text()):
 line=file(f['Commit'],f['File']).splitlines()[f['StartLine']-1];name=Path(f['File']).name
 if name.endswith('.manifest.json'):reason=digest_reason(f['Commit'],line)
 else:
  assert name=='platform-api.bundle.mjs' and f['RuleID'] in ('generic-api-key','ethereum-private-key-env'),(f['RuleID'],f['File'],f['StartLine'])
  if line in published:reason='Public code or registry label already in published candidate'
  elif re.fullmatch(r'var [A-Z_0-9, ]+;',line):reason='Bare generated identifier declaration, no assignment or value'
  else:
   norm=lambda v:re.sub(r'\b(app|fingerprint)\d+\b',r'\1',v)
   assert norm(line) in norm(published),(f['File'],f['StartLine'])
   reason='Published public code after normalizing bundler identifier suffixes'
 gitleaks.append({'commit':f['Commit'],'path':f['File'],'line':f['StartLine'],'rule':f['RuleID'],'classification':reason,'lineSha256':hashlib.sha256(line.encode()).hexdigest()})
result={'range':span,'diffSha256':hashlib.sha256(diff.encode()).hexdigest(),'cryptoFindings':len(crypto),'gitleaksFindings':len(gitleaks),'unclassified':0,'crypto':crypto,'gitleaks':gitleaks,'override':'Repository-documented confirmed-false-positive override; hooks unchanged'}
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ('crypto','gitleaks')}))
