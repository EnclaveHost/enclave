import subprocess
for h in ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['ssh',h,'install -d -m 0755 /usr/local/lib/enclave-caddy'],check=True)
 a=subprocess.Popen(['ssh','nan','cat','/usr/bin/caddy'],stdout=subprocess.PIPE)
 b=subprocess.Popen(['ssh',h,'install -m 0755 /dev/stdin /usr/local/lib/enclave-caddy/caddy'],stdin=a.stdout);a.stdout.close();assert b.wait()==0 and a.wait()==0
 digest=subprocess.check_output(['ssh',h,'sha256sum','/usr/local/lib/enclave-caddy/caddy'],text=True).split()[0];assert digest=='b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9';print(h+': exact Caddy 2.11.4 binary staged',flush=True)
