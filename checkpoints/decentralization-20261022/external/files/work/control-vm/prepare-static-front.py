from pathlib import Path
import json,subprocess,os,sys
base=Path('work/control-vm');cid=json.loads((base/'website-manifest.json').read_text())['cid']
headers=json.loads((base/'site-security-headers.json').read_text());names=['enclave.host','www.enclave.host','ipfs.enclave.host']
keep=['Content-Security-Policy','Cross-Origin-Opener-Policy','Permissions-Policy','Referrer-Policy','Strict-Transport-Security','X-Content-Type-Options']
security='\n'.join('        '+k+' '+json.dumps(headers[k][0]) for k in keep)
root='/opt/enclave-site/'+cid
extra='''
enclave.host {
    bind 127.0.0.1
    tls {$CREDENTIALS_DIRECTORY}/enclave.host.crt {$CREDENTIALS_DIRECTORY}/enclave.host.key
    header {
SECURITY
    }
    encode zstd gzip
    @install path /install.sh /install.ps1
    handle @install {
        root * ROOT/installers
        header Content-Type "text/plain; charset=utf-8"
        file_server
    }
    handle {
        root * ROOT/site
        file_server
    }
    handle_errors {
        root * ROOT/site
        rewrite * /404.html
        file_server
    }
}
www.enclave.host {
    bind 127.0.0.1
    tls {$CREDENTIALS_DIRECTORY}/www.enclave.host.crt {$CREDENTIALS_DIRECTORY}/www.enclave.host.key
    redir https://enclave.host{uri} permanent
}
ipfs.enclave.host {
    bind 127.0.0.1
    tls {$CREDENTIALS_DIRECTORY}/ipfs.enclave.host.crt {$CREDENTIALS_DIRECTORY}/ipfs.enclave.host.key
    header {
        Access-Control-Allow-Origin *
        X-Content-Type-Options nosniff
        Content-Security-Policy "default-src 'none'; sandbox"
    }
    @sitecar {
        path /ipfs/CID
        query format=car
    }
    handle @sitecar {
        root * ROOT
        rewrite * /site.car
        header Content-Type application/vnd.ipld.car
        file_server
    }
    @siteraw {
        path /ipfs/CID
        query format=raw
    }
    handle @siteraw {
        root * ROOT
        rewrite * /site-root.block
        header Content-Type application/vnd.ipld.raw
        file_server
    }
    handle_path /ipfs/CID/* {
        root * ROOT/site
        file_server
    }
    handle /ipfs/CID {
        redir /ipfs/CID/ permanent
    }
    handle /site-root {
        root * ROOT
        rewrite * /site-root.txt
        header Content-Type "text/plain; charset=utf-8"
        file_server
    }
    @uploads path /add-wasm /add-json /add-image /healthz
    handle @uploads {
        reverse_proxy https://7ae476a3.app.enclave.host {
            header_up Host {upstream_hostport}
        }
    }
    handle /ipfs/* {
        reverse_proxy 127.0.0.1:8189 {
            @missing status 403 404 500 502 503 504
            handle_response @missing {
                reverse_proxy https://7ae476a3.app.enclave.host {
                    header_up Host {upstream_hostport}
                }
            }
        }
    }
    handle {
        respond 404
    }
}
'''.replace('SECURITY',security).replace('ROOT',root).replace('CID',cid)
# Static Caddy mirrors do not interpret the site's IPFS _redirects themselves.
pretty=subprocess.run(['node','work/enclave/scripts/network/site-pretty-routes.mjs'],check=True,capture_output=True,text=True).stdout
anchor='        root * '+root+'/site\n        file_server'
assert anchor in extra
extra=extra.replace(anchor,'        root * '+root+'/site\n'+''.join('        '+line+'\n' for line in pretty.splitlines())+'        file_server',1)
(base/'static-front-extra.caddy').write_text(extra)
sys.path.insert(0,'work/enclave/wasm');from ipfs_fetch import parse_car,cid_str_to_bytes
(base/'site-root.block').write_bytes(parse_car((base/'website.car').read_bytes())[cid_str_to_bytes(cid)])
script='''from pathlib import Path
import subprocess,os,json
base=Path('/etc/enclave-bootstrap-tls');active=base/'Caddyfile';candidate=base/'Caddyfile.site-prepared'
text=active.read_text();assert 'enclave.host {' not in text.replace('bootstrap-REGION.enclave.host {','')
candidate.write_text(text+Path('/tmp/static-front-extra.caddy').read_text());candidate.chmod(0o644)
unit=Path('/etc/systemd/system/enclave-bootstrap-tls.service').read_text();assert 'LoadCredential=' not in unit
loads=''.join('LoadCredential='+n+'.'+e+':/etc/enclave-bootstrap-tls/credentials/'+n+'.'+e+'\\n' for n in ['enclave.host','www.enclave.host','ipfs.enclave.host'] for e in ['crt','key'])
(base/'service.site-prepared').write_text(unit.replace('[Install]',loads+'[Install]'))
env=dict(os.environ,CREDENTIALS_DIRECTORY='/etc/enclave-bootstrap-tls/credentials');r=subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],env=env,capture_output=True,text=True)
assert r.returncode==0,r.stderr[-1200:];print(json.dumps({'prepared':True,'productionConfigChanged':False}))
'''
# prepare one provider at a time; service restart and provider routes are a later guarded step.
for host in sys.argv[1:]:
 assert host in ['us-west','eu-central','ap-southeast','ca-east']
 subprocess.run(['ssh','-o','BatchMode=yes',host,'install -d -m 0700 /etc/enclave-bootstrap-tls/credentials; install -d -m 0755 '+root+'/installers'],check=True)
 for n in names:
  for ext in ['crt','key']:
   source='/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/'+n+'/'+n+'.'+ext
   a=subprocess.Popen(['ssh','-o','BatchMode=yes','nan','cat',source],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
   b=subprocess.Popen(['ssh','-o','BatchMode=yes',host,'install -m 0600 /dev/stdin /etc/enclave-bootstrap-tls/credentials/'+n+'.'+ext],stdin=a.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);a.stdout.close();br=b.wait();ar=a.wait();assert ar==0 and br==0,'Certificate staging failed'
 for name in ['install.sh','install.ps1']:
  a=subprocess.Popen(['ssh','-o','BatchMode=yes','nan','cat','/opt/enclave-get/'+name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  b=subprocess.Popen(['ssh','-o','BatchMode=yes',host,'install -m 0644 /dev/stdin '+root+'/installers/'+name],stdin=a.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);a.stdout.close();br=b.wait();ar=a.wait();assert ar==0 and br==0
 subprocess.run(['scp','-q',str(base/'site-root.block'),str(base/'site-root.txt'),host+':'+root+'/'],check=True)
 subprocess.run(['scp','-q',str(base/'static-front-extra.caddy'),host+':/tmp/static-front-extra.caddy'],check=True)
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3','-'],input=script.replace('REGION',host),capture_output=True,text=True);assert r.returncode==0,r.stderr[-1500:];print(host+': '+r.stdout.strip(),flush=True)
