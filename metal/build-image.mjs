#!/usr/bin/env node
// build-image.mjs — reproducible, UNPRIVILEGED build of the metal guest image.
//
// Produces a measured SEV-SNP guest from the exact same digest-pinned container
// images the hosted fleet runs. No docker, no root: the OCI images are pulled
// and extracted by oci-pull.mjs, the GPU payload is stripped for the CPU flavor,
// the supervisor image becomes the guest root, the wasm-manager image becomes a
// chroot under /opt/roots/wasm, and the whole thing is packed into a single
// initramfs whose kernel+initrd+cmdline are folded into the launch measurement
// (kernel-hashes=on). Everything that runs in the TCB is therefore covered by
// the hardware measurement — no unmeasured byte, no transparency-log detour.
//
//   node metal/build-image.mjs [--supervisor <ref>] [--wasm <ref>] [--kernel <path>]
//
// Outputs under metal/dist/: vmlinuz, initramfs.cpio.gz, cmdline, manifest.json
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');
const DIST = path.join(HERE, 'dist');
const ROOT = path.join(BUILD, 'root');                       // the guest / (initramfs)
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 1 << 30 }).toString();
const sha256File = (p) => { const h = createHash('sha256'); h.update(fs.readFileSync(p)); return h.digest('hex'); };

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }

const KVER = arg('kver', os.release());
const KERNEL = arg('kernel', '/boot/vmlinuz-linux');
const MODROOT = arg('modroot', `/usr/lib/modules/${KVER}`);
const SUPERVISOR_REF = arg('supervisor', 'ghcr.io/enclavehost/enclave-supervisor:latest');
// KEEP IN STEP WITH THE SUPERVISOR. These are two independently-tagged images
// that share a loopback control plane, and its token derivation changed in
// c1b7352c (raw fleet SECRET → HMAC(SECRET, "enclave vmmgr v1")). Pair a
// post-c1b7352c supervisor with an older manager and control auth fails
// SILENTLY in the only direction that looks healthy: /health falls back to its
// unauthenticated liveness subset, so the enclave keeps answering while
// advertising no volumes, no capacity and no nn probe.
const WASM_REF = arg('wasm', 'ghcr.io/enclavehost/enclave-wasm-manager:d2fd989c');

console.log(`[build] kernel=${KERNEL} kver=${KVER}`);
console.log(`[build] supervisor=${SUPERVISOR_REF}`);
console.log(`[build] wasm=${WASM_REF}`);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// --- 1. pull the two images (digests captured for the manifest) --------------
// The manifest is the record of WHAT WAS BUILT — the thing a third party
// reproduces against. An unparseable digest line must stop the build, not be
// written down as 'unknown'.
function pull(ref, dest) {
  const r = execFileSyncCapture('node', [path.join(HERE, 'oci-pull.mjs'), ref, dest]);
  const line = r.trim().split('\n').pop().trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(line))
    throw new Error(`oci-pull did not report a digest for ${ref} (got ${JSON.stringify(line.slice(0, 80))})`);
  return line;
}
const isPinned = (ref) => /@sha256:[0-9a-f]{64}$/.test(ref);
function execFileSyncCapture(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], maxBuffer: 1 << 28 });
  if (r.status !== 0) { process.stderr.write(r.stderr || ''); throw new Error(`${cmd} exited ${r.status}`); }
  return (r.stderr || Buffer.alloc(0)).toString();
}
const WASM_ROOT = path.join(ROOT, 'opt/roots/wasm');
fs.mkdirSync(path.dirname(WASM_ROOT), { recursive: true });
console.log('[build] pulling supervisor (guest root)…');
const supDigest = pull(SUPERVISOR_REF, ROOT);
console.log('[build] pulling wasm-manager (chroot)…');
const wasmDigest = pull(WASM_REF, WASM_ROOT);
// A tag was resolved, not pinned: say so once, loudly, and hand over the exact
// command that IS reproducible. A measurement built from a moving tag must
// never be curated into METAL_ALLOWED_MEASUREMENTS as if it were.
for (const [what, ref, dgst] of [['supervisor', SUPERVISOR_REF, supDigest], ['wasm-manager', WASM_REF, wasmDigest]]) {
  if (isPinned(ref)) continue;
  const repo = ref.replace(/[@:][^/@:]+$/, '');
  console.error(`[build] WARNING: ${what} was pulled by TAG (${ref}) — this build is NOT reproducible.`);
  console.error(`[build]          for a reproducible build, rebuild with:  --${what === 'supervisor' ? 'supervisor' : 'wasm'} ${repo}@${dgst}`);
}

