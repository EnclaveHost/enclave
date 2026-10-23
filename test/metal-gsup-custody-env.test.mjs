// metal0's control image must hand its supervisor the MEASURED custody vaults (docs/security/secret-custody-v2.md): the
// running ed918e4b image (overlay deabf8f90) dropped them, so its supervisor refuses every v2 (and v1) custody release with
// "CUSTODY_VAULT_V2 is not set" (work/custody-recipient-provenance-20261023). What must hold, tested on the REAL code paths:
//   1. gsup.mjs, actually RUN (test/helpers/gsup-env-harness.mjs: only its child_process and guest-only file paths are
//      faked), hands the supervisor CUSTODY_VAULT / CUSTODY_CHAIN_ID / CUSTODY_VAULT_V2 = the Oct-14 measured constants;
//   2. no host input moves them: fw_cfg fields named like them are ignored, and a baked flavor-env value is overridden;
//   3. the supervisor, given exactly that captured environment, signs a guest's v2 request for 0xe486... (the v2 operator
//      message, recoverable to the operator), refuses another vault, and keeps the owner-committed (direct) vault rule;
//   4. control: the same harness on the unmodified deabf8f90 gsup yields NO custody vaults (the regression is detected).
// The operator key is generated per run (viem generatePrivateKey): a throwaway, never a real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(REPO, 'test/helpers/gsup-env-harness.mjs');
const V1 = '0x08074300f75e78212ae10ebd14984f78e17811a6', V2 = '0xe48699b8401564aace7a814ae4569b67a3f7eef5';
const OTHER = '0x' + '99'.repeat(20);
const CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app';   // production's
const FWCFG = '/sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.metal/raw';
const key = generatePrivateKey();
const operator = privateKeyToAccount(key).address;

