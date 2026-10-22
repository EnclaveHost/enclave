#!/usr/bin/env node
// EAB1 tool: build the cutover account-binding snapshot, write the private per-account bundles, and let owners verify.
// Protocol: ../PROTOCOL-EAB1.md. The app-side verifier is ../candidate/eab1.rs; both build the SAME tree (shared vector).
//
//   snapshot   --accounts <relay accounts.json> --cutover <id> --out <dir> [--issued-at <rfc3339>]
//              Reads the relay account store ({accounts: {acct_…: {wallets, passkeys}}}) - run by the relay operator,
//              once, at cutover, on the machine that holds it. Writes:
//                <dir>/statement.json   PUBLIC: {cutover, root, leaves, accounts, issued_at, text} - the text to sign
//                <dir>/bundles/<acct>.json  PRIVATE (0600): each account's recovery kit
//                <dir>/report.json      PRIVATE (0600): counts; the ids of accounts with no credential (not committed, cannot
//                                       migrate) and of passkey-only ones (they migrate through their passkey vault where
//                                       owners pin migration.vault_factory)
//              Prints only counts and the root. Never prints a mapping.
//   attach     --statement <statement.json> --signature 0x<130 hex> --signer 0x<40 hex>   (after the operator signs `text`)
//   verify-statement --statement <statement.json> [--signer 0x…]      checks the signature (what an owner runs before pinning)
//   config     --statement <statement.json>    prints the unsigned `migration` config block owners add (no submission)
//   config     … [--vault-factory 0x… --vault-implementation 0x…]   adds the passkey-vault pin (the address book's
//              vaultFactory, and its implementation()) so committed passkeys can prove through their vaults
//   vault      --bundle <file> --vault-factory 0x… --vault-implementation 0x…   prints each committed passkey's vault
//              address (the address a passkey-only account signs in as)
//   credential --bundle <file>                 prints the EAB1.<base64url> account proof a user pastes into an app
//   verify     --statement <statement.json> --bundle <file> [--wallet 0x…]   checks a bundle against the snapshot (depot
//              owners: then they list wallet_<addr> under that user's `accounts`, after the wallet signs for it)
//
// viem (keccak256, signature recovery) is taken from VIEM_DIR (default: the enclave repository's node_modules).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const VIEM_DIR = process.env.VIEM_DIR || '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem';
const viem = await import(createRequire(import.meta.url).resolve(VIEM_DIR));
const { keccak256, recoverMessageAddress, bytesToHex, hexToBytes } = viem;

const enc = new TextEncoder();
const lp = (s) => { const b = enc.encode(s); const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length); out.set(b, 4); return out; };
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const k = (...parts) => hexToBytes(keccak256(cat(...parts)));
const cmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
export const leaf = (cutover, account, kind, value, salt) => k(Uint8Array.of(0), enc.encode('EAB1-leaf'), lp(cutover), lp(account), lp(kind), lp(value), salt);
export const node = (a, b) => (cmp(a, b) <= 0 ? k(Uint8Array.of(1), a, b) : k(Uint8Array.of(1), b, a));
export const statementText = ({ cutover, root, leaves, accounts, issued_at }) =>
  `EAB1 account binding snapshot\nCutover: ${cutover}\nRoot: ${root}\nLeaves: ${leaves}\nAccounts: ${accounts}\nIssued At: ${issued_at}`;