// --- 2. strip the GPU payload from the wasm chroot (CPU flavor) --------------
console.log('[build] stripping GPU payload from wasm chroot…');
const stripGlobs = [
  'usr/local/cuda-12.6', 'usr/local/cuda',
  'usr/lib/x86_64-linux-gnu/libcudnn*', 'usr/lib/x86_64-linux-gnu/libnccl*',
  'usr/lib/x86_64-linux-gnu/libcublas*', 'usr/lib/x86_64-linux-gnu/libcusparse*',
  'usr/lib/x86_64-linux-gnu/libnpp*', 'usr/lib/x86_64-linux-gnu/libcufft*',
  'usr/lib/x86_64-linux-gnu/libcurand*', 'usr/lib/x86_64-linux-gnu/libnvrtc*',
  'usr/local/lib/libggml-cuda.so', 'usr/local/lib/libonnxruntime_providers_cuda.so',
  'usr/local/lib/libonnxruntime_providers_tensorrt.so',
];
let stripped = 0;
for (const g of stripGlobs) {
  for (const f of globSync(path.join(WASM_ROOT, g))) {
    const before = duBytes(f); fs.rmSync(f, { recursive: true, force: true }); stripped += before;
  }
}
console.log(`[build] stripped ${(stripped / 1e9).toFixed(2)} GB of GPU libraries`);

// --- 3. flavor env (non-secret) from the CPU tinfoil-config ------------------
console.log('[build] extracting CPU flavor env…');
fs.mkdirSync(path.join(ROOT, 'opt/metal'), { recursive: true });
const flavorEnv = parseFlavorEnv(path.join(HERE, '..', 'enclaves', 'cpu', 'tinfoil-config.yml'), 'supervisor');
delete flavorEnv.PORT; delete flavorEnv.PUBLIC_URL;          // metal sets these
fs.writeFileSync(path.join(ROOT, 'opt/metal/flavor-env.json'), JSON.stringify(flavorEnv, null, 2));
// wasm image env (for the chroot) from its OCI config
const wasmCfg = JSON.parse(fs.readFileSync(path.join(WASM_ROOT, '.oci-config.json'), 'utf8'));
const wasmEnv = Object.fromEntries((wasmCfg.config.Env || []).map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));
fs.writeFileSync(path.join(ROOT, 'opt/metal/wasm-env.json'), JSON.stringify(wasmEnv, null, 2));

// --- 4. metal guest files ----------------------------------------------------
console.log('[build] installing metal guest files…');
const md = path.join(ROOT, 'opt/metal'); fs.mkdirSync(md, { recursive: true });
for (const f of ['gsup.mjs', 'agent.mjs']) fs.copyFileSync(path.join(HERE, 'guest', f), path.join(md, f));
// init (PID1), with the kernel version substituted in
let init = fs.readFileSync(path.join(HERE, 'guest', 'init'), 'utf8').replaceAll('__KVER__', KVER);
fs.writeFileSync(path.join(ROOT, 'init'), init, { mode: 0o755 });
fs.chmodSync(path.join(ROOT, 'init'), 0o755);
// CA trust store — the slim base image ships none, so any TLS the guest does
// (the fleet tunnel's wss, the supervisor's Base RPC, ACME) needs a bundle. Copy
// the host's; it is public data (not a secret) and does not affect the measurement
// story (it is just root certs).
try {
  const caSrc = fs.realpathSync('/etc/ssl/certs/ca-certificates.crt');
  const caDst = path.join(ROOT, 'etc/ssl/certs/ca-certificates.crt');
  fs.mkdirSync(path.dirname(caDst), { recursive: true });
  fs.copyFileSync(caSrc, caDst);
  console.log(`[build] installed CA bundle (${fs.readFileSync(caDst, 'utf8').match(/BEGIN CERT/g)?.length || 0} roots)`);
} catch (e) { console.log(`[build] (no host CA bundle: ${e.message})`); }

