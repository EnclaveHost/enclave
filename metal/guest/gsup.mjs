#!/usr/bin/env node
// metal guest process supervisor. Runs as the guest's effective PID 1 (init
// exec's us). Mints the per-boot fleet secrets IN the CVM (so the host operator
// never sees them — stronger than vault injection), then starts and keeps alive:
//
//   wasm-manager  (chroot /opt/roots/wasm, python)  :8091   tenant apps
//   supervisor    (node /app/supervisor.js)         :8080   control plane
//   metal-agent   (node /opt/metal/agent.mjs)       :8443   RAD + fleet tunnel
//
// Runtime, deployment-specific config arrives on the kernel cmdline
// (metal.* keys) — which is covered by the SEV-SNP launch measurement when
// kernel-hashes=on, so it is part of the enclave's verified identity, not a
// mutable host-side knob.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const log = (...a) => { try { fs.writeSync(1, `[gsup] ${a.join(' ')}\n`); } catch {} };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

// The node's ADVERTISED capacity is this VM's size: vCPUs from the scheduler,
// GFLOPS scaling with them (~62.5/vCPU, matching the flavor's 1000 for 16).
// RAM follows the FLEET convention: advertise the NOMINAL size the host gives
// the VM (fw_cfg nodeRamGb, from config memMiB) exactly as the Tinfoil flavors
// advertise their baked constants — on both, the wasm manager's RAM-headroom
// admission gate (×0.9) is what holds back the kernel + base-system overhead.
// The nominal is capped at MemTotal + 3 GB (≈ the kernel's boot-time haircut)
// so a config typo or a dishonest seller can't advertise RAM the VM doesn't
// have; with no nominal, fall back to the measured size as before.
const NODE_VCPUS = os.cpus().length;
const totalGb = os.totalmem() / (1024 ** 3);
const NODE_GFLOPS = Math.max(1, Math.round((1000 / 16) * NODE_VCPUS));

// --- config: mode from the MEASURED cmdline; deployment config from fw_cfg ----
// (out-of-band, NOT measured — so the launch measurement is stable per image).
const cmdline = (() => { try { return fs.readFileSync('/proc/cmdline', 'utf8'); } catch { return ''; } })();
const cmdMode = (cmdline.match(/(?:^|\s)metal\.mode=([^\s]+)/) || [])[1];
const fw = (() => {
  for (const p of ['/sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.metal/raw']) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
})();
const nominalRamGb = Math.round(Number(fw.nodeRamGb) || 0);
const NODE_RAM_GB  = nominalRamGb > 0
  ? Math.min(nominalRamGb, Math.ceil(totalGb) + 3)
  : Math.max(1, Math.floor(totalGb - 1.5));            // measured: reserve ~1.5 GB for the base system
const MODE         = fw.mode || cmdMode || 'snp';      // snp | tdx | dev
const NAME         = fw.name || 'metal0';
const PUBLIC_URL   = fw.publicUrl || '';               // e.g. https://api.enclave.host/t/metal0
const RELAY_URL    = fw.relayUrl || '';                // wss://api.enclave.host/v1/fleet-tunnel
const TUNNEL_TOKEN = fw.tunnelToken || '';
// Seller earning (metal/PROTOCOL.md Phase C): with a funded operator EOA key
// and a public (relay-routed) URL, the supervisor registers on EnclaveRegistry,
// claims funded EnclaveDeployments work, and is paid the runner share by the
// rev-7 ledger — auto-swept to payoutAddress. Without a key the enclave still
// serves over the tunnel; it just neither claims nor earns.
const REGISTRY_KEY = fw.registryKey || '';
const PAYOUT_ADDR  = fw.payoutAddress || '';
const FLEET_SECRET = fw.fleetSecret || '';             // first-party boxes only: joins the deployment-secrets plane
const SELLING      = !!(REGISTRY_KEY && PUBLIC_URL);

