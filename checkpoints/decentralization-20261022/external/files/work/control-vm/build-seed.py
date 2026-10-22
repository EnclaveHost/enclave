from pathlib import Path
import subprocess,os
root=Path('work/control-vm'); seed=root/'seed'
key=Path('/home/steven/.ssh/minipc.pub').read_text().strip()
assert key.startswith('ssh-') and '\n' not in key
user='''#cloud-config
hostname: enclave-control
manage_etc_hosts: true
users:
  - name: controladmin
    groups: [adm, sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - '''+key+'''
ssh_pwauth: false
disable_root: true
package_update: false
package_upgrade: false
write_files:
  - path: /etc/ssh/sshd_config.d/10-enclave-control.conf
    permissions: '0644'
    content: |
      PasswordAuthentication no
      PermitRootLogin no
      KbdInteractiveAuthentication no
  - path: /etc/systemd/system.conf.d/10-control-stop.conf
    permissions: '0644'
    content: |
      [Manager]
      DefaultTimeoutStopSec=180s
runcmd:
  - [systemctl, try-reload-or-restart, ssh]
'''
(seed/'user-data').write_text(user)
(seed/'meta-data').write_text('instance-id: enclave-control-20261019\nlocal-hostname: enclave-control\n')
subprocess.run(['xorriso','-as','mkisofs','-quiet','-V','cidata','-J','-r','-o',str(root/'seed.iso'),str(seed/'user-data'),str(seed/'meta-data')],check=True)
print('Seed ISO ready; existing minipc SSH public key only, password login disabled.')
