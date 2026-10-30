from pathlib import Path
import subprocess,json
p=Path(__file__).resolve().parent;u=p.parent;a=u/'funding-expiry-page-r1'
common=['--source',str(p/'overlay'),'--config',str(p/'config.json'),'--existing-paths',str(u/'production-site-addon-r2/existing-live-paths.txt')]
subprocess.run(['node',str(p/'build.mjs'),'--propose-pins',*common,'--pins-out',str(p/'pins-proposed.json')],check=True)
j=json.loads((p/'pins-proposed.json').read_text());old=json.loads((a/'pins-reviewed.json').read_text())
changed=[k for k,v in j['inputs'].items() if old['inputs'].get(k)!=v]
assert set(changed)=={'site/js/pages/funding.js'},changed
for k in ['liveInventory','liveSessionsVendor','existingPaths','esbuildVersion']:assert j[k]==old[k],k
assert j['config']==json.loads((u/'funding-live-page-r2/pins-reviewed.json').read_text())['config']
j['reviewed']=True;(p/'pins-reviewed.json').write_text(json.dumps(j,indent=2)+'\n')
subprocess.run(['node',str(p/'build.mjs'),'--pins',str(p/'pins-reviewed.json'),*common,'--out',str(p/'artifact')],check=True)
