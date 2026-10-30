#!/usr/bin/env python3
"""Run the assembled control overlay's manager tests without any host calls."""
from pathlib import Path
import argparse,json,hashlib,subprocess,shutil,tempfile
from prepare import prepare,checked_path

def qualify(installed,node_modules,output):
    here=Path(__file__).resolve().parent
    if output.exists():raise ValueError('output already exists')
    with tempfile.TemporaryDirectory(prefix='native-control-tests-') as tmp:
        root=Path(tmp);prepared=root/'prepared'
        prepare(installed,here/'additions',prepared)
        manifest=json.loads((here/'manifest.json').read_text())
        test_manifest=json.loads((here/'qualification.json').read_text())
        runtime={x['path'] for group in ['modified','added','requiredUnchanged'] for x in manifest[group]}
        tree=root/'tree';tree.mkdir()
        for item in manifest['requiredUnchanged']:
            p=tree/item['path'];p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(installed/item['path'],p)
        shutil.copytree(prepared/'control',tree,dirs_exist_ok=True)
        for item in test_manifest['files']:
            if item['path'] in runtime:raise ValueError('test file overwrites runtime')
            b=checked_path(here/'qualification',item['path']).read_bytes()
            if len(b)!=item['bytes'] or hashlib.sha256(b).hexdigest()!=item['sha256']:raise ValueError('qualification file pin mismatch')
            p=checked_path(tree,item['path']);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
        for group in ['modified','added','requiredUnchanged']:
            for item in manifest[group]:
                b=checked_path(tree,item['path']).read_bytes()
                if hashlib.sha256(b).hexdigest()!=item.get('afterSha256',item.get('sha256')):
                    raise ValueError('assembled runtime pin mismatch: '+item['path'])
        (tree/'node_modules').symlink_to(node_modules.resolve(),target_is_directory=True)
        tests=sorted(str(p.relative_to(tree)) for p in (tree/'windows/vbslike/manager').glob('*.test.mjs'))
        result=subprocess.run(['node','--experimental-vm-modules','--test',*tests],cwd=tree,capture_output=True,text=True,timeout=120)
        output.mkdir();(output/'tests.log').write_text(result.stdout+result.stderr)
        report={'productionActivated':False,'testFiles':tests,'exitCode':result.returncode,'runtimeModules':len(runtime),'manifestSha256':hashlib.sha256((here/'manifest.json').read_bytes()).hexdigest(),
          'qualificationSha256':hashlib.sha256((here/'qualification.json').read_bytes()).hexdigest(),'nodeVersion':subprocess.check_output(['node','--version'],text=True).strip()}
        (output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report));return result.returncode

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--installed',type=Path,required=True);p.add_argument('--node-modules',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    raise SystemExit(qualify(a.installed.resolve(),a.node_modules.resolve(),a.output.absolute()))