const CUTOVER = /^[a-z0-9-]{1,64}$/, ACCT = /^acct_[0-9a-f]{24}$/, ADDR = /^0x[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;

/** The credentials an account record commits: its wallets, and its P-256 passkeys (relay auth.js addPasskey shape). */
export function credentialsOf(rec) {
  const out = [];
  for (const w of rec.wallets || []) {
    const a = String(w).toLowerCase();
    if (!ADDR.test(a)) throw new Error(`${rec.id}: a wallet that is not an address`);
    out.push(['wallet', a]);
  }
  for (const p of rec.passkeys || []) {
    const x = String(p.pubX || '').replace(/^0x/, '').toLowerCase(), y = String(p.pubY || '').replace(/^0x/, '').toLowerCase();
    if (HEX64.test(x) && HEX64.test(y) && /^[A-Za-z0-9_-]{1,512}$/.test(p.credId || '')) out.push(['passkey', `p256:${x}:${y}:${p.credId}`]);
  }
  return out;
}

/** Build the tree. accounts: [{id, salt (Uint8Array 32), creds: [[kind, value], …]}]. Same rules as eab1.rs. */
export function buildTree(cutover, accounts) {
  const leaves = [];
  accounts.forEach((a, ai) => a.creds.forEach(([kind, value], ci) => leaves.push({ h: leaf(cutover, a.id, kind, value, a.salt), ai, ci })));
  if (!leaves.length) throw new Error('nothing to commit');
  leaves.sort((x, y) => cmp(x.h, y.h));
  const levels = [leaves.map((l) => l.h)];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1), up = [];
    for (let i = 0; i < l.length; i += 2) up.push(i + 1 < l.length ? node(l[i], l[i + 1]) : l[i]);
    levels.push(up);
  }
  const pathOf = (i) => { const p = []; for (const l of levels.slice(0, -1)) { const s = i ^ 1; if (s < l.length) p.push(bytesToHex(l[s])); i >>= 1; } return p; };
  const root = levels.at(-1)[0];
  const bundles = accounts.map((a, ai) => ({
    v: 1, kind: 'EAB1-bundle', cutover, root: bytesToHex(root), account: a.id, salt: bytesToHex(a.salt),
    credentials: a.creds.map(([kind, value], ci) => ({ kind, value, path: pathOf(leaves.findIndex((l) => l.ai === ai && l.ci === ci)) })),
  }));
  return { root: bytesToHex(root), leaves: leaves.length, bundles };
}

/** Check a bundle against a statement the way the app does: every credential reaches the root. */
export function checkBundle(statement, bundle) {
  if (bundle.v !== 1 || bundle.kind !== 'EAB1-bundle') throw new Error('not an EAB1 bundle');
  if (bundle.cutover !== statement.cutover || bundle.root !== statement.root) throw new Error('made for another snapshot');
  if (!ACCT.test(bundle.account) || !/^0x[0-9a-f]{64}$/.test(bundle.salt)) throw new Error('malformed bundle');
  const salt = hexToBytes(bundle.salt);
  for (const c of bundle.credentials) {
    const h = c.path.reduce((acc, s) => node(acc, hexToBytes(s)), leaf(bundle.cutover, bundle.account, c.kind, c.value, salt));
    if (bytesToHex(h) !== statement.root) throw new Error(`credential ${c.kind} is not in the snapshot (corrupted or forged)`);
  }
  return { account: bundle.account, wallets: bundle.credentials.filter((c) => c.kind === 'wallet').map((c) => c.value),
           passkeys: bundle.credentials.filter((c) => c.kind === 'passkey').length };
}

export const credential = (bundleText) => 'EAB1.' + Buffer.from(bundleText).toString('base64url');

/** vaultFor(x, y) of the original EnclaveCreditVaultFactory: CREATE2 of the EIP-1167 clone of `implementation`. */
export function vaultFor(factory, implementation, x, y) {
  const code = viem.concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementation.toLowerCase(), '0x5af43d82803e903d91602b57fd5bf3']);
  const salt = keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(x), BigInt(y)]));
  return viem.getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecode: code }).toLowerCase();
}
/** p256:<x>:<y>:<credId> -> { x: 0x…, y: 0x…, credId } */
export const passkeyParts = (value) => { const [, x, y, credId] = value.split(':'); return { x: '0x' + x, y: '0x' + y, credId }; };

export async function verifyStatement(st, signer) {
  if (!st.signature) throw new Error('the statement is not signed yet');
  const text = statementText(st);
  if (text !== st.text) throw new Error('the statement text does not match its fields');
  const got = (await recoverMessageAddress({ message: text, signature: st.signature })).toLowerCase();
  if (got !== String(signer || st.signer).toLowerCase()) throw new Error(`signed by ${got}, not the expected signer`);
  return got;
}

