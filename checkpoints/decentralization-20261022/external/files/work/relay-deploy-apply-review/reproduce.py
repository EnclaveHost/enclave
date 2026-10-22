import pathlib,tempfile,subprocess,os,json,hashlib
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/relay-deploy-apply-review')
source=root/'original-deploy.sh'
s=source.read_text();start=s.index("APPLY='")+len("APPLY='");end=s.index("'\napply()",start);apply=s[start:end]
with tempfile.TemporaryDirectory(prefix='case-',dir=root) as t:
 p=pathlib.Path(t);live=p/'live';stage=p/'stage';bins=p/'bin'
 for d in [live,stage,bins,live/'node_modules',stage/'node_modules']:d.mkdir(parents=True,exist_ok=True)
 (live/'foo.mjs').write_text('original\n');(live/'node_modules/kept.txt').write_text('original dependency\n');(stage/'foo.mjs').write_text('replacement\n');(stage/'node_modules/new.txt').write_text('new dependency\n');(stage/'.deploy-manifest').write_text(hashlib.sha256((stage/'foo.mjs').read_bytes()).hexdigest()+'  foo.mjs\n')
 (bins/'cp').write_text('#!/bin/bash\nfor arg in "$@"; do if [ "$arg" = "$FAIL_COPY_SOURCE" ]; then echo "injected apply copy failure" >&2; exit 61; fi; done\nexec /bin/cp "$@"\n')
 for name in ['systemctl','journalctl']:(bins/name).write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nexit 0\n')
 for f in bins.iterdir():f.chmod(0o755)
 env={**os.environ,'PATH':str(bins)+':/usr/bin:/bin','FAIL_COPY_SOURCE':str(stage/'foo.mjs'),'CALL_LOG':str(p/'calls')}
 r=subprocess.run(['bash','-c',apply,'apply',str(live),str(stage),'test-unit','test-run','0'],env=env,capture_output=True,text=True,timeout=10)
 result={'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'exit':r.returncode,'oldSourcePresent':(live/'foo.mjs').read_text()=='original\n','oldDependencyPresent':(live/'node_modules/kept.txt').exists(),'systemctlCalls':(p/'calls').read_text() if (p/'calls').exists() else '', 'stderr':r.stderr}
 (root/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
 assert r.returncode==61 and result['oldSourcePresent'] and not result['oldDependencyPresent'] and not result['systemctlCalls'], 'negative-control reproduction changed; review current source'
