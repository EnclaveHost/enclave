from pathlib import Path
import subprocess
script='''from pathlib import Path
import subprocess,json,hashlib
p=Path('/etc/caddy/Caddyfile');out=Path('/var/lib/indexd-migration/Caddyfile.control-proxy');assert not out.exists()
extra='''+repr('''
http://127.0.0.1:8100 {
    reverse_proxy https://134.199.235.187 {
        transport http {
            tls_server_name api.enclave.host
        }
    }
}
''')+'''
assert 'http://127.0.0.1:8100 {' not in p.read_text();out.write_text(p.read_text()+extra);out.chmod(0o600)
r=subprocess.run(['caddy','validate','--config',str(out),'--adapter','caddyfile'],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:]
Path('/var/lib/indexd-migration/control-proxy-source.sha256').write_text(hashlib.sha256(p.read_bytes()).hexdigest())
print('Nan compatibility proxy prepared and validated; not activated')
'''
r=subprocess.run(['ssh','nan','python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1200:];print(r.stdout)
