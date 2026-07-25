#!/usr/bin/env node
// enclave-metal — the host-side launcher. Boots the measured guest image as a
// confidential VM (SEV-SNP or TDX) — or plain KVM in dev mode — wires the serial
// console to stdout/journal, and restarts a wedged guest. Designed to run under
// systemd (system service, root: a VMM needs /dev/kvm + /dev/sev).
//
//   node metal/enclave-metal.mjs --config metal/config.json
//
// config.json (see config.example.json):
//   { "mode":"snp|tdx|dev", "name":"metal0", "cpus":8, "memMiB":8192,
//     "publicUrl":"https://metal0.enclave.host",
//     "relayUrl":"wss://api.enclave.host/v1/fleet-tunnel", "tunnelToken":"…",
//     "hostfwd":[{"host":18080,"guest":8080}], "ovmf":"…", "qemu":"…", "dist":"…" }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
const cfgPath = arg('config', path.join(HERE, 'config.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const MODE = cfg.mode || 'snp';
const NAME = cfg.name || 'metal0';
const CPUS = String(cfg.cpus || 8);
const MEM = String(cfg.memMiB || 8192);
const DIST = cfg.dist || path.join(HERE, 'dist');
const OVMF = cfg.ovmf || '/usr/share/edk2/x64/OVMF.4m.fd';
const QEMU = cfg.qemu || 'qemu-system-x86_64';
const SEV_DEVICE = cfg.sevDevice || '/dev/sev';
const KERNEL = path.join(DIST, 'vmlinuz');
const INITRD = path.join(DIST, 'initramfs.cpio.gz');
for (const f of [KERNEL, INITRD]) if (!fs.existsSync(f)) { console.error(`missing ${f}; run: node metal/build-image.mjs`); process.exit(1); }

// The kernel cmdline is MEASURED (kernel-hashes=on), so it carries only what is
// part of the enclave's identity: the mode. Deployment-specific runtime config
// (name, public URL, relay, tunnel token) is delivered out-of-band via QEMU
// fw_cfg — NOT measured — so a given image has ONE stable launch measurement
// regardless of which relay/token it uses, and no secret ever enters the quote.
const cmdline = [
  'console=ttyS0', 'root=/dev/ram0', 'rootfstype=ramfs', 'quiet',
  `metal.mode=${MODE}`,
].join(' ');
const runtimeCfg = { name: NAME, mode: MODE, publicUrl: cfg.publicUrl || '', relayUrl: cfg.relayUrl || '', tunnelToken: cfg.tunnelToken || '' };
const fwCfgPath = path.join(os.tmpdir(), `metal-fwcfg-${process.pid}.json`);
fs.writeFileSync(fwCfgPath, JSON.stringify(runtimeCfg));

function baseArgs() {
  const a = [
    '-machine', MODE === 'dev' ? 'q35,accel=kvm' : 'q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0',
    '-cpu', 'host', '-smp', CPUS, '-m', MEM,
    '-nographic', '-no-reboot',
    '-kernel', KERNEL, '-initrd', INITRD, '-append', cmdline,
    // deployment config, out-of-band (not measured): the guest reads it from
    // /sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.metal/raw
    '-fw_cfg', `name=opt/org.enclave.metal,file=${fwCfgPath}`,
    // outbound-only user networking (slirp NAT); the enclave dials OUT to the
    // relay, so no inbound is needed. hostfwd exposes loopback ports for testing.
    '-netdev', netdev(), '-device', 'virtio-net-pci,netdev=net0',
    '-serial', 'mon:stdio',
  ];
  if (MODE === 'dev') return a;
  // confidential VM: private guest memory via memfd + the TEE launch object
  a.push('-object', `memory-backend-memfd,id=ram0,size=${MEM}M,share=true,prealloc=false`);
  a.push('-bios', OVMF);
  if (MODE === 'tdx') {
    a.push('-object', 'tdx-guest,id=cx0');
    a.push('-machine', 'q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0,kernel-irqchip=split');
  } else {
    // SEV-SNP with measured kernel hashes → kernel+initrd+cmdline in the launch digest
    a.push('-object', `sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=${SEV_DEVICE}`);
  }
  return a;
}
function netdev() {
  const fwds = (cfg.hostfwd || []).map((f) => `,hostfwd=tcp:127.0.0.1:${f.host}-:${f.guest}`).join('');
  return `user,id=net0${fwds}`;
}

let child = null, stopping = false, restarts = 0;
function launch() {
  const args = baseArgs();
  console.log(`[enclave-metal] launching ${NAME} mode=${MODE} ${CPUS}vcpu/${MEM}MiB`);
  console.log(`[enclave-metal] cmdline: ${cmdline}`);
  child = spawn(QEMU, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, sig) => {
    if (stopping) return;
    restarts++;
    const delay = Math.min(2000 * restarts, 15000);
    console.error(`[enclave-metal] guest exited code=${code} sig=${sig}; relaunch in ${delay}ms (#${restarts})`);
    setTimeout(launch, delay);
  });
  child.on('error', (e) => console.error(`[enclave-metal] spawn error: ${e.message}`));
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = true; if (child) { try { child.kill('SIGTERM'); } catch {} } setTimeout(() => process.exit(0), 2000); });
launch();
