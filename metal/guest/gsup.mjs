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
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';

const log = (...a) => { try { fs.writeSync(1, `[gsup] ${a.join(' ')}\n`); } catch {} };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

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
const MODE         = fw.mode || cmdMode || 'snp';      // snp | tdx | dev
const NAME         = fw.name || 'metal0';
const PUBLIC_URL   = fw.publicUrl || '';               // e.g. https://metal0.enclave.host
const RELAY_URL    = fw.relayUrl || '';                // wss://api.enclave.host/v1/fleet-tunnel
const TUNNEL_TOKEN = fw.tunnelToken || '';

const flavorEnv = readJson('/opt/metal/flavor-env.json', {});   // baked, non-secret

// --- per-boot secrets (minted in-CVM, never leave it) ------------------------
const SECRET       = randomBytes(32).toString('hex');
const ADMIN_TOKEN  = randomBytes(32).toString('hex');
log(`mode=${MODE} name=${NAME} public=${PUBLIC_URL || '(none)'} relay=${RELAY_URL ? 'set' : '(none)'}`);

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

// --- wasm-manager (chroot) ---------------------------------------------------
const WASM_ROOT = '/opt/roots/wasm';
const wasmImgEnv = readJson('/opt/metal/wasm-env.json', {});
start('wasm-manager',
  ['/usr/sbin/chroot', WASM_ROOT, '/usr/bin/python3', '/opt/enclave/wasm_manager.py'],
  {
    ...wasmImgEnv,
    PATH: wasmImgEnv.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    WASM_MANAGER_PORT: '8091',
    NODE_VCPUS: flavorEnv.NODE_VCPUS || '16',
    NODE_RAM_GB: flavorEnv.NODE_RAM_GB || '64',
    NODE_HAS_GPU: '0',
    WASM_CPU_WEIGHT: '100',
    WASM_ACCOUNT_STORAGE_RAM: '1',
    WASM_HEALTH_MINIMAL: '1',
    SECRET,
  });

// --- supervisor (base root) --------------------------------------------------
const supEnv = {
  ...flavorEnv,                              // contract addresses, SIWE, CORS, ACME dirs, etc (non-secret)
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
  // self-hosted: reachability + claims are handled by the fleet tunnel, not the
  // on-chain registry, so keep both off until the operator funds an EOA.
  REGISTRY_ENABLED: '0',
  CLAIM_ENABLED: '0',
  SECRET,
  ADMIN_TOKEN,
};
start('supervisor', ['/usr/local/bin/node', '/app/supervisor.js'], supEnv, { cwd: '/app' });

// --- metal-agent -------------------------------------------------------------
start('metal-agent', ['/usr/local/bin/node', '/opt/metal/agent.mjs'], {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  METAL_MODE: MODE,
  METAL_NAME: NAME,
  METAL_PUBLIC_URL: PUBLIC_URL,
  METAL_RELAY_URL: RELAY_URL,
  METAL_TUNNEL_TOKEN: TUNNEL_TOKEN,
  METAL_SUP_URL: 'http://127.0.0.1:8080',
  METAL_RAD_PORT: '8443',
  SECRET,
});

process.on('SIGTERM', () => { log('SIGTERM; stopping'); for (const { child } of children.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } setTimeout(() => process.exit(0), 1500); });
log('all services launched');