// compile the static helpers (no kmod/iproute2/cryptsetup in the slim base image)
console.log('[build] compiling netup + minsmod + mverity…');
sh('gcc', ['-static', '-Os', '-o', path.join(md, 'netup'), path.join(HERE, 'guest', 'netup.c')]);
sh('gcc', ['-static', '-Os', '-o', path.join(md, 'minsmod'), path.join(HERE, 'guest', 'minsmod.c')]);
sh('gcc', ['-static', '-Os', '-o', path.join(md, 'mverity'), path.join(HERE, 'guest', 'mverity.c')]);

// --- 5. kernel modules (decompress the exact set we insmod, keep the tree) ---
console.log('[build] collecting kernel modules…');
const wantModules = [
  'kernel/drivers/firmware/qemu_fw_cfg.ko',              // read deployment config (name/relay/token) out-of-band
  'kernel/net/core/failover.ko',
  'kernel/drivers/net/net_failover.ko',
  'kernel/drivers/net/virtio_net.ko',
  'kernel/drivers/virt/coco/guest/tsm_report.ko',
  'kernel/drivers/virt/coco/sev-guest/sev-guest.ko',
  'kernel/drivers/virt/coco/tdx-guest/tdx-guest.ko',
  // attested model volumes: dm-verity over a read-only virtio-blk disk. Load
  // order matters and so does completeness — insmod resolves no dependencies
  // itself, and a missing one fails as a bare "No such file or directory" from
  // finit_module (unresolved symbols), not as anything that names the module.
  // dm-verity needs dm-mod (which also registers the /dev/mapper/control node
  // mverity opens), dm-bufio, and reed_solomon (built in for the optional FEC
  // path). virtio_blk and ext4 are built into this kernel, so neither needs a
  // module.
  'kernel/drivers/md/dm-mod.ko',
  'kernel/drivers/md/dm-bufio.ko',
  'kernel/lib/reed_solomon/reed_solomon.ko',
  'kernel/drivers/md/dm-verity.ko',
];
const modList = [];
for (const rel of wantModules) {
  const src = path.join(MODROOT, rel + '.zst');
  const plain = path.join(MODROOT, rel);
  const dstRel = rel;                                       // keep same layout in the initramfs
  const dst = path.join(ROOT, 'lib/modules', KVER, dstRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(src)) { fs.writeFileSync(dst, execFileSync('zstd', ['-dc', src], { maxBuffer: 1 << 28 })); modList.push(dstRel); }
  else if (fs.existsSync(plain)) { fs.copyFileSync(plain, dst); modList.push(dstRel); }
  else console.log(`[build]   (skip missing ${rel})`);
}
fs.writeFileSync(path.join(md, 'modules.list'), modList.join('\n') + '\n');
console.log(`[build] modules: ${modList.map((m) => path.basename(m)).join(', ')}`);

// --- 6. copy the kernel + record hashes --------------------------------------
fs.copyFileSync(KERNEL, path.join(DIST, 'vmlinuz'));
const kernelSha = sha256File(path.join(DIST, 'vmlinuz'));