// ---- CLI ----
const args = process.argv.slice(2), cmd = args[0];
const opt = (k) => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : undefined; };
const need = (k) => { const v = opt(k); if (v === undefined) { console.error(`--${k} is required`); process.exit(2); } return v; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writePrivate = (f, s) => { fs.writeFileSync(f, s, { mode: 0o600 }); fs.chmodSync(f, 0o600); };

async function main() {
  if (cmd === 'snapshot') {
    const cutover = need('cutover'), out = need('out');
    if (!CUTOVER.test(cutover)) throw new Error('--cutover: 1..64 of a-z 0-9 -');
    const store = readJson(need('accounts'));
    const issued_at = opt('issued-at') || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const accounts = [], noCredential = [], walletless = [];
    for (const [id, rec] of Object.entries(store.accounts || {})) {
      if (!ACCT.test(id) || rec.id !== id) throw new Error(`a record that is not an account: ${id.slice(0, 12)}…`);
      const creds = credentialsOf(rec);
      if (!creds.length) { noCredential.push(id); continue; }
      if (!creds.some(([kd]) => kd === 'wallet')) walletless.push(id);
      accounts.push({ id, salt: crypto.randomBytes(32), creds });
    }
    // a wallet that two accounts both claim is a store inconsistency (byWallet allows one): refuse rather than guess
    const seen = new Map();
    for (const a of accounts) for (const [kd, v] of a.creds) if (kd === 'wallet') { if (seen.has(v)) throw new Error('a wallet bound to two accounts: fix the store before cutover'); seen.set(v, a.id); }
    const t = buildTree(cutover, accounts);
    fs.mkdirSync(path.join(out, 'bundles'), { recursive: true, mode: 0o700 });
    const statement = { v: 1, cutover, root: t.root, leaves: t.leaves, accounts: accounts.length, issued_at };
    statement.text = statementText(statement);
    statement.signer = null; statement.signature = null;
    fs.writeFileSync(path.join(out, 'statement.json'), JSON.stringify(statement, null, 1) + '\n');
    for (const b of t.bundles) writePrivate(path.join(out, 'bundles', `${b.account}.json`), JSON.stringify(b));
    writePrivate(path.join(out, 'report.json'), JSON.stringify({ committed: accounts.length, leaves: t.leaves,
      no_credential: noCredential, passkey_only: walletless }, null, 1) + '\n');
    console.log(JSON.stringify({ cutover, root: t.root, leaves: t.leaves, accounts: accounts.length, no_credential: noCredential.length,
      passkey_only: walletless.length }));
  } else if (cmd === 'attach') {
    const f = need('statement'), st = readJson(f);
    st.signature = need('signature'); st.signer = need('signer').toLowerCase();
    await verifyStatement(st);
    fs.writeFileSync(f, JSON.stringify(st, null, 1) + '\n');
    console.log('attached; recovers to', st.signer);
  } else if (cmd === 'verify-statement') {
    console.log('signed by', await verifyStatement(readJson(need('statement')), opt('signer')));
  } else if (cmd === 'config') {
    const st = readJson(need('statement'));
    if (st.signature) await verifyStatement(st);
    const vf = opt('vault-factory'), vi = opt('vault-implementation');
    if (!!vf !== !!vi || (vf && !(ADDR.test(vf.toLowerCase()) && ADDR.test(vi.toLowerCase())))) throw new Error('--vault-factory and --vault-implementation go together (addresses)');
    const block = { cutover: st.cutover, root: st.root, leaves: st.leaves, accounts: st.accounts, issued_at: st.issued_at,
                    ...(st.signature ? { signer: st.signer, signature: st.signature } : {}),
                    ...(vf ? { vault_factory: { address: vf.toLowerCase(), implementation: vi.toLowerCase() } } : {}) };
    console.log(JSON.stringify({ migration: block }, null, 1));
  } else if (cmd === 'vault') {
    const b = readJson(need('bundle')), f = need('vault-factory'), i = need('vault-implementation');
    console.log(JSON.stringify(b.credentials.filter((c) => c.kind === 'passkey').map((c) => { const p = passkeyParts(c.value);
      return { credId: p.credId, vault: vaultFor(f, i, p.x, p.y) }; })));
  } else if (cmd === 'credential') {
    process.stdout.write(credential(fs.readFileSync(need('bundle'), 'utf8').trim()) + '\n');
  } else if (cmd === 'verify') {
    const r = checkBundle(readJson(need('statement')), readJson(need('bundle')));
    const w = opt('wallet');
    if (w && !r.wallets.includes(w.toLowerCase())) throw new Error('that wallet is not one this bundle commits');
    console.log(JSON.stringify({ ok: true, account: r.account, wallets: r.wallets.length, passkeys: r.passkeys,
      ...(w ? { depot_accounts_entry: `wallet_${w.toLowerCase()}` } : {}) }));
  } else if (cmd) {
    throw new Error(`unknown command ${cmd}`);
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error('eab1:', e.message); process.exit(1); });
}
