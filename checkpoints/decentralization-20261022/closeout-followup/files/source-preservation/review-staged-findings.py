from pathlib import Path
import importlib.util,subprocess,json,hashlib,re,datetime
root=Path(__file__).resolve().parents[3]
repo=root/'work/source-checkpoint-20261022/main-repo'
live=root/'work/resume-after-checkpoint-20261022/native-control-attested/repo'
spec=importlib.util.spec_from_file_location('scanner',repo/'.githooks/scan-crypto-keys.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
diff=subprocess.check_output(['git','-C',str(repo),'diff','--cached','-U0','--no-ext-diff'],text=True)
findings=mod.scan_diff(diff.splitlines())
wordfile=live/'node_modules/@scure/bip39/wordlists/english.js'
if not wordfile.exists():wordfile=live/'node_modules/@scure/bip39/esm/wordlists/english.js'
wordsrc=wordfile.read_text()
words=re.search(r'abandon\nability\nable\n[\s\S]*?\nzoo',wordsrc).group().splitlines()
assert len(words)==2048
phrase=' '.join(words)
entries=[]
for f in findings:
 p=repo/f.path; line=p.read_text().splitlines()[f.line-1]; kind=None
 if f.rule=='mnemonic' and p.name=='platform-api.bundle.mjs':
  assert ' '.join(f.value.split()) in phrase
  text=p.read_text(); start=text.rfind('wordlist',0,sum(len(x)+1 for x in text.splitlines()[:f.line]))
  assert start>=0
  assert 'abandon\nability\nable\n' in text[max(0,start-100):start+200]
  kind='Contiguous slice of complete public BIP39 English dictionary'
 elif f.rule=='eth-key' and p.name=='platform-api.bundle.mjs':
  assert 'BOOK_KEY_REGISTRY' in line and bytes.fromhex(f.value).rstrip(b'\0')==b'registry'
  kind='Public AddressBook bytes32 registry label'
 elif f.rule=='eth-key' and p.name=='platform-api.bundle.mjs.manifest.json':
  m=re.search(r'"([^"]+)"\s*:\s*"([0-9a-f]{64})"',line);assert m and m[2]==f.value
  src=live/m[1];assert hashlib.sha256(src.read_bytes()).hexdigest()==m[2]
  kind='Recomputed SHA256 of public dependency source '+m[1]
 else:raise AssertionError('Unclassified finding '+str(f))
 entries.append({'file':f.path,'line':f.line,'rule':f.rule,'classification':kind,'valueSha256':hashlib.sha256(f.value.encode()).hexdigest()})
out=root/'work/resume-after-checkpoint-20261022/public-validation/source-scan-review.json'
out.write_text(json.dumps({'reviewedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stagedDiffSha256':hashlib.sha256(diff.encode()).hexdigest(),'count':len(entries),'unclassified':0,'entries':entries},indent=2)+'\n')
print('Reviewed',len(entries),'findings; no unclassified values; public dictionary/label/source digests only')
