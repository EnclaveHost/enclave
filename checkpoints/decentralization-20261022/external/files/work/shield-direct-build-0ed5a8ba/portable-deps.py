from pathlib import Path
import json,subprocess,shutil,os
r=Path(__file__).resolve().parent;b=r/'portable';env=dict(os.environ,GOPROXY='off',GOSUMDB='off',GOTOOLCHAIN='local');cache=Path(subprocess.check_output(['go','env','GOMODCACHE'],text=True,env=env).strip());decoder=json.JSONDecoder();mods={}
for module,args in [('m2',['-tags','bootstrapdirect,shielddirect','./front']),('m3',['./monitor','./secretrun'])]:
 text=subprocess.check_output(['go','list','-deps','-json',*args],cwd=b/'source/isolation'/module,text=True,env=env)
 while text.strip():
  x,n=decoder.raw_decode(text.lstrip());text=text.lstrip()[n:]
  x=x.get('Module',{})
  if x.get('Version') and not x.get('Replace'):mods[x['Path']]=x
for x in mods.values():
 src=Path(x['Dir']);target=b/'go-modules'/src.relative_to(cache);shutil.copytree(src,target)
 # Include only the named public module's download cache; no credentials or sumdb state.
 origin=cache/'cache/download'/x['Path']/'@v';dest=b/'go-modules/cache/download'/x['Path']/'@v';dest.mkdir(parents=True,exist_ok=True)
 for suffix in ['.mod','.info','.ziphash','.zip']:
  p=origin/(x['Version']+suffix)
  if p.exists():shutil.copyfile(p,dest/p.name)
 print(x['Path'],x['Version'])
p=b/'compile.sh';s=p.read_text();s=s.replace('export CGO_ENABLED=0','export GOMODCACHE="$root/go-modules"\nexport CGO_ENABLED=0');p.write_text(s)