// --- what this operator CHARGES ---------------------------------------------
// config gives USD/hour for a FULL node / FULL card; the ledger prices in USDC
// 6dp per second, so convert once here (1 USD/hr = 1e6/3600 units/sec). On a
// rev-8 ledger this is not a floor or a hint: it is THE price, published in
// this enclave's registry entry and charged pro-rata to whoever it claims for.
// GPU: this image is the CPU flavor and passes no card through, so there is
// nothing to sell — a configured GPU price is DROPPED (with a warning) rather
// than advertised, because advertising a price for hardware we don't have is
// how a box sells work it can never run. A GPU metal build (card passed
// through, GPU flavor image) sets METAL_GPU=1 and the ask applies.
const usdHrToSec6 = (v) => Number.isFinite(v) && v > 0 ? Math.round(v * 1e6 / 3600) : 0;
const HAS_GPU     = /^(1|true|on)$/i.test(process.env.METAL_GPU || '') || Number(fw.gpuCount || 0) > 0;
const PRICE_CPU6  = usdHrToSec6(Number(fw.priceCpuUsdHr));
const PRICE_GPU6  = usdHrToSec6(Number(fw.priceGpuUsdHr));
if (PRICE_GPU6 > 0 && !HAS_GPU)
  log('WARNING: priceGpuUsdHr is set but this enclave has no GPU — ignoring it (CPU-only boxes sell no GPU shares)');
if (HAS_GPU && PRICE_GPU6 <= 0)
  log('WARNING: GPU enclave with no priceGpuUsdHr — its GPU shares sell at the supervisor default ($6.00/card-hr)');

const flavorEnv = readJson('/opt/metal/flavor-env.json', {});   // baked, non-secret

// --- per-boot secrets (minted in-CVM, never leave it) ------------------------
const SECRET       = FLEET_SECRET || randomBytes(32).toString('hex');
const ADMIN_TOKEN  = randomBytes(32).toString('hex');
log(`mode=${MODE} name=${NAME} public=${PUBLIC_URL || '(none)'} relay=${RELAY_URL ? 'set' : '(none)'} selling=${SELLING ? 'on' : 'off'}`
  + (PRICE_CPU6 > 0 || (HAS_GPU && PRICE_GPU6 > 0)
      ? ` ask=${PRICE_CPU6 > 0 ? '$' + (PRICE_CPU6 * 3600 / 1e6).toFixed(2) + '/node-hr' : 'list'}`
        + (HAS_GPU && PRICE_GPU6 > 0 ? ` · $${(PRICE_GPU6 * 3600 / 1e6).toFixed(2)}/card-hr` : '')
      : ' ask=list price'));
log(`advertised capacity: ${NODE_VCPUS} vCPU / ${NODE_RAM_GB} GB RAM / ${NODE_GFLOPS} GFLOPS (RAM ${nominalRamGb > 0 ? 'nominal, fleet convention' : 'measured'})`);

// --- child management --------------------------------------------------------
const children = new Map();
function start(name, argv, env, opts = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    env: { ...env }, cwd: opts.cwd, stdio: ['ignore', 'inherit', 'inherit'], detached: true,
  });
  const rec = { child, argv, env, opts, backoff: opts.backoff0 || 500, done: false };
  children.set(name, rec);
  const restart = (why) => {
    if (rec.done) return; rec.done = true;                 // exit OR error, whichever first
    log(`${name} ${why}; restarting in ${rec.backoff}ms`);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}  // reap any group grandchildren
    setTimeout(() => {
      rec.backoff = Math.min(rec.backoff * 2, 15000);
      start(name, rec.argv, rec.env, { ...rec.opts, backoff0: rec.backoff });
    }, rec.backoff);
  };
  // A failed spawn (ENOENT/EACCES) emits 'error', NOT 'exit'; without this
  // handler the unhandled event would kill gsup — i.e. kill the guest init.
  child.on('error', (e) => restart(`spawn error ${e.code || e.message}`));
  child.on('exit', (code, sig) => restart(`exited code=${code} sig=${sig}`));
  log(`started ${name} pid=${child.pid ?? '(pending)'}`);
  return child;
}

