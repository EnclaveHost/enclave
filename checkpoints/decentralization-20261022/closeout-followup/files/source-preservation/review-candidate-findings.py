import hashlib,json,pathlib,re,subprocess
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo');base=root/'work/resume-after-checkpoint-20261022';repo=root/'work/source-checkpoint-20261022/main-repo';tree=base/'measured-composition/tree-c';sha='6f2c7da466dc26e5f7aac88c574a6b807e1a03df'
report=(base/'source-preservation/candidate-crypto.out').read_text();findings=re.findall(r'\[(eth-key|mnemonic)\] 6f2c7da466 ([^:]+):(\d+):',report);assert len(findings)==194
files={};verified=[];digests={}
for m in ['metal/guest/mcp-server.bundle.mjs.manifest.json','metal/guest/platform-api.bundle.mjs.manifest.json','network/host-services/packages/credit-vault-submitter.package.json']:
 obj=json.loads((tree/m).read_text())
 for rel,h in obj.get('inputs',{}).items():
  p=tree/rel
  if re.fullmatch('[0-9a-f]{64}',h) and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==h:digests[h]=rel
words=(repo/'.githooks/bip39-english.txt').read_text().strip();assert len(words.splitlines())==2048
for rule,file,n in findings:
 if file not in files:files[file]=subprocess.check_output(['git','show',sha+':'+file],cwd=repo).decode()
 text=files[file];line=int(n);content=text.splitlines()[line-1]
 if rule=='mnemonic':
  assert text.count(words)==1,(file,'wordlist occurrence')
  start=text[:text.index(words)].count('\n')+1;end=start+2047
  assert start<=line<=end,(file,line,start,end)
  why='Inside the exact complete public BIP39 English dictionary (2048 words); not a generated wallet phrase'
 else:
  hs=re.findall(r'(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])',content);assert len(hs)==1,(file,line);h=hs[0].lower()
  if file=='contracts/EnclaveServiceIndex.sol':
   assert int(h,16)==int('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',16)//2;why='Public secp256k1 group-order half constant'
  elif file.endswith('.bundle.mjs'):
   assert bytes.fromhex(h).rstrip(b'\0')==b'registry' and re.search(r'BOOK_KEY_REGISTRY\s*=',content);why='Public bytes32 address-book key for registry'
  else:
   assert h in digests,(file,line,h);why='Independently recomputed public source SHA256: '+digests[h]
 verified.append({'rule':rule,'file':file,'line':line,'classification':why})
r={'commit':sha,'findings':len(findings),'allVerifiedPublicConstantsOrSourceDigests':True,'verified':verified,'gitleaks':'separate scan required; not claimed here','override':'Repository-documented confirmed-false-positive override only; hooks remain enabled.'}
(base/'source-preservation/CANDIDATE-CRYPTO-REVIEW.json').write_text(json.dumps(r,indent=2)+'\n');print('Verified all',len(findings),'findings')
