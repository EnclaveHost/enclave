from pathlib import Path
import os,subprocess
p=Path(__file__).resolve().parent;u=p.parent
e=os.environ.copy();e['PUBLIC_CODE_BUNDLE']=str(p/'live-observation-r2.json')
a=subprocess.run(['node','--test','--test-concurrency=1',str(u/'production-activation-qualification-r2/test/prepare.test.mjs'),str(u/'production-activation-qualification-r2/test/capture.test.mjs')],env=e)
if a.returncode:raise SystemExit(a.returncode)
raise SystemExit(subprocess.run(['node',str(u/'production-activation-prep-r1/prepare-activation.mjs'),'--pins',str(p/'prepare-pins-r1.json'),'--out',str(p/'prepared-r1')]).returncode)
