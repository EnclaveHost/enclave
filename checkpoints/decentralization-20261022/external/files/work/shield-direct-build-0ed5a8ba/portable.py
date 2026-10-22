from pathlib import Path
import json,hashlib,shutil,subprocess
r=Path(__file__).resolve().parent;b=r/'portable';b.mkdir(exist_ok=False);(b/'inputs/objects').mkdir(parents=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
original=Path('/home/steven/Projects/enclave-pkg41/windows/vbslike/pkg/drafts/nucbox-ownguest-41.json');m=json.loads(original.read_text());u=m['rebuild']['vbsLinux1539'];ud=m['rebuild']['vbsLinux1539Debug']
names={u['igvmfilegen'],u['manifest'],u['vbsJson'],u['twin']['manifest'],u['twin']['expectVbsJson']}|set(u['resources'].values())|set(u['twin']['resources'].values())|set(ud['resources'].values());inputs=[]
for i in m['inputs']:
 if i['name'] not in names:continue
 p=Path(i['from']['file']).expanduser();assert sha(p)==i['sha256'];dest=b/'inputs/objects'/i['sha256'];shutil.copyfile(p,dest)
 inputs.append({'name':i['name'],'sha256':i['sha256'],'from':{'file':'objects/'+i['sha256']}})
assert {i['name'] for i in inputs}==names
recipe={'sourceRecipeSha256':sha(original),'inputs':inputs,'files':[f for f in m['files'] if f['path']==u['output'][5:]],'rebuild':{k:m['rebuild'][k] for k in ['vbsLinux1539','vbsLinux1539Debug']}}
recipe['rebuild']['g4probe']={k:m['rebuild']['g4probe'][k] for k in ['mustContain','mustNotContain']};(b/'inputs/recipe.json').write_text(json.dumps(recipe,indent=2)+'\n')
extra={'runtime-baseline.cpio.gz':Path('/home/steven/enclave-bench/nucbox-public-web-20261005/runtime-public-web.cpio.gz'),'kernel-vtpm.elf':Path('/home/steven/enclave-bench/nucbox-shield-20260929/kernel-vtpm.elf'),'openhcl-shield.cpio.gz':Path('/home/steven/enclave-bench/nucbox-shield-20260929/openhcl-shield.cpio.gz')}
for name,p in extra.items():shutil.copyfile(p,b/'inputs'/name)
shutil.copyfile(r/'source.tar',b/'source.tar');(b/'source').mkdir();subprocess.run(['tar','-C',str(b/'source'),'-xf',str(b/'source.tar')],check=True)
shutil.copyfile(r/'compile.sh',b/'compile.sh')
s=(r/'pack.py').read_text().replace("Path('/home/steven/enclave-bench/nucbox-public-web-20261005/runtime-public-web.cpio.gz')","root/'inputs/runtime-baseline.cpio.gz'");(b/'pack.py').write_text(s)
s=(r/'build-image.mjs').read_text().replace('const V = "/home/steven/Projects/enclave-pkg41/windows/vbslike/pkg/drafts/nucbox-ownguest-41.json";', 'const V = new URL("./inputs/recipe.json", import.meta.url).pathname;').replace('const home = (p) => p.replace(/^~/, os.homedir());','const home = (p) => path.resolve(path.dirname(V), p);')
s=s.replace('recipeManifest: sha(fs.readFileSync(V)),','recipeManifest: sha(fs.readFileSync(V)), sourceRecipeManifest: m.sourceRecipeSha256,');(b/'build-image.mjs').write_text(s)
shutil.copyfile(r/'runtime.json',b/'runtime.json');shutil.copyfile(r/'initrd-build.json',b/'expected-initrd.json')
expected=json.loads((r/'image/vbs-linux-c7084346/BUILD.json').read_text());(b/'expected-image.json').write_text(json.dumps(expected['candidate'],indent=2)+'\n')
manifest={'format':'enclave-shield-direct-build-inputs/1','sourceCommit':'0ed5a8ba','sourceRecipeSha256':sha(original),'candidateSha256':expected['candidate']['binSha'],'files':[{'path':str(p.relative_to(b)),'sha256':sha(p),'bytes':p.stat().st_size} for p in sorted(b.rglob('*')) if p.is_file()]}
(b/'INPUTS.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'bundle':str(b),'files':len(manifest['files']),'totalBytes':sum(x['bytes'] for x in manifest['files'])}))
