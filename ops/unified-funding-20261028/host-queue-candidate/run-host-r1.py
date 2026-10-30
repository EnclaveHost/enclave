from pathlib import Path
import os, subprocess, json
p=Path(__file__).resolve().parent
m=json.loads((p/'host/HOST-STAGING.json').read_text())
if m['missing'] or m['unpinned']: raise SystemExit('host staging missing/unpinned')
env={k:os.environ[k] for k in ['HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG'] if k in os.environ}
env['PATH']='/home/steven/.foundry/bin:/home/steven/.local/bin:/usr/local/bin:/usr/bin:/bin'
env['SESSIONS_TEST_LOG']='1'
with (p/'legacy-host-r1.txt').open('x') as out:
 r=subprocess.run(['node','--test','--test-concurrency=1','test/sessions.test.mjs'],cwd=p/'host',env=env,stdout=out,stderr=subprocess.STDOUT,timeout=600)
(p/'LEGACY-HOST-r1.json').write_text(json.dumps({'exitCode':r.returncode,'network':'local anvil31337','nativeP256Required':True,'productionSigning':False})+'\n')
raise SystemExit(r.returncode)