// --- 7. manifest (written into the image AND to dist; the in-image copy lets
// the agent report exactly what it was built from) ---------------------------
// The MEASURED cmdline carries only the mode; everything else is fw_cfg (unmeasured).
const cmdlineTemplate = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=${MODE}';
const manifest = {
  builtWith: 'metal/build-image.mjs',
  flavor: 'cpu',
  images: { supervisor: { ref: SUPERVISOR_REF, digest: supDigest, pinned: isPinned(SUPERVISOR_REF) },
            wasmManager: { ref: WASM_REF, digest: wasmDigest, pinned: isPinned(WASM_REF) } },
  // Whether THIS build is reproducible, stated rather than assumed. A tag ref
  // resolves to whatever the registry serves today, so the same command a week
  // later yields a different launch measurement — which is precisely the claim
  // the Metal release allowlist rests on ("anyone can rebuild the release and
  // reproduce each measurement", metal/PROTOCOL.md). Only a build whose every
  // input is digest-pinned can carry that claim, so it is recorded per build
  // instead of asserted in prose.
  reproducible: isPinned(SUPERVISOR_REF) && isPinned(WASM_REF),
  kernel: { path: KERNEL, kver: KVER, sha256: kernelSha },
  modules: modList,
  cmdlineTemplate,
  // How attached model volumes are bound to the hardware. The launcher puts the
  // digest of the volume table in HOST_DATA (SEV-SNP) / MRCONFIGID (TDX), which
  // the CPU signs into every report — NOT in the launch measurement, so this
  // measurement stays valid whatever models the box carries. Recompute the
  // digest from the RAD's volume table alone: one line per volume, sorted,
  // newline-separated, with a trailing newline.
  volumeBinding: {
    field: 'HOST_DATA (SNP report offset 0xC0, 32 bytes); MRCONFIGID on TDX',
    canonicalLine: 'name|alg|root|salt|dataBlockSize|hashBlockSize|dataBlocks|hashStartBlock|sd(1/0)|gguf',
    digest: 'sha256(lines.sort().join("\\n") + "\\n")',
    note: 'Volume images are built by metal/volumes.mjs and are themselves reproducible: '
        + 'same source tree in, same verity root hash out. The guest reads HOST_DATA back '
        + 'from its own report and refuses to mount a table that does not hash to it.',
  },
  note: 'The SEV-SNP launch measurement is a function of (OVMF, this kernel, the '
      + 'initramfs, and the final cmdline). Recompute it independently with '
      + 'sev-snp-measure using the sha256 fields here; metal/verify.mjs checks a '
      + 'live report against the pinned launch measurement.',
};
fs.writeFileSync(path.join(md, 'manifest.json'), JSON.stringify(manifest, null, 2));

// --- 8. pack the initramfs (newc cpio + gzip), unprivileged + REPRODUCIBLE ---
// The whole trust story rests on a third party rebuilding this image and getting
// the SAME launch measurement, so the initramfs must be byte-identical across
// builds: fixed mtimes, sorted entry order, and gzip -n (no timestamp/name in
// the gzip header). The kernel applies root:root ownership at unpack regardless
// of on-disk uid, so our uid doesn't enter the image.
console.log('[build] packing initramfs (reproducible)…');
const initrd = path.join(DIST, 'initramfs.cpio.gz');
execSync('find . -exec touch --no-dereference -d @0 {} +', { cwd: ROOT, stdio: 'inherit', shell: '/bin/bash' });
execSync(`cd ${JSON.stringify(ROOT)} && find . -print0 | LC_ALL=C sort -z | `
       + `cpio --null -o -H newc --reproducible --quiet | gzip -n -9 > ${JSON.stringify(initrd)}`,
  { stdio: ['ignore', 'inherit', 'inherit'], shell: '/bin/bash' });
const initrdSha = sha256File(initrd);
manifest.initramfs = { sha256: initrdSha, bytes: fs.statSync(initrd).size };
fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
// refresh the in-image manifest too (so its recorded initrd hash matches) — but
// that would change the initrd, so we deliberately keep the in-image manifest
// WITHOUT the initrd hash (it can't contain its own hash); dist/manifest.json is
// the authoritative one for verification.

fs.writeFileSync(path.join(DIST, 'cmdline'), cmdlineTemplate + '\n');