// --- attested model volumes --------------------------------------------------
// Large read-only weights (GGUF/ONNX/diffusion checkpoints) reach tenants the
// way Tinfoil's Modelwrap delivers them: as dm-verity-protected read-only
// images mounted in the CVM, never as bytes the guest has to trust the host
// for. Each volume is one host file (ext4 + an appended verity hash tree,
// built by metal/volumes.mjs) attached as a virtio-blk disk; the guest sets
// dm-verity up ITSELF against the root hash from fw_cfg, so every block a
// tenant reads is hash-checked on the way in and a tampered image fails with
// an I/O error instead of serving different weights.
//
// The binding that makes this ATTESTED rather than merely checksummed: the
// launcher puts sha256(volume table) in the CPU's HOST_DATA field, which the
// hardware signs into every attestation report this VM produces. We ask the
// CPU for a report here, read HOST_DATA back out of it, and refuse to mount
// ANYTHING unless it matches the table the host handed us over fw_cfg. So a
// host cannot add, drop, or swap a model without it showing up in every quote,
// and a remote verifier who reads the table out of the RAD can hash it and
// compare (metal/verify.mjs does exactly that).
//
// HOST_DATA rather than the measured cmdline: it binds host-supplied config to
// the quote WITHOUT changing the launch measurement, so a box that attaches a
// model keeps the release measurement that allowlists and dist/manifest.json
// pin. Dev mode has no report and therefore no enforcement — it is unattested
// end to end by construction, and says so.
const VOL_HOST_ROOT   = '/opt/roots/wasm/vol';   // where WE mount it
const VOL_CHROOT_ROOT = '/vol';                  // the same dir as the chrooted manager sees it
const VOL_FIELDS = (v) => [v.name, v.alg || 'sha256', v.root, v.salt, v.dataBlockSize,
  v.hashBlockSize, v.dataBlocks, v.hashStartBlock, v.sd ? 1 : 0, v.gguf || ''].join('|');
// canonical volume-set digest — the SAME construction in metal/enclave-metal.mjs
// (which measures it) and metal/verify.mjs (which checks it): one line per
// volume, sorted, newline-terminated.
const volumesDigest = (vols) => createHash('sha256')
  .update(vols.map(VOL_FIELDS).sort().join('\n') + '\n').digest('hex');

function blockDevBySerial(serial) {
  for (const b of fs.readdirSync('/sys/block')) {
    for (const p of [`/sys/block/${b}/serial`, `/sys/block/${b}/device/serial`]) {
      try {
        if (fs.readFileSync(p, 'utf8').replace(/\0/g, '').trim() === serial) return `/dev/${b}`;
      } catch {}
    }
  }
  return null;
}

function mountVolumes(vols) {
  const ok = [];
  try { fs.mkdirSync(VOL_HOST_ROOT, { recursive: true }); } catch {}
  for (const v of vols) {
    try {
      const dev = blockDevBySerial(v.serial);
      if (!dev) { log(`volume ${v.name}: no attached disk with serial ${v.serial}; skipping`); continue; }
      const node = execFileSync('/opt/metal/mverity', [`mvol-${v.name}`, dev,
        String(v.dataBlockSize), String(v.hashBlockSize), String(v.dataBlocks),
        String(v.hashStartBlock), v.alg || 'sha256', v.root, v.salt]).toString().trim();
      const dir = `${VOL_HOST_ROOT}/${v.name}`;
      fs.mkdirSync(dir, { recursive: true });
      // noexec/nodev/nosuid: this is a data volume for tenants, nothing on it is
      // ever meant to run. ro is belt-and-braces — dm-verity cannot take writes.
      execFileSync('mount', ['-t', 'ext4', '-o', 'ro,nodev,nosuid,noexec', node, dir]);
      ok.push({ ...v, mounted: true });
      log(`volume ${v.name}: mounted ${VOL_CHROOT_ROOT}/${v.name} (dm-verity ${v.alg || 'sha256'}:${String(v.root).slice(0, 16)}…, ${(Number(v.bytes || 0) / 1e9).toFixed(2)} GB)`);
    } catch (e) {
      log(`volume ${v.name}: FAILED to attach (${String(e.message || e).split('\n')[0]}); skipping`);
    }
  }
  return ok;
}

// HOST_DATA, straight from the hardware: ask configfs-tsm for a report and read
// bytes 0xC0..0xDF of the SNP ATTESTATION_REPORT. Returns '' when there is no
// report to be had (dev mode / no sev-guest), which is NOT treated as a match.
function snpHostData() {
  const dir = `/sys/kernel/config/tsm/report/gsup-${process.pid}`;
  try {
    fs.mkdirSync(dir);
    try {
      fs.writeFileSync(`${dir}/inblob`, Buffer.alloc(64));
      const report = fs.readFileSync(`${dir}/outblob`);
      if (report.length < 0xe0) return '';
      return report.subarray(0xc0, 0xe0).toString('hex');
    } finally { try { fs.rmdirSync(dir); } catch {} }
  } catch { return ''; }
}

