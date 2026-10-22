from pathlib import Path
import subprocess,json,shlex
pub=Path('work/storage-vm/tunnel.pub').read_text().strip(); hosts=['us-west','eu-central','ap-southeast','ca-east'];known=[];report=[]
for host in hosts:
 sshcfg=subprocess.check_output(['ssh','-G',host],stderr=subprocess.DEVNULL,text=True)
 address=next(s.split()[1] for s in sshcfg.splitlines() if s.startswith('hostname '))
 script=r'''set -eu
id enclave-storage-tunnel >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/enclave-storage-tunnel --shell /bin/sh enclave-storage-tunnel
install -d -m 700 -o enclave-storage-tunnel -g enclave-storage-tunnel /var/lib/enclave-storage-tunnel/.ssh
f=/var/lib/enclave-storage-tunnel/.ssh/authorized_keys
key=KEY_VALUE
line="restrict,port-forwarding,permitlisten=\"127.0.0.1:29443\",permitlisten=\"127.0.0.1:29080\",command=\"/usr/bin/false\" $key"
if [ -s "$f" ] && ! grep -Fxq "$line" "$f"; then echo 'Unexpected existing tunnel authorization' >&2; exit 2; fi
printf '%s\n' "$line" > "$f"
chown enclave-storage-tunnel:enclave-storage-tunnel "$f"
chmod 600 "$f"
c=/etc/ssh/sshd_config.d/70-enclave-storage-tunnel.conf
if [ -e "$c" ]; then echo 'Tunnel sshd config already exists; inspect first' >&2; exit 2; fi
cat > "$c" <<'EOF'
Match User enclave-storage-tunnel
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:29443 127.0.0.1:29080
    GatewayPorts no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    MaxSessions 0
Match all
EOF
if ! /usr/sbin/sshd -t; then mv "$c" "$c.invalid"; exit 2; fi
systemctl reload ssh
cat /etc/ssh/ssh_host_ed25519_key.pub
'''.replace('KEY_VALUE',shlex.quote(pub))
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'sh -s'],input=script,capture_output=True,text=True)
 if r.returncode: raise RuntimeError(host+' tunnel setup failed: '+r.stderr[-600:])
 key=r.stdout.strip(); assert key.startswith('ssh-ed25519 ') and len(key.splitlines())==1
 known.append(address+' '+' '.join(key.split()[:2]));report.append({'host':host,'address':address,'ports':[29443,29080],'shellAllowed':False,'forwarding':'remote-loopback-only'})
 print(host+': restricted tunnel receiver ready',flush=True)
Path('work/storage-vm/provider_known_hosts').write_text('\n'.join(known)+'\n')
Path('outputs/storage-tunnel-preparation.json').write_text(json.dumps(report,indent=2)+'\n')
