from pathlib import Path
import subprocess,json,hashlib
ips={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
for host,ip in ips.items():
 subprocess.run(['scp','-q','work/native-recovery-bundle/provider.mjs',host+':/tmp/enclave-native-provider.mjs'],check=True)
 script='''from pathlib import Path
import json,subprocess,hashlib,os,shutil
assert hashlib.sha256(Path('/opt/enclave-network/nan-retirement-8b37c37/wg-provider.mjs').read_bytes()).hexdigest()=='8b776d76faf784cacafbe95c5ff2a8b501093f28b3e45049eeeeabc528937164'
bundle=Path('/tmp/enclave-native-provider.mjs');assert hashlib.sha256(bundle.read_bytes()).hexdigest()=='464cad341e4a816aa17a48d6cd727988aa527842e1925acf2b79d9aab3bc6d24'
release=Path('/opt/enclave-network/native-recovery-464cad3');release.mkdir(exist_ok=True);shutil.copy2(bundle,release/'provider.mjs')
p=Path('/etc/enclave-bootstrap-tls');s=(p/'Caddyfile').read_text();assert 'default_sni' not in s;s=s.replace('http_port 28080','default_sni '+IP+'\\n    http_port 28080')
for name in ['enclave.host','www.enclave.host','ipfs.enclave.host']:
 old='tls {$CREDENTIALS_DIRECTORY}/'+name+'.crt {$CREDENTIALS_DIRECTORY}/'+name+'.key';assert s.count(old)==1;s=s.replace(old,'tls {\\n        issuer acme {\\n            disable_tlsalpn_challenge\\n        }\\n    }')
s+='''+repr('''
https://IP {
    bind 127.0.0.1
    tls {
        issuer acme {
            profile shortlived
        }
    }
    header X-Content-Type-Options nosniff
    @recovery path /native/* /recovery-health /v1/* /health /enclaves /availability /route /t/* /mcp
    handle @recovery {
        reverse_proxy https://127.0.0.1:30443 {
            transport http {
                tls_server_name api.enclave.host
            }
            header_up Host api.enclave.host
        }
    }
    handle {
        respond 404
    }
}
''')+'''.replace('IP',IP)
candidate=p/'Caddyfile.native-prepared';candidate.write_text(s)
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1200:]
config=Path('/etc/enclave-network/provider-pinned-8b37c37.json');doc=json.loads(config.read_text());assert 'noSniRoute' not in doc
doc['noSniRoute']={'host':'127.0.0.1','tls':28443};doc['localRoutes'][IP]={'host':'127.0.0.1','tls':28443,'http':28080}
for name in ['api.enclavehost.eth','mcp.enclavehost.eth']:doc['localRoutes'][name]={'host':'127.0.0.1','tls':30443,'http':30080}
out=p/'provider.native-prepared.json';out.write_text(json.dumps(doc,indent=2)+'\\n');out.chmod(0o600)
(p/'provider.native-before.sha256').write_text(hashlib.sha256(config.read_bytes()).hexdigest())
print(json.dumps({'nativeIP':IP,'candidateValidated':True,'productionChanged':False}))
'''
 r=subprocess.run(['ssh',host,'python3','-'],input='IP='+repr(ip)+'\n'+script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(host+': '+r.stdout.strip(),flush=True)
