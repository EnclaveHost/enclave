from pathlib import Path
import tempfile,shutil,subprocess,json
r=Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='enclavedns-root-race-',dir=r) as d:
 t=Path(d)/'tree';shutil.copytree(r/'tree',t,symlinks=True)
 shutil.copyfile(r/'server.mjs.before',t/'windows/vbslike/manager/server.mjs')
 p=subprocess.run(['node','--test','--test-name-pattern=survey snapshot taken mid-start','windows/vbslike/manager/liveness.test.mjs'],cwd=t,capture_output=True,text=True,timeout=20)
 (r/'root-race-before.out').write_text(p.stdout+p.stderr)
 assert p.returncode!=0 and '# fail 1' in p.stdout and 'a record without a handle when the survey began is not judged by it' in p.stdout,p.stdout+p.stderr
 print(p.stdout)
 print('EXPECTED_OLD_RACE_REPRODUCED')
