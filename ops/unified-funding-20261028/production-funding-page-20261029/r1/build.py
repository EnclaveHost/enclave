from pathlib import Path
import subprocess,json
p=Path(__file__).resolve().parent;u=p.parent;a=u/'production-cutover-addon-root-review-r1'
common=['--source',str(a/'overlay-r1'),'--config',str(p/'config.json'),'--existing-paths',str(u/'production-site-addon-r2/existing-live-paths.txt')]
subprocess.run(['node',str(a/'build.mjs'),'--propose-pins',*common,'--pins-out',str(p/'pins-proposed.json')],check=True)
j=json.loads((p/'pins-proposed.json').read_text());old=json.loads((a/'pins-disabled-reviewed-r1.json').read_text())
for k in ['inputs','liveInventory','liveSessionsVendor','existingPaths','esbuildVersion']:assert j[k]==old[k],k
j['reviewed']=True;(p/'pins-reviewed.json').write_text(json.dumps(j,indent=2)+'\n')
subprocess.run(['node',str(a/'build.mjs'),'--pins',str(p/'pins-reviewed.json'),*common,'--out',str(p/'artifact')],check=True)