const VOL_TABLE = Array.isArray(fw.volumes) ? fw.volumes : [];
const VOL_BOUND = MODE === 'snp' ? snpHostData() : '';
let mountedVols = [];
if (VOL_TABLE.length) {
  const computed = volumesDigest(VOL_TABLE);
  if (MODE !== 'snp') {
    // Nothing to check against: an unattested guest cannot prove anything about
    // its volumes either way. Mount them so the path is exercisable in dev, and
    // be loud that this run proves nothing.
    mountedVols = mountVolumes(VOL_TABLE);
    log(`model volumes: ${mountedVols.length}/${VOL_TABLE.length} attached, set digest ${computed.slice(0, 16)}… `
      + `— NOT BOUND (mode=${MODE} has no attestation report; a real enclave binds this digest in HOST_DATA)`);
  } else if (computed !== VOL_BOUND) {
    log(`REFUSING all ${VOL_TABLE.length} model volume(s): the fw_cfg volume table digests to ${computed.slice(0, 16)}… `
      + `but the CPU's HOST_DATA says ${VOL_BOUND ? VOL_BOUND.slice(0, 16) + '…' : '(unreadable/empty)'}. `
      + `The host handed us a volume set the hardware is not attesting to — mounting it would let this enclave `
      + `serve models its quote does not name.`);
  } else {
    mountedVols = mountVolumes(VOL_TABLE);
    log(`model volumes: ${mountedVols.length}/${VOL_TABLE.length} attached, set digest ${computed.slice(0, 16)}… (bound in HOST_DATA)`);
  }
  // What the agent publishes in the RAD: the MEASURED table (so a verifier can
  // recompute the digest and the launch measurement), each entry flagged with
  // whether it actually mounted.
  try {
    fs.writeFileSync('/run/metal-volumes.json', JSON.stringify({
      digest: computed, hostData: VOL_BOUND, bound: !!VOL_BOUND && computed === VOL_BOUND,
      volumes: VOL_TABLE.map((v) => ({
        name: v.name, alg: v.alg || 'sha256', root: v.root, salt: v.salt,
        dataBlockSize: v.dataBlockSize, hashBlockSize: v.hashBlockSize,
        dataBlocks: v.dataBlocks, hashStartBlock: v.hashStartBlock,
        sd: !!v.sd, gguf: v.gguf || '', bytes: v.bytes || 0,
        mountPath: `${VOL_CHROOT_ROOT}/${v.name}`,
        mounted: mountedVols.some((m) => m.name === v.name),
      })),
    }));
  } catch (e) { log(`could not publish the volume table: ${e.message}`); }
}
const MODEL_VOLUMES = mountedVols
  .map((v) => `${v.name}:${VOL_CHROOT_ROOT}/${v.name}${v.gguf ? ':' + v.gguf : ''}`).join(',');
const MODEL_VOLUMES_SD = mountedVols.filter((v) => v.sd).map((v) => v.name).join(',');

// --- wasm-manager (chroot) ---------------------------------------------------
const WASM_ROOT = '/opt/roots/wasm';
const wasmImgEnv = readJson('/opt/metal/wasm-env.json', {});
start('wasm-manager',
  ['/usr/sbin/chroot', WASM_ROOT, '/usr/bin/python3', '/opt/enclave/wasm_manager.py'],
  {
    ...wasmImgEnv,
    PATH: wasmImgEnv.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    WASM_MANAGER_PORT: '8091',
    NODE_VCPUS: String(NODE_VCPUS),
    NODE_RAM_GB: String(NODE_RAM_GB),
    NODE_HAS_GPU: '0',
    WASM_CPU_WEIGHT: '100',
    WASM_ACCOUNT_STORAGE_RAM: '1',
    WASM_HEALTH_MINIMAL: '1',
    // attached model volumes: name -> path INSIDE the chroot (plus the optional
    // third field naming the one gguf to preload out of a multi-file tree). The
    // manager advertises these on /health, the supervisor republishes them on
    // /availability, and a deployment attaches them by name.
    ...(MODEL_VOLUMES ? { MODEL_VOLUMES } : {}),
    // volumes that preload through the stable-diffusion.cpp backend instead of
    // ggml — a diffusion gguf is indistinguishable from an LLM gguf by name, so
    // it has to be declared. The component filenames are the same generic
    // layout the hosted fleet uses.
    ...(MODEL_VOLUMES_SD ? {
      MODEL_VOLUMES_SD,
      ENCLAVE_SD_DIFFUSION_FILE: wasmImgEnv.ENCLAVE_SD_DIFFUSION_FILE || 'diffusion.gguf',
      ENCLAVE_SD_LLM_FILE: wasmImgEnv.ENCLAVE_SD_LLM_FILE || 'llm.gguf',
      ENCLAVE_SD_VAE_FILE: wasmImgEnv.ENCLAVE_SD_VAE_FILE || 'vae.safetensors',
    } : {}),
    SECRET,
  });

