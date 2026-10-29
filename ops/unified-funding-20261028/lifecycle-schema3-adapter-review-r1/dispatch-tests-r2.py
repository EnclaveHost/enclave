from pathlib import Path
import subprocess
p=Path(__file__).resolve().parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo')
with (p/'queue-dispatch-r2.log').open('x') as log:
 r=subprocess.run(['python3',str(w/'work/claude-test-queue.py'),'--mib','512','--log',str(p/'test-queue-r2.log'),'--','node',str(w/'work/enclave/test/helpers/memory-guard.mjs'),'--max-rss-mib','450','--floor-available-mib','27648','--log',str(p/'test-guard-r2.log'),'--','python3',str(p/'run-schema3-adapter-r2.py')],stdout=log,stderr=subprocess.STDOUT,timeout=1620)
(p/'queue-dispatch-r2.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