// --- 9. expected SNP launch measurement (reproducible reference) -------------
// Compute the launch digest the same way any third party can, for the default
// runtime cmdline. It is a function of (OVMF, kernel, initrd, cmdline, vcpus,
// cpu sig); the cmdline carries the deployment's public_url/relay/token, so the
// reference is per (vcpus × cmdline). metal/verify.mjs recomputes and compares.
try {
  const cpu = readCpuSig();
  const OVMF = arg('ovmf', '/usr/share/edk2/x64/OVMF.4m.fd');
  const vcpuList = (arg('measure-vcpus', '4,8,16')).split(',').map((s) => parseInt(s, 10)).filter(Boolean);
  const concreteCmdline = cmdlineTemplate
    .replace('${MODE}', 'snp').replace('${NAME}', 'metal0')
    .replace('${PUBLIC_URL}', '').replace('${RELAY}', '').replace('${TOKEN}', '');
  const measures = {};
  for (const vcpus of vcpuList) {
    const m = spawnSync(process.env.HOME + '/.local/bin/sev-snp-measure',
      ['--mode', 'snp', '--vcpus', String(vcpus),
        '--vcpu-family', String(cpu.family), '--vcpu-model', String(cpu.model), '--vcpu-stepping', String(cpu.stepping),
        '--vmm-type', 'QEMU', '--ovmf', OVMF,
        '--kernel', path.join(DIST, 'vmlinuz'), '--initrd', initrd,
        '--append', concreteCmdline, '--output-format', 'hex'],
      { encoding: 'utf8' });
    if (m.status === 0 && /^[0-9a-f]{96}$/.test(m.stdout.trim())) measures[vcpus] = m.stdout.trim();
  }
  if (Object.keys(measures).length) {
    manifest.expectedMeasurement = {
      note: 'SEV-SNP launch digest for the DEFAULT cmdline (empty public_url/relay/token), '
          + 'per vcpu count. A non-empty cmdline changes this — recompute with the values in dist/cmdline.',
      ovmf: OVMF, ovmfSha256: sha256File(OVMF), cpuSig: cpu, vmmType: 'QEMU',
      cmdline: concreteCmdline, byVcpus: measures,
    };
    fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[build] expected measurement (4 vcpu): ${measures[4] ? measures[4].slice(0, 24) + '…' : '(n/a)'}`);
  }
} catch (e) { console.log(`[build] (sev-snp-measure unavailable: ${e.message}; measurement left unpinned)`); }

console.log(`\n[build] DONE`);
console.log(`[build]   vmlinuz            ${(fs.statSync(path.join(DIST, 'vmlinuz')).size / 1e6).toFixed(1)} MB  sha256:${kernelSha.slice(0, 16)}…`);
console.log(`[build]   initramfs.cpio.gz  ${(manifest.initramfs.bytes / 1e6).toFixed(1)} MB  sha256:${initrdSha.slice(0, 16)}…`);
console.log(`[build]   manifest.json      metal/dist/manifest.json`);

// ---- helpers ----------------------------------------------------------------
function globSync(pattern) {
  const dir = path.dirname(pattern), base = path.basename(pattern);
  if (!base.includes('*')) return fs.existsSync(pattern) ? [pattern] : [];
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
}
function duBytes(p) { try { return parseInt(out('du', ['-sb', p]).split('\t')[0], 10) || 0; } catch { return 0; } }
function readCpuSig() {
  // family/model/stepping the VMSA is measured with (the launch digest depends
  // on it). Defaults are this box's EPYC (fam 26 / model 2 / stepping 1).
  const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
  const g = (re, d) => { const m = info.match(re); return m ? parseInt(m[1], 10) : d; };
  return {
    family: parseInt(arg('cpu-family', String(g(/cpu family\s*:\s*(\d+)/, 26))), 10),
    model: parseInt(arg('cpu-model', String(g(/model\s*:\s*(\d+)/, 2))), 10),
    stepping: parseInt(arg('cpu-stepping', String(g(/stepping\s*:\s*(\d+)/, 1))), 10),
  };
}
function parseFlavorEnv(ymlPath, containerName) {
  // minimal parser for the `env:` list under the named container in a
  // tinfoil-config.yml (lines like `      - KEY: "value"`), non-secret only.
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  const env = {}; let inContainer = false, inEnv = false;
  for (const line of lines) {
    if (/^\s*-\s*name:\s*"?([\w-]+)"?/.test(line)) { inContainer = RegExp.$1 === containerName; inEnv = false; continue; }
    if (!inContainer) continue;
    if (/^\s{4}env:\s*$/.test(line)) { inEnv = true; continue; }
    if (/^\s{4}\w/.test(line) && !/^\s{4}env:/.test(line)) inEnv = false;   // left env: block
    if (!inEnv) continue;
    const m = line.match(/^\s*-\s*([A-Z0-9_]+):\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if (v.startsWith('"')) { const q = v.match(/^"((?:[^"\\]|\\.)*)"/); v = q ? q[1] : v.slice(1); }   // quoted: take up to closing quote
      else v = v.replace(/\s+#.*$/, '').trim();                                                          // unquoted: strip inline # comment
      env[m[1]] = v;
    }
  }
  return env;
}