// --- supervisor (base root) --------------------------------------------------
const supEnv = {
  ...flavorEnv,                              // contract addresses, SIWE, CORS, ACME dirs, etc (non-secret)
  // override the baked flavor capacity with THIS VM's actual size (see above)
  NODE_VCPUS: String(NODE_VCPUS),
  NODE_RAM_GB: String(NODE_RAM_GB),
  NODE_GFLOPS: String(NODE_GFLOPS),
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  PORT: '8080',
  GPU_COUNT: '0',
  PROVISION_BACKEND: 'vm',
  VMMGR_URL: 'http://127.0.0.1:8091',
  // metal-agent serves the Remote Attestation Document here; this override
  // replaces the Tinfoil shim's loopback endpoint with no supervisor changes.
  ATTESTATION_URL: 'http://127.0.0.1:8443/.well-known/enclave-attestation',
  RAD_CACHE_MS: '15000',
  PUBLIC_URL,
  // Selling off (no registryKey): the enclave serves over the tunnel but never
  // advertises on the registry or claims paid work — the safe dev default.
  // Selling on: register + claim + earn with the config-supplied EOA; the
  // rev-7 ledger pays its runner share to that EOA and the supervisor's
  // payout loop sweeps it to PAYOUT_ADDRESS (the seller's own wallet).
  REGISTRY_ENABLED: SELLING ? '1' : '0',
  CLAIM_ENABLED: SELLING ? '1' : '0',
  ...(SELLING ? {
    REGISTRY_PRIVATE_KEY: REGISTRY_KEY,
    ENCLAVE_REPO: flavorEnv.ENCLAVE_REPO || 'EnclaveHost/enclave',
  } : {}),
  // Bring-your-own ZeroSSL EAB (config acmeEabKid/acmeEabHmac): activates the
  // supervisor's default slot-1 ZeroSSL directory ahead of the Let's Encrypt
  // fallback. Only ever set as a pair — half a pair is a config error the
  // supervisor would warn about and skip anyway.
  ...(fw.acmeEabKid && fw.acmeEabHmac ? {
    ACME_EAB_KID: fw.acmeEabKid, ACME_EAB_HMAC: fw.acmeEabHmac,
  } : {}),
  // seller asking prices: config carries USD/hour for a FULL node / FULL card,
  // the supervisor wants the ledger's USDC 6dp per SECOND. The box then refuses
  // work paying less than this and advertises the ask. GPU pricing is dropped on
  // a CPU-only enclave (nothing to sell) — see PRICE_* below.
  ...(PRICE_CPU6 > 0 ? { SELL_CPU_PRICE6: String(PRICE_CPU6) } : {}),
  ...(HAS_GPU && PRICE_GPU6 > 0 ? { SELL_GPU_PRICE6: String(PRICE_GPU6) } : {}),
  ...(PAYOUT_ADDR ? { PAYOUT_ADDRESS: PAYOUT_ADDR } : {}),
  // without the FLEET secret, relay-staged deployment secrets can't be
  // fetched (the auth key derives from it) - report the capability honestly
  // so the fleet-AND hides the feature instead of stranding secret-bearing
  // deploys on this box
  // Either credential authenticates a secrets fetch: the shared fleet HMAC, or
  // THIS box's registry key signing the same tuple (the relay checks it against
  // the endpoint's on-chain operator, then against the lease holder). The
  // second is what a self-hosted seller can hold — the fleet SECRET also
  // derives the DNS-TXT key, which would let this box mint a certificate for
  // any deployment hostname on the platform, and on metal it lives in an
  // operator-readable file outside the CVM. So: registry key is enough.
  SECRETS_CAPABLE: (FLEET_SECRET || REGISTRY_KEY) ? '1' : '0',
  SECRET,
  ADMIN_TOKEN,
  NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
};
start('supervisor', ['/usr/local/bin/node', '/app/supervisor.js'], supEnv, { cwd: '/app' });

