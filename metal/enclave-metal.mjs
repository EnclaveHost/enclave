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
import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
const cfgPath = arg('config', path.join(HERE, 'config.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

let stopping = false;      // hoisted: the shielded-worker supervisor reads it too

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

// --- attested model volumes ---------------------------------------------------
// Each entry in cfg.volumes (names, or "*" for the whole store) is one file
// built by metal/volumes.mjs: an ext4 image of the model tree with a dm-verity
// hash tree appended. We attach it as a read-only virtio-blk disk and hand the
// guest its verity parameters through fw_cfg; the guest brings dm-verity up
// itself, so the host (this process) is never trusted for the CONTENT.
//
// What makes it attested rather than merely hashed: the digest of the whole
// volume table is launched into the CPU's HOST_DATA field, which the hardware
// signs into every attestation report this VM ever produces. Add, drop, or swap
// a model and the quote says so — the property Tinfoil's Modelwrap gets by
// putting its dm-verity root on the measured cmdline. HOST_DATA rather than the
// cmdline on purpose: it is host-supplied config bound to the quote WITHOUT
// entering the launch measurement, so the release measurement (what allowlists
// and dist/manifest.json pin) stays stable while the model set stays provable.
// The guest reads HOST_DATA back out of its own report and refuses to mount a
// table that doesn't hash to it.
const VOL_STORE = cfg.volumeStore || '/vm/enclave-volumes';
function loadVolumes() {
  const want = cfg.volumes === '*'
    // dot-directories are staging, not volumes: model source trees get parked
    // next to the images they were built from, and "*" must not try to attach one
    ? (fs.existsSync(VOL_STORE) ? fs.readdirSync(VOL_STORE, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort() : [])
    : (Array.isArray(cfg.volumes) ? cfg.volumes : []);
  const out = [];
  for (const name of want) {
    const dir = path.join(VOL_STORE, name);
    let v; try { v = JSON.parse(fs.readFileSync(path.join(dir, 'volume.json'), 'utf8')); }
    catch (e) { console.error(`[enclave-metal] volume ${name}: no volume.json in ${dir} (${e.code || e.message}); SKIPPED`); continue; }
    const img = path.join(dir, v.image || 'volume.img');
    if (!fs.existsSync(img)) { console.error(`[enclave-metal] volume ${name}: missing ${img}; SKIPPED`); continue; }
    out.push({
      name: v.name || name, image: img, bytes: v.bytes || 0,
      alg: v.verity.alg || 'sha256', root: v.verity.root, salt: v.verity.salt,
      dataBlockSize: v.verity.dataBlockSize, hashBlockSize: v.verity.hashBlockSize,
      dataBlocks: v.verity.dataBlocks, hashStartBlock: v.verity.hashStartBlock,
      sd: !!v.sd, gguf: v.gguf || '',
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const VOLUMES = loadVolumes();
// virtio-blk serials are how the guest maps a disk to its table entry (device
// enumeration order is not a contract). 20 bytes max, so index them.
VOLUMES.forEach((v, i) => { v.serial = `mvol${i}`; });
// canonical volume-set digest — the SAME construction in metal/guest/gsup.mjs
// (which enforces it) and metal/verify.mjs (which checks it against a quote).
const volLine = (v) => [v.name, v.alg, v.root, v.salt, v.dataBlockSize, v.hashBlockSize,
  v.dataBlocks, v.hashStartBlock, v.sd ? 1 : 0, v.gguf || ''].join('|');
const VOL_DIGEST = VOLUMES.length
  ? createHash('sha256').update(VOLUMES.map(volLine).sort().join('\n') + '\n').digest('hex') : '';

// The kernel cmdline is MEASURED (kernel-hashes=on), so it carries only what is
// part of the enclave's identity: the mode. Deployment-specific runtime config
// (name, public URL, relay, tunnel token) is delivered out-of-band via QEMU
// fw_cfg — NOT measured — so a given image has ONE stable launch measurement
// regardless of which relay/token it uses, and no secret ever enters the quote.
const cmdline = [
  'console=ttyS0', 'root=/dev/ram0', 'rootfstype=ramfs', 'quiet',
  `metal.mode=${MODE}`,
].join(' ');
const runtimeCfg = { name: NAME, mode: MODE, publicUrl: cfg.publicUrl || '', relayUrl: cfg.relayUrl || '', tunnelToken: cfg.tunnelToken || '',
  // seller earning (metal/PROTOCOL.md Phase C): the operator EOA key that
  // registers/claims/earns on-chain (needs a little Base ETH for gas), and the
  // wallet the supervisor auto-sweeps accrued USDC earnings to. Both optional:
  // without registryKey the enclave serves via the tunnel but neither claims
  // nor earns. Delivered via fw_cfg like the tunnel token — out-of-band, never
  // in the launch measurement or the quote.
  registryKey: cfg.registryKey || '', payoutAddress: cfg.payoutAddress || '',
  // optional ZeroSSL External Account Binding pair (bring-your-own, free
  // account): with it the guest's ACME slot 1 (ZeroSSL) activates ahead of
  // the EAB-less Let's Encrypt fallback — sellers escape LE's per-registered-
  // domain weekly cap. Rides fw_cfg like the keys: out-of-band, unmeasured.
  acmeEabKid: cfg.acmeEabKid || '', acmeEabHmac: cfg.acmeEabHmac || '',
  // NOMINAL node RAM (fleet parity): the Tinfoil flavors advertise their baked
  // size (64/512 GB), not the guest kernel's MemTotal, so metal advertises the
  // size the host gives the VM the same way. gsup caps it at the measured
  // total + a small boot haircut so a config typo (or a dishonest seller)
  // can't advertise RAM the VM doesn't have.
  nodeRamGb: Math.round(Number(MEM) / 1024),
  // what this operator CHARGES, in USD per hour for a FULL node / FULL card
  // (see gsup: converted to the ledger's per-second 6dp basis). The GPU ask is
  // only meaningful on a GPU enclave; gsup drops it otherwise.
  priceCpuUsdHr: cfg.priceCpuUsdHr != null ? Number(cfg.priceCpuUsdHr) : null,
  priceGpuUsdHr: cfg.priceGpuUsdHr != null ? Number(cfg.priceGpuUsdHr) : null,
  // optional FLEET secret (first-party boxes only): with it the guest joins
  // the fleet's deployment-secrets plane (the relay's fetch auth derives from
  // it); without it the guest mints its own SECRET per boot and truthfully
  // advertises secrets-incapable. Anonymous sellers leave this unset.
  fleetSecret: cfg.fleetSecret || '',
  // dm-verity parameters for the attached model volumes. Unmeasured on its own
  // — the guest hashes this table and refuses to mount unless it matches the
  // measured metal.vols digest above, so this is a delivery channel, not a
  // trusted one. The host path never crosses: only the serial the disk carries.
  volumes: VOLUMES.map(({ image, ...v }) => v) };

// Optional egress helper. QEMU user-net (slirp) NATs outbound for a normal host,
// but some sandboxed/dev hosts block slirp's EXTERNAL sockets while still routing
// the guest→host (10.0.2.2) path. When cfg.egressHelper is set, we run a tiny
// host-side pipe the guest can reach at 10.0.2.2:<port> and which adds TLS to the
// real relay — so the guest speaks plaintext ws to the helper and the TLS leg to
// the relay is end-to-end from the helper. Only needed in such environments; a
// normal seller box dials the relay directly (leave egressHelper unset).
if (cfg.egressHelper && cfg.relayUrl) {
  const ru = new URL(cfg.relayUrl);
  const port = cfg.egressHelper.port || 9443;
  const targetHost = ru.hostname, targetPort = Number(ru.port) || 443;
  net.createServer((gsock) => {
    const up = tls.connect({ host: targetHost, port: targetPort, servername: targetHost }, () => { gsock.pipe(up); up.pipe(gsock); });
    const kill = () => { gsock.destroy(); up.destroy(); };
    up.on('error', kill); gsock.on('error', kill); up.on('close', kill); gsock.on('close', kill);
  }).listen(port, '127.0.0.1', () => console.log(`[enclave-metal] egress helper 127.0.0.1:${port} → ${targetHost}:${targetPort} (guest reaches it at 10.0.2.2:${port})`));
  // guest dials the helper in plaintext ws, but keeps the real relay host for the Host header + SNI identity
  runtimeCfg.relayUrl = `ws://10.0.2.2:${port}${ru.pathname}`;
  runtimeCfg.relayHost = targetHost;
}

// Optional shielded GPU worker. The card stays on the HOST, outside the enclave
// and outside the measurement, and the guest reaches it at 10.0.2.2:<port> over
// the same slirp path the egress helper uses. That is the whole point of the
// shielded tier: docs/shielded-inference.md assumes the GPU's operator is hostile
// and gives it only public weights and one-time-padded activations, so a box can
// sell GPU work without the GPU ever entering the TCB.
//
// The endpoint rides fw_cfg, which is NOT covered by the launch measurement, and
// that is correct rather than sloppy. A host that redirects this to a worker it
// wrote gains nothing -- the pad never crosses, and Freivalds rejects any product
// that is not the real one. The worst it can do is refuse to answer, and
// availability is explicitly not something this design promises.
let shieldedChild = null;
if (cfg.shieldedWorker) {
  const sw = cfg.shieldedWorker;
  const port = sw.port || 9500;
  const python = sw.python || 'python3';
  const script = sw.script || path.join(HERE, '..', 'shielded', 'worker.py');
  const swArgs = [script, '--host', '127.0.0.1', '--port', String(port)];
  if (sw.vramGb) swArgs.push('--vram-gb', String(sw.vramGb));
  let swRestarts = 0;
  const startWorker = () => {
    shieldedChild = spawn(python, swArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    shieldedChild.on('exit', (code, sig) => {
      if (stopping) return;
      swRestarts++;
      const delay = Math.min(2000 * swRestarts, 30000);
      // A dead worker must NEVER take the box down with it. The enclave keeps
      // serving; it just has no GPU to offload to, and the shielded flavor's
      // health probe is what tells the fleet so.
      console.error(`[enclave-metal] shielded worker exited code=${code} sig=${sig}; restart in ${delay}ms (#${swRestarts})`);
      setTimeout(startWorker, delay);
    });
    shieldedChild.on('error', (e) => console.error(`[enclave-metal] shielded worker spawn error: ${e.message}`));
  };
  startWorker();
  console.log(`[enclave-metal] shielded worker on 127.0.0.1:${port} (guest reaches it at 10.0.2.2:${port})`);
  runtimeCfg.shieldedWorker = { host: '10.0.2.2', port };
}

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
    // Offloads are DISABLED: in a confidential guest, memory is encrypted and
    // DMA goes through bounce buffers, so the host cannot fix up checksums/GSO
    // for offloaded packets — with them on, external TCP SYNs are silently
    // dropped and every outbound connection times out.
    '-netdev', netdev(),
    '-device', 'virtio-net-pci,netdev=net0,csum=off,gso=off,guest_csum=off,'
      + 'host_tso4=off,host_tso6=off,guest_tso4=off,guest_tso6=off,guest_ecn=off,'
      + 'host_ufo=off,guest_ufo=off',
    '-serial', 'mon:stdio',
  ];
  // model volumes: one read-only virtio-blk disk each. cache=none keeps the
  // host page cache out of it — the guest caches what it reads (verified), and
  // a second copy of a 60 GB model in host RAM only steals memory from the CVM.
  // The guest never trusts these bytes: dm-verity checks every block.
  for (const v of VOLUMES) {
    a.push('-drive', `file=${v.image},if=none,id=${v.serial},format=raw,readonly=on,cache=none,aio=threads`);
    a.push('-device', `virtio-blk-pci,drive=${v.serial},serial=${v.serial}`);
  }
  if (MODE === 'dev') return a;
  // confidential VM: private guest memory via memfd + the TEE launch object
  a.push('-object', `memory-backend-memfd,id=ram0,size=${MEM}M,share=true,prealloc=false`);
  a.push('-bios', OVMF);
  // The attached model volumes' set digest, bound into every attestation report
  // this VM produces: HOST_DATA (32 bytes) on SEV-SNP, MRCONFIGID (48, zero-
  // padded) on TDX. Not part of the launch measurement — deliberately, see
  // "attested model volumes" above.
  const volB64 = (bytes) => VOL_DIGEST
    ? Buffer.concat([Buffer.from(VOL_DIGEST, 'hex'), Buffer.alloc(bytes - 32)]).toString('base64') : '';
  if (MODE === 'tdx') {
    // NOTE: the guest does NOT self-check MRCONFIGID today (it enforces
    // HOST_DATA on SNP only), so on TDX the binding is verifiable by a remote
    // party but not fail-closed inside the guest. No TDX hardware to test on.
    a.push('-object', `tdx-guest,id=cx0${VOL_DIGEST ? `,mrconfigid=${volB64(48)}` : ''}`);
    a.push('-machine', 'q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0,kernel-irqchip=split');
  } else {
    // SEV-SNP with measured kernel hashes → kernel+initrd+cmdline in the launch digest.
    //
    // GUEST POLICY is deliberately left at QEMU's default (0x30000: reserved
    // bit 17 set, SMT allowed, DEBUG clear) rather than spelled out. Know what
    // rides on that: the policy is NOT part of the launch measurement, so a
    // guest booted with DEBUG set produces a byte-identical measurement while
    // the host can read and write its memory freely. Both verifiers now refuse
    // that — relay/snp-verify.mjs (tunnel attach) and metal/verify.mjs (what a
    // buyer runs) — so if a future QEMU ever changed this default the failure
    // is loud at attach time rather than a silently transparent box. Spelling
    // `policy=` out here would be belt-and-braces; it is left alone only
    // because a boot-line change to a serving box wants a real boot to test.
    a.push('-object', `sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=${SEV_DEVICE}`
      + (VOL_DIGEST ? `,host-data=${volB64(32)}` : ''));
  }
  return a;
}
function netdev() {
  const fwds = (cfg.hostfwd || []).map((f) => `,hostfwd=tcp:127.0.0.1:${f.host}-:${f.guest}`).join('');
  return `user,id=net0${fwds}`;
}

let child = null, restarts = 0;
function launch() {
  const args = baseArgs();
  console.log(`[enclave-metal] launching ${NAME} mode=${MODE} ${CPUS}vcpu/${MEM}MiB`);
  if (VOLUMES.length) {
    console.log(`[enclave-metal] model volumes (${VOLUMES.length}, set digest ${VOL_DIGEST.slice(0, 16)}… — MEASURED):`);
    for (const v of VOLUMES)
      console.log(`[enclave-metal]   ${v.name.padEnd(26)} ${(v.bytes / 1e9).toFixed(2).padStart(7)} GB  verity ${v.root.slice(0, 24)}…`);
  }
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
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => {
  stopping = true;
  for (const c of [child, shieldedChild]) if (c) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(0), 2000);
});
launch();
