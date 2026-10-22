from pathlib import Path
import json,subprocess
p=Path('work/control-vm');text=(p/'static-front-extra.caddy').read_text();a=text.index('    @sitecar {');b=text.index('    handle /site-root {');routes=[]
for i,r in enumerate(json.loads((p/'missing-pin-package/directories.json').read_text())):
 cid=r['cid'];root='/opt/enclave-site/'+cid
 for mode in ['car','raw','accept']:
  condition='header Accept *application/vnd.ipld.car*' if mode=='accept' else 'query format='+mode
  file='site-root.block' if mode=='raw' else 'site.car';mime='application/vnd.ipld.raw' if mode=='raw' else 'application/vnd.ipld.car'
  routes.append(f'''    @pin{i}{mode} {{
        path /ipfs/{cid}
        {condition}
    }}
    handle @pin{i}{mode} {{
        root * {root}
        rewrite * /{file}
        header Content-Type {mime}
        file_server
    }}
''')
 routes.append(f'''    handle_path /ipfs/{cid}/* {{
        root * {root}/site
        file_server
    }}
    handle /ipfs/{cid} {{
        redir /ipfs/{cid}/ permanent
    }}
''')
text=text[:a]+''.join(routes)+text[b:];(p/'static-front-all-pins.caddy').write_text(text)
for h in ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['scp','-q',str(p/'static-front-all-pins.caddy'),h+':/tmp/static-front-all-pins.caddy'],check=True)
 script='''from pathlib import Path
import subprocess,os,json
p=Path('/etc/enclave-bootstrap-tls');original=(p/'Caddyfile').read_text();assert 'www.enclave.host' not in original
c=p/'Caddyfile.site-prepared';c.write_text(original+Path('/tmp/static-front-all-pins.caddy').read_text())
r=subprocess.run(['caddy','validate','--config',str(c),'--adapter','caddyfile'],env=dict(os.environ,CREDENTIALS_DIRECTORY=str(p/'credentials')),capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:];print('Validated 123 directory roots')
'''
 r=subprocess.run(['ssh',h,'python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1000:];print(h+': '+r.stdout.strip(),flush=True)