// --- metal-agent -------------------------------------------------------------
start('metal-agent', ['/usr/local/bin/node', '/opt/metal/agent.mjs'], {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  METAL_MODE: MODE,
  METAL_NAME: NAME,
  METAL_PUBLIC_URL: PUBLIC_URL,
  METAL_RELAY_URL: RELAY_URL,
  METAL_RELAY_HOST: fw.relayHost || '',           // Host/SNI override when dialing via an egress helper
  METAL_TUNNEL_TOKEN: TUNNEL_TOKEN,
  METAL_SUP_URL: 'http://127.0.0.1:8080',
  METAL_RAD_PORT: '8443',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
  SECRET,
});

// --- shielded GPU: prove the path at boot, then get out of the way -----------
// If the host advertises a shielded worker, run one real masked field GEMM
// against it and log the verdict. This is a PROBE, not a service: it exits, and a
// failure is never fatal to the box. A CPU enclave that cannot reach the card
// must keep serving CPU work rather than refusing to boot, and the fleet learns
// the shielded path is down from the probe's verdict, not from a dead box.
//
// It is deliberately at boot rather than on demand. The failure this catches --
// a worker that is absent, wrong-version, or quietly returning garbage -- is one
// you want to find before a tenant's request depends on it.
if (fw.shieldedWorker && fw.shieldedWorker.port) {
  const { host = '10.0.2.2', port } = fw.shieldedWorker;
  const probe = spawn('/usr/local/bin/node',
    ['/opt/metal/shielded-probe.mjs', '--host', String(host), '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  probe.stdout.on('data', (d) => { buf += d; });
  probe.stderr.on('data', (d) => log(`shielded-probe: ${String(d).trim()}`));
  probe.on('error', (e) => log(`shielded-probe spawn failed: ${e.message}`));
  // Where the supervisor looks for the verdict. A FILE rather than an env var,
  // deliberately: the supervisor is already running by the time the probe
  // finishes (the probe waits for a worker that spends ~10 s importing torch),
  // so an env var would have to be set before the answer existed. A file also
  // means the box stops advertising the card the moment the probe stops passing,
  // instead of carrying a boot-time claim until the next restart.
  const VERDICT = '/run/shielded-gpu.json';
  const clearVerdict = () => { try { fs.unlinkSync(VERDICT); } catch {} };
  clearVerdict();
  probe.on('exit', (code) => {
    let v = null;
    try { v = JSON.parse(buf); } catch {}
    if (code === 0 && v && v.ok && v.card) {
      // Only a PASSING probe posts capacity. Advertising a card whose masked
      // round trip did not come back exact, or whose worker did not refuse a
      // denylisted op, would sell something we have not shown works.
      // The ask travels with the verdict, not beside it, for the same reason the
      // verdict gates the capacity: a price is only meaningful for hardware the
      // box has shown it can actually drive. No pass, no file, no price.
      const priceSec6 = usdHrToSec6(Number(fw.shieldedWorker.priceUsdHr));
      if (!priceSec6)
        log('shielded GPU has no priceUsdHr — its card sells at the supervisor default');
      try {
        // vsock rides with the endpoint only if THIS guest has the device: the
        // modules are in the image, but a kernel without them, or a host that
        // did not attach one, must leave tenants on TCP rather than on an
        // address nothing answers.
        const vsockPort = Number(fw.shieldedWorker.vsockPort) > 0 && fs.existsSync('/dev/vsock')
          ? Number(fw.shieldedWorker.vsockPort) : 0;
        if (Number(fw.shieldedWorker.vsockPort) > 0 && !vsockPort)
          log('shielded worker offers vsock but this guest has no /dev/vsock; tenants stay on TCP');
        fs.writeFileSync(VERDICT, JSON.stringify({
          ...v.card, endpoint: `${host}:${port}`,
          ...(vsockPort ? { vsockPort } : {}),
          ...(priceSec6 ? { pricePerSec6: priceSec6 } : {}),
          exact: v.exact, verified: v.verified, lie_rejected: v.lie_rejected,
          denylist_refused: v.denylist_refused,
          round_trip_ms: v.round_trip_ms, at: new Date().toISOString(),
        }));
      } catch (e) { log(`shielded verdict not written: ${e.message}`); }
    } else {
      clearVerdict();
    }
    if (code === 0 && v) {
      log(`shielded GPU OK: ${v.worker?.device} at ${host}:${port} — exact=${v.exact} `
        + `verified=${v.verified} lie_rejected=${v.lie_rejected} denylist=${v.denylist_refused} `
        + `corr=${v.transcript_correlation} chi2=${v.transcript_chi2} `
        + `rt=${v.round_trip_ms}ms warm (${v.cold_round_trip_ms}ms cold, kernel compile)`
        + (v.waited_ms > 1000 ? ` after waiting ${(v.waited_ms / 1000).toFixed(1)}s for the worker` : '')
        + (v.card ? ` — advertising ${v.card.vram_free_gb}/${v.card.vram_total_gb} GB, `
                    + `${Math.round(v.card.field_gmac_per_s)} G-MAC/s` : ''));
    } else {
      log(`shielded GPU UNAVAILABLE (probe exit ${code}); the box keeps serving CPU work`);
    }
    if (code === 0 && v && v.ok && v.card) startShieldedRefresh(host, port, VERDICT, clearVerdict);
  });
}

// --- keeping the advertised card HONEST between probes ------------------------
// The probe proves the path once; free VRAM is not a property of the path, it is
// a property of a machine we do not control. The host keeps using its own card
// -- observed live 2026-08-26: 6.5 of 7.7 GB went to a game, the box correctly
// advertised 0.4 GB free, the game exited, and the box went on advertising 0.4 GB
// because the verdict was written once at boot and never rewritten. A frozen
// number is wrong in both directions: it strands a card that has come free, and
// it oversells one that has since been taken.
//
// So the LIVE numbers get refreshed and the PROOF does not. HELLO returns the
// driver's own mem_get_info plus the worker's measured throughput, which costs
// one round trip and no GPU work -- re-running the full masked GEMM every minute
// to learn a memory figure would burn the card to answer a question it is
// already answering for free. exact/verified/lie_rejected/denylist_refused are
// properties of the worker's CODE, not of this minute, and are carried forward
// untouched; if the worker is replaced the connection breaks and we stop
// advertising, which is the outcome that matters.
const SHIELDED_REFRESH_MS = Number(process.env.SHIELDED_REFRESH_MS || 30_000);
const SHIELDED_REFRESH_STRIKES = 3;   // ~90 s of silence before the card comes down
function startShieldedRefresh(host, port, VERDICT, clearVerdict) {
  let strikes = 0;
  const tick = async () => {
    let link = null;
    try {
      const { ShieldedLink, CMD } = await import('/opt/metal/shielded.mjs');
      link = new ShieldedLink(host, port, { timeoutMs: 10_000 });
      await link.connect();
      const hello = JSON.parse((await link.call(CMD.HELLO, (() => {
        const b = Buffer.alloc(4); b.writeUInt32LE(1, 0); return b;   // protocol major
      })())).toString());
      const cur = JSON.parse(fs.readFileSync(VERDICT, 'utf8'));
      const GB = 1 << 30;
      const next = { ...cur, at: new Date().toISOString() };
      if (Number.isFinite(hello.vram_free))  next.vram_free_gb  = +(hello.vram_free / GB).toFixed(2);
      if (Number.isFinite(hello.vram_total)) next.vram_total_gb = +(hello.vram_total / GB).toFixed(2);
      if (Number.isFinite(hello.vram_budget)) next.vram_budget_gb = +(hello.vram_budget / GB).toFixed(2);
      if (Number.isFinite(hello.field_gmac_per_s)) next.field_gmac_per_s = hello.field_gmac_per_s;
      // A budget the host can no longer honour is not capacity: cap what we
      // advertise at what the driver says is actually there.
      if (next.vram_budget_gb > 0 && next.vram_free_gb >= 0)
        next.vram_free_gb = Math.min(next.vram_free_gb, next.vram_budget_gb);
      fs.writeFileSync(VERDICT, JSON.stringify(next));
      strikes = 0;
    } catch (e) {
      if (++strikes >= SHIELDED_REFRESH_STRIKES) {
        clearVerdict();
        log(`shielded GPU withdrawn after ${strikes} failed refreshes (${e.message}); `
          + `the box keeps serving CPU work`);
        strikes = 0;
      }
    } finally { try { link?.close(); } catch {} }
  };
  const t = setInterval(tick, SHIELDED_REFRESH_MS);
  t.unref?.();
  tick();
}

process.on('SIGTERM', () => { log('SIGTERM; stopping'); for (const { child } of children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } setTimeout(() => process.exit(0), 1500); });
log('all services launched');