async function runGsup(gsupFile, { fw = {}, flavor = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsup-env-'));
  try {
    const out = path.join(dir, 'supervisor-spawn.json');
    const H = { out, files: { '/proc/cmdline': CMDLINE + '\n', [FWCFG]: JSON.stringify(fw), '/opt/metal/flavor-env.json': JSON.stringify(flavor) } };
    await pexec(process.execPath, ['--import', HARNESS, gsupFile], { env: { PATH: process.env.PATH, GSUP_HARNESS: JSON.stringify(H) }, cwd: dir, timeout: 30000 });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const FW = { name: 'metal0', publicUrl: 'https://api.enclave.host/t/metal0', relayUrl: 'wss://api.enclave.host/v1/fleet-tunnel', registryKey: key,
  nodeRamGb: 96, isolation: { managerUrl: 'http://10.0.2.2:8095', pairingKey: 'ab'.repeat(32), dataAddr: '10.0.2.2:8096', release: true } };
// host-controlled fields that look like the vaults: gsup must not read any of them
const HOSTILE_FW = { ...FW, CUSTODY_VAULT_V2: OTHER, custodyVaultV2: OTHER, CUSTODY_VAULT: OTHER, custodyVault: OTHER, env: { CUSTODY_VAULT_V2: OTHER } };

test('gsup, actually run, hands the supervisor the measured v1/v2 custody vaults and chain', async () => {
  const s = await runGsup(path.join(REPO, 'metal/guest/gsup.mjs'), { fw: FW });
  assert.deepEqual(s.argv, ['/usr/local/bin/node', '/app/supervisor.js']);
  assert.equal(s.env.CUSTODY_VAULT_V2, V2);
  assert.equal(s.env.CUSTODY_VAULT, V1);
  assert.equal(s.env.CUSTODY_CHAIN_ID, '8453');
  // the rest of the legacy path is the deabf8f90 behaviour: a selling, per-app-isolation, release-opted-in box
  assert.equal(s.env.REGISTRY_ENABLED, '1');
  assert.equal(s.env.ISOLATION_BACKEND, 'snp-guest-per-app');
  assert.equal(s.env.ISOLATION_RELEASE, '1');
  assert.equal(s.env.PUBLIC_URL, 'https://api.enclave.host/t/metal0');
});

test('no host input moves the vaults: fw_cfg look-alikes are ignored and a baked flavor value is overridden', async () => {
  const s = await runGsup(path.join(REPO, 'metal/guest/gsup.mjs'), { fw: HOSTILE_FW, flavor: { CHAIN_ID: '8453', CUSTODY_VAULT_V2: OTHER, CUSTODY_VAULT: OTHER, CUSTODY_CHAIN_ID: '1' } });
  assert.equal(s.env.CUSTODY_VAULT_V2, V2);
  assert.equal(s.env.CUSTODY_VAULT, V1);
  assert.equal(s.env.CUSTODY_CHAIN_ID, '8453');
});

test('control: the unmodified deabf8f90 gsup hands the supervisor NO custody vaults (the regression this restores)', async (t) => {
  const dir = fs.mkdtempSync(path.join(REPO, 'metal/guest/.control-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // a byte copy of the committed deabf8f90 file, beside the real bundles it imports (same relative import paths)
  const old = execFileSync('git', ['-C', REPO, 'show', 'deabf8f90f64902d20d48620fd911d34c445859d:metal/guest/gsup.mjs']);
  for (const f of fs.readdirSync(path.join(REPO, 'metal/guest'))) if (/\.mjs$/.test(f) && f !== 'gsup.mjs') fs.copyFileSync(path.join(REPO, 'metal/guest', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'gsup.mjs'), old);
  const s = await runGsup(path.join(dir, 'gsup.mjs'), { fw: FW });
  assert.deepEqual(s.argv, ['/usr/local/bin/node', '/app/supervisor.js']);
  assert.equal(s.env.CUSTODY_VAULT_V2, undefined);
  assert.equal(s.env.CUSTODY_VAULT, undefined);
});

// ---- the supervisor, run with exactly the captured environment's custody fields ----
const SUPERVISOR = path.join(REPO, 'supervisor.js');
const QUIET = { INSTANCE_SELFTEST: '', POOL_SELFTEST: '', SWEEP_SELFTEST: '', REACH_SELFTEST: '', ACME_SELFTEST: '', CFG_EDIT_SELFTEST: '',
  ISOLATION_SELFTEST: '', GUEST_POOL_SELFTEST: '', GUESTD_TRANSPORT_SELFTEST: '', ADDRESS_BOOK_ADDRESS: '', REGISTRY_ENABLED: '', CLAIM_ENABLED: '',
  ACME_EAB_KID: '', ACME_EAB_HMAC: '', APP_CERT_DOMAIN: '', DNS_API: '', ISOLATION_RELEASE: '', ENABLE_MPS: '0',
  CUSTODY_VAULT: '', CUSTODY_VAULT_V2: '', CUSTODY_CHAIN_ID: '' };
const ID = '0x' + 'a6'.repeat(32), BINDING = 'c2'.repeat(32);
async function pump(custodyEnv, c) {
  const relay = http.createServer((q, r) => { r.statusCode = 503; r.end('{}'); });   // never asked: these guests await custody auth, not tickets
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  try {
    const env = { ...process.env, SECRET: 'test-secret', ...QUIET, ...custodyEnv, SECRETS_API: `http://127.0.0.1:${relay.address().port}`,
      REGISTRY_PRIVATE_KEY: key, ISOLATION_BACKEND: 'snp-guest-per-app',
      RELEASE_SELFTEST: JSON.stringify({ id: ID, vmId: 'gd01020304', endpoint: 'https://api.enclave.host/t/metal0', ...c }) };
    const { stdout } = await pexec(process.execPath, [SUPERVISOR], { env, timeout: 60000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } finally { relay.close(); }
}
const custodyOf = (env) => Object.fromEntries(['CUSTODY_VAULT', 'CUSTODY_VAULT_V2', 'CUSTODY_CHAIN_ID'].filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const ask = (vault) => ({ status: 'starting', awaitingCustodyAuth: { v: 2, vault, binding: BINDING } });

test('the supervisor, given the captured gsup environment, signs v2 for 0xe486 only and keeps the committed-vault rule', async () => {
  const { operatorMessage } = await import('../custody/v2/protocol.mjs');
  const captured = custodyOf((await runGsup(path.join(REPO, 'metal/guest/gsup.mjs'), { fw: HOSTILE_FW })).env);
  assert.deepEqual(captured, { CUSTODY_VAULT: V1, CUSTODY_CHAIN_ID: '8453', CUSTODY_VAULT_V2: V2 });
  // the measured vault: exactly one authorization, over the v2 message, by this endpoint's operator
  const ok = await pump(captured, { script: [ask(V2), ask(V2), { status: 'running' }] });
  const posts = ok.posts.filter((p) => p.path.endsWith('/custody-auth'));
  assert.equal(posts.length, 1);
  const a = posts[0].custody;
  const msg = operatorMessage({ chainId: 8453, vault: V2, id: ID, endpoint: 'https://api.enclave.host/t/metal0', binding: Buffer.from(BINDING, 'hex'), expiry: a.expiry });
  assert.equal(await recoverMessageAddress({ message: msg, signature: a.sig }), operator);
  // another vault: nothing signed
  const wrong = await pump(captured, { script: [ask(OTHER), ask(OTHER), { status: 'running' }] });
  assert.equal(wrong.posts.filter((p) => p.path.endsWith('/custody-auth')).length, 0);
  assert.ok(wrong.logs.some((l) => /v2 vault this box does not serve/.test(l)));
  // an owner-committed (direct) startup: its committed vault is signed even though it is not the measured one ...
  const committed = '0x' + '88'.repeat(20);
  const directManifest = { secretsMode: 'custody-v2', custody: { vault: committed } };
  const direct = await pump(captured, { directManifest, script: [ask(committed), { status: 'running' }] });
  assert.equal(direct.posts.filter((p) => p.path.endsWith('/custody-auth')).length, 1);
  // ... and a guest asking for the measured vault against a different owner commitment is refused
  const mismatch = await pump(captured, { directManifest, script: [ask(V2), { status: 'running' }] });
  assert.equal(mismatch.posts.length, 0);
  assert.ok(mismatch.logs.some((l) => l.includes('differs from owner')));
  // control: the regression's environment (no vaults) refuses the same request
  const none = await pump({}, { script: [ask(V2), ask(V2), { status: 'running' }] });
  assert.equal(none.posts.filter((p) => p.path.endsWith('/custody-auth')).length, 0);
  assert.ok(none.logs.some((l) => /CUSTODY_VAULT_V2 is not set/.test(l)));
});
