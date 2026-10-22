// `enclave --independent … custody …`: the owner's side of custody v2 with NO Enclave service in the path
// (docs/security/secret-custody-v2.md; work/custody-cli-interface.txt). Every read is one value agreed by a quorum of the
// operator's own RPCs at one confirmed block (custody/v2/quorum.mjs, custody/v2/chain.mjs); every write is signed once
// here and broadcast by the CLI's independent writer (cli/independent.mjs sendQuorumTx); every write is then read back,
// exactly, at or after its receipt block. Nothing here calls an Enclave API, the relay, or a first-answer RPC.
//
//   enclave --independent … custody status  <id>
//   enclave --independent … custody set     <id> KEY=VALUE… [--file .env] [--rules rules.json] [--committee 0x…]
//                                           [--config-file app-config.json | --no-config] [--allow-enclave-seat] [--payer-key FILE]
//   enclave --independent … custody migrate <id> --from export.json|export.enc [--passphrase-file F] (same policy options)
//   enclave --independent … custody pause   <id> | resume <id> | clear <id> --yes | claim <id>      [--payer-key FILE]
//   enclave --independent … custody seal-export --id <id> --in .env|values.json --out export.enc --passphrase-file F
//
// THE VAULT is the reviewed pin (trust.pins.secretVaultV2): with a reviewed profile its code hash and every immutable
// binding are checked at an agreed block; with --contract-pins its ledger, registry and session factory must be the pinned
// ones. THE COMMITTEE is named explicitly the first time (--committee), else it is the policy's current one: there is no
// platform default. A committee with an Enclave-operated seat is refused unless --allow-enclave-seat says so. THE RULES are
// the owner's own file, SNP (custody/rules.mjs) or Enclave Shield (custody/v2/shield-rules.mjs) by their own format, and an
// existing policy's rule BYTES are re-written verbatim (pause, resume, a set without --rules): a tier is never relabelled
// and nothing is ever lowered or defaulted. `set` and `migrate` replace the WHOLE set (custody cannot read values back).
// --payer-key: the owner signs the vault's EIP-712 Update (updateBySig) and THAT wallet only pays the gas.
import fs from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes } from "viem";
import { createChainReaderV2, VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { buildBundleV2, UPDATE_V2_ABI, UPDATE_V2_COMPONENTS, updateTypedDataV2 } from "../custody/v2/owner.mjs";
import { configTextOf, configTextFromEnvelope, configSha256, checkEnv } from "../custody/protocol.mjs";
import { validateRules, canonicalRules, parseRules } from "../custody/rules.mjs";
import { SHIELD_RULES_FORMAT, validateShieldRules, canonicalShieldRules, parseShieldRules } from "../custody/v2/shield-rules.mjs";
import { assertReviewedCode, leaseReaderClients } from "./independent.mjs";

const ID = /^0x[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/i, ZERO = /^0x0{40}$/i;
export const SIG_DEADLINE_SEC = 600;
export const EXPORT_FORMAT = "enclave-secrets-export/1";
const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const READBACK_MS = 180_000;
export const CLAIM_ABI = [
  { type: "function", name: "claimPolicy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimPolicyBySig", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "expectPolicyRev", type: "uint64" },
    { name: "deadline", type: "uint64" }, { name: "sig", type: "bytes" }], outputs: [] },
];
const USAGE = "usage: enclave --independent … custody status <id>\n"
  + "     | custody set <id> KEY=VALUE… [--file .env] [--rules rules.json] [--committee 0x…] [--config-file F | --no-config] [--allow-enclave-seat] [--payer-key FILE]\n"
  + "     | custody migrate <id> --from export.json|export.enc [--passphrase-file F] (same policy options)\n"
  + "     | custody pause <id> | resume <id> | clear <id> --yes | claim <id> [--payer-key FILE]\n"
  + "     | custody seal-export --id <id> --in .env|values.json --out export.enc --passphrase-file F";
const SUBS = ["status", "set", "migrate", "pause", "resume", "clear", "claim", "seal-export"];

// ---- the rules: SNP or Shield, by their own format; never relabelled -----------------------------------------------
/** a rules object -> { kind, bytes } (canonical) ; throws for anything neither parser admits */
export function rulesFromObject(o) {
  if (o && typeof o === "object" && o.format === SHIELD_RULES_FORMAT) return { kind: "shield", bytes: canonicalShieldRules(validateShieldRules(o)) };
  return { kind: "snp", bytes: canonicalRules(validateRules(o)) };
}
/** the policy's rule bytes as stored -> { kind, rules | error }, read by the parser of their own format */
export function describeRules(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : hexToBytes(bytes);
  try { const r = parseShieldRules(b); return { kind: "shield", tier: `${r.acceptTier} (Enclave Shield rules)`, rules: r }; } catch {}
  try { const r = parseRules(b); return { kind: "snp", tier: "sev-snp (custody rules v1)", rules: r }; } catch (e) { return { kind: "unparseable", error: e.message }; }
}

// ---- an owner-held export of values (migration without the relay) ------------------------------------------------------
const privateFile = (file, what) => {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${what} must be a regular file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error(`${what} must be private (chmod 600 ${file})`);
  return fs.readFileSync(file, "utf8");
};
const passphraseOf = (file) => { const p = privateFile(file, "--passphrase-file").replace(/\r?\n$/, ""); if (p.length < 12) throw new Error("the passphrase must be at least 12 characters"); return p; };
const aadOf = (id) => Buffer.from(`${EXPORT_FORMAT}\n${id}`);
/** env -> the encrypted export object (scrypt + AES-256-GCM), bound to the deployment id */
export function sealExport({ id, env, passphrase, _salt, _iv }) {
  if (!ID.test(id)) throw new Error("--id must be a bytes32 deployment id");
  checkEnv(env);
  const salt = _salt || randomBytes(16), iv = _iv || randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(aadOf(id));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify({ env }))), c.final()]);
  return { format: EXPORT_FORMAT, id, kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
           cipher: "aes-256-gcm", iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
/** an export file's text -> env. Plaintext: {env:{…}} (e.g. a hosted `secrets ls --show --json`), or {KEY: "value"}. */
export function openExport(text, { id, passphrase = null }) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error("--from is not JSON (a .env file is `custody set --file`)"); }
  if (o && o.format === EXPORT_FORMAT) {
    if (o.id !== id) throw new Error(`the export was sealed for ${String(o.id).slice(0, 66)}, not ${id}`);
    if (passphrase === null) throw new Error("an encrypted export needs --passphrase-file");
    if (o.kdf?.name !== "scrypt" || o.kdf.N !== SCRYPT.N || o.kdf.r !== SCRYPT.r || o.kdf.p !== SCRYPT.p || o.cipher !== "aes-256-gcm")
      throw new Error("unsupported export parameters");
    const key = scryptSync(passphrase, Buffer.from(o.kdf.salt, "base64"), 32, SCRYPT);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64")); d.setAAD(aadOf(id)); d.setAuthTag(Buffer.from(o.tag, "base64"));
    let pt;
    try { pt = Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]); } catch { throw new Error("the export does not open with this passphrase (or was altered)"); }
    const env = JSON.parse(pt.toString("utf8")).env; checkEnv(env); return env;
  }
  if (o && typeof o === "object" && !Array.isArray(o) && o.id !== undefined && String(o.id).toLowerCase() !== id)
    throw new Error(`the export names deployment ${String(o.id).slice(0, 66)}, not ${id}`);
  const env = o && typeof o.env === "object" && o.env !== null ? o.env : o;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) throw new Error("--from holds no {KEY: value} map");
  checkEnv(env);
  return env;
}

// ---- the reviewed vault -------------------------------------------------------------------------------------------------
async function verifyVault(chain, trust) {
  const vault = String(trust.pins?.secretVaultV2 || "");
  if (!ADDR.test(vault) || ZERO.test(vault)) throw new Error("independent custody needs a pinned EnclaveSecretVaultV2: a reviewed --profile, or --contract-pins naming secretVaultV2");
  const reviewed = trust.profile?.contracts?.secretVaultV2 || null;
  const want = reviewed ? Object.entries(reviewed.immutable || {})
    : [["deploymentLedger", trust.pins.deployments], ["hostRegistry", trust.pins.registry],
       ...(trust.pins.sessionVaultFactory && !ZERO.test(trust.pins.sessionVaultFactory) ? [["sessionVaultFactory", trust.pins.sessionVaultFactory]] : [])];
  if (reviewed) {
    if (reviewed.address.toLowerCase() !== vault.toLowerCase()) throw new Error("the pinned vault is not the reviewed profile's secretVaultV2");
    await assertReviewedCode(chain, trust.profile, ["secretVaultV2"]);
  }
  const s = await chain.readMany(want.map(([fn]) => ({ address: vault, abi: VAULT_V2_ABI, functionName: fn })));
  want.forEach(([fn, expected], i) => {
    if (String(s.value[i]).toLowerCase() !== String(expected).toLowerCase())
      throw new Error(`the vault's ${fn} is ${s.value[i]}, not the reviewed ${expected}: refusing this vault`);
  });
  const enclaveOwner = reviewed?.immutable?.enclaveOwner || (await chain.read(vault, VAULT_V2_ABI, "enclaveOwner"));
  return { vault: vault.toLowerCase(), codeReviewed: !!reviewed, enclaveOwner: String(enclaveOwner).toLowerCase(), block: s.blockNumber };
}

// ---- writes: the owner's own tx, or the owner's signature with a separate gas payer -------------------------------------
function loadPayer(file, owner) {
  let pk = privateFile(file, "--payer-key").trim();
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("--payer-key must hold a 32-byte hex private key");
  const payer = privateKeyToAccount(pk);
  if (payer.address.toLowerCase() === owner.address.toLowerCase()) throw new Error("--payer-key is the owner's own key: omit it");
  return payer;
}
const tupleOf = (u) => ({ expectPolicyRev: u.expectPolicyRev, setPolicy: u.setPolicy, committeeId: u.committeeId, paused: u.paused, rules: u.rules,
                          setBundle: u.setBundle, bundle: u.bundle, clear: u.clear });

/** read back through the quorum until a block at or after the receipt shows EXACTLY what was written */
async function readBack(reader, id, before, expect, receipt, { timeoutMs = READBACK_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs, minBlock = BigInt(receipt.blockNumber);
  let last = "no agreed read yet";
  while (Date.now() < until) {
    let s;
    try { s = await reader.readRelease({ id, endpoint: null }); } catch (e) { last = e.message; await sleep(1000); continue; }
    if (s.blockNumber < minBlock) { last = `agreed block ${s.blockNumber} is before the receipt's ${minBlock}`; await sleep(1000); continue; }
    const p = s.policy, wrong = [];
    if (p.policyRev !== before.policyRev + 1n) wrong.push(`policy revision ${p.policyRev}, expected ${before.policyRev + 1n}`);
    for (const [k, v] of Object.entries(expect)) {
      const got = k === "rules" ? bytesToHex(p.rules) : k === "bundle" ? bytesToHex(s.bundle.data) : k === "secretRev" ? p.secretRev : p[k];
      if (String(got).toLowerCase() !== String(v).toLowerCase()) wrong.push(`${k} ${k === "bundle" || k === "rules" ? `(${(String(got).length - 2) / 2} bytes)` : got}`);
    }
    if (wrong.length) throw new Error(`the vault at agreed block ${s.blockNumber} does not show exactly this write (${wrong.join("; ")}); nothing else was sent: check \`custody status\``);
    return s;
  }
  throw new Error(`the transaction was confirmed, but no quorum read at or after block ${minBlock} confirmed the exact state within ${Math.round(timeoutMs / 1000)}s (${last}); do not resend: check \`custody status\``);
}

export async function cmdCustodyIndependent(rest, h) {
  const sub = rest.shift();
  if (!SUBS.includes(sub || "")) throw new Error(USAGE);
  const f = h.flags(rest, { bool: ["--no-config", "--allow-enclave-seat", "--yes"], val: ["--file", "--rules", "--committee", "--config-file", "--payer-key", "--from", "--passphrase-file", "--id", "--in", "--out"] });
  for (const k of ["rules-from-relay", "admit", "v2"]) if (f[k]) throw new Error(`--${k} is not part of independent custody (no relay prediction; custody v2 is the only path)`);

  if (sub === "seal-export") {   // local only: nothing is read from or sent to any network
    const id = String(f.id || "").toLowerCase();
    if (!f.in || !f.out || !f["passphrase-file"]) throw new Error(USAGE);
    if (fs.existsSync(f.out)) throw new Error(`${f.out} exists: an export is written once`);
    const text = fs.readFileSync(f.in, "utf8");
    let env;
    try { const o = JSON.parse(text); env = openExport(JSON.stringify(o), { id }); } catch (e) { if (!/not JSON/.test(e.message) && !(e instanceof SyntaxError)) throw e; env = h.secretsKv([], f.in); }
    const out = sealExport({ id, env, passphrase: passphraseOf(f["passphrase-file"]) });
    fs.writeFileSync(f.out, JSON.stringify(out, null, 1) + "\n", { mode: 0o600, flag: "wx" });
    return h.say(`sealed ${Object.keys(env).length} value(s) for ${h.short(id)} into ${f.out} (scrypt N=${SCRYPT.N}, AES-256-GCM, bound to the deployment id): ${Object.keys(env).sort().join(", ")}`);
  }

  const id = String(f._[0] || "").toLowerCase();
  if (!ID.test(id)) throw new Error("independent custody needs the full bytes32 deployment id (no prefix lookup)");
  const { chain, trust, send } = h;
  if (!chain || !trust || typeof send !== "function") throw new Error("internal: independent custody needs the quorum chain, trust and writer");
  const owner = h.loadKey();
  if (typeof owner?.signTypedData !== "function") throw new Error("independent custody signs locally: use the wallet key (ENCLAVE_KEY or the key file)");
  const v = await verifyVault(chain, trust);
  const clients = leaseReaderClients(chain);
  const minAgree = Math.max(trust.quorum, Math.floor(clients.length / 2) + 1);
  const reader = createChainReaderV2({ clients, vault: v.vault, chainId: chain.chainId, minAgree, confirmations: trust.confirmations,
                                       maxAgeSec: Math.round(trust.maxBlockAgeMs / 1000), timeoutMs: 15000 });
  const st = await reader.readRelease({ id, endpoint: null });
  const pol = st.policy, me = owner.address.toLowerCase();
  const rulesNow = pol.policyRev ? describeRules(pol.rules) : null;

  if (sub === "status") {
    const c = st.committee;
    const out = { vault: v.vault, codeReviewed: v.codeReviewed, id, block: String(st.blockNumber), agreeing: `${minAgree} of ${clients.length} RPCs`,
                  owner: pol.policyRev ? pol.owner : null, ledgerOwner: st.lease?.owner ?? null, beneficialOwner: st.beneficialOwner,
                  claimNeeded: !!pol.policyRev && st.beneficialOwner !== pol.owner,
                  policyRev: String(pol.policyRev), secretRev: String(pol.secretRev), paused: pol.paused, committee: pol.policyRev ? pol.committeeId : null,
                  epoch: c?.epoch ?? null, threshold: c ? `${c.t} of ${c.W} shares` : null, bundleBytes: st.bundle.data.length,
                  custodians: (c?.machines || []).map((m) => `${m.endpoint}${m.enclave ? " (Enclave seat)" : ""}`),
                  tier: rulesNow ? rulesNow.tier ?? `UNPARSEABLE: ${rulesNow.error}` : null, rules: rulesNow?.rules ?? null };
    if (!pol.policyRev) out.note = "no custody v2 policy for this deployment in this vault";
    if (h.json) return h.jout(out);
    for (const [k, val] of Object.entries(out)) h.say(`${k.padEnd(15)} ${val !== null && typeof val === "object" ? JSON.stringify(val) : val}`);
    return;
  }

  // ---- authority: the vault's own rule, checked before anything is signed ---------------------------------------------
  if (sub === "claim") {
    if (!pol.policyRev || st.beneficialOwner === pol.owner) throw new Error("nothing to claim: the ledger still gives this policy to its pinned owner");
    if (st.beneficialOwner !== me) throw new Error(`only the ledger's current owner ${st.beneficialOwner} may claim this policy`);
  } else if (pol.policyRev) {
    if (st.beneficialOwner !== pol.owner) throw new Error(`the ledger moved this deployment (to ${st.beneficialOwner}); its policy is pinned to ${pol.owner}: the new owner runs \`custody claim\` first (it destroys the old bundle)`);
    if (pol.owner !== me) throw new Error(`the custody policy belongs to ${pol.owner}; this wallet is ${me}`);
  } else if (st.beneficialOwner !== me) throw new Error(`this deployment's owner is ${st.beneficialOwner || "nobody"}; this wallet is ${me}`);
  const payer = f["payer-key"] ? loadPayer(f["payer-key"], owner) : null;
  const deadline = BigInt(st.blockTimestamp + SIG_DEADLINE_SEC);

  if (sub === "claim") {
    const receipt = payer
      ? await send(payer, { address: v.vault, abi: CLAIM_ABI, functionName: "claimPolicyBySig", args: [id, pol.policyRev, deadline,
          await owner.signTypedData({ domain: { name: "EnclaveSecretVaultV2", version: "1", chainId: chain.chainId, verifyingContract: v.vault },
            types: { Claim: [{ name: "id", type: "bytes32" }, { name: "expectPolicyRev", type: "uint64" }, { name: "deadline", type: "uint64" }] },
            primaryType: "Claim", message: { id, expectPolicyRev: pol.policyRev, deadline } })] })
      : await send(owner, { address: v.vault, abi: CLAIM_ABI, functionName: "claimPolicy", args: [id] });
    const after = await readBack(reader, id, pol, { owner: me, paused: true, secretRev: pol.secretRev + 1n, bundle: "0x" }, receipt);
    return h.say(`claimed: policy ${after.policy.policyRev} now belongs to ${me}, paused, with no bundle (the previous owner's values are destroyed); set your own with \`custody set\``);
  }

  // ---- the update this command writes ---------------------------------------------------------------------------------
  let update, expect, summary;
  const ZERO32 = "0x" + "00".repeat(32);
  if (sub === "pause" || sub === "resume") {
    if (!pol.policyRev) throw new Error("no custody v2 policy to pause or resume");
    // the policy's own rule BYTES, verbatim: pausing never re-encodes or relabels the owner's rules
    update = { expectPolicyRev: pol.policyRev, setPolicy: true, committeeId: pol.committeeId, paused: sub === "pause", rules: bytesToHex(pol.rules), setBundle: false, bundle: "0x", clear: false };
    expect = { paused: sub === "pause", committeeId: pol.committeeId, rules: bytesToHex(pol.rules), secretRev: pol.secretRev, bundle: bytesToHex(st.bundle.data) };
    summary = sub === "pause" ? "paused: custodians release nothing for this deployment until you resume" : "resumed";
  } else if (sub === "clear") {
    if (!pol.policyRev) throw new Error("no custody v2 policy");
    if (!f.yes) throw new Error(`clear destroys the stored bundle of ${h.short(id)} (secrets revision ${pol.secretRev} -> ${pol.secretRev + 1n}, nothing stored): re-run with --yes`);
    update = { expectPolicyRev: pol.policyRev, setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true };
    expect = { secretRev: pol.secretRev + 1n, bundle: "0x", paused: pol.paused, committeeId: pol.committeeId, rules: bytesToHex(pol.rules) };
    summary = "cleared: no bundle is stored; custodians have nothing to release";
  } else {
    // set | migrate: the WHOLE set, encrypted here to the committee's key
    let env;
    if (sub === "set") {
      env = h.secretsKv(f._.slice(1), f.file);
      if (!Object.keys(env).length) throw new Error("nothing to set: pass KEY=VALUE arguments and/or --file .env (custody replaces the whole set)");
    } else {
      if (!f.from) throw new Error("migrate needs --from: your own export (a hosted `enclave secrets ls <id> --show --json` saved by you, or `custody seal-export`)");
      env = openExport(fs.readFileSync(f.from, "utf8"), { id, passphrase: f["passphrase-file"] ? passphraseOf(f["passphrase-file"]) : null });
      if (!Object.keys(env).length) throw new Error("the export holds no values: nothing to migrate");
      h.say(`migrating ${Object.keys(env).length} value(s) from ${f.from}: ${Object.keys(env).sort().join(", ")}`);
    }
    checkEnv(env);
    let rules;
    if (f.rules) rules = rulesFromObject(JSON.parse(h.readFile(f.rules)));
    else if (pol.policyRev) {
      if (rulesNow.kind === "unparseable") throw new Error(`the policy's current rules do not parse (${rulesNow.error}): pass --rules`);
      rules = { kind: rulesNow.kind, bytes: pol.rules };                               // verbatim: never re-encoded
    } else throw new Error("no rules yet: pass --rules rules.json (SNP or Enclave Shield rules: the code that may receive these values)");
    const committeeId = String(f.committee || (pol.policyRev ? pol.committeeId : "")).toLowerCase();
    if (!ID.test(committeeId)) throw new Error("no committee: pass --committee 0x… (independent custody has no platform default)");
    const { committee } = await reader.readCommittee({ committeeId });
    if (!committee) throw new Error(`no committee ${committeeId} in ${v.vault}`);
    const enclaveSeats = committee.machines.filter((m) => m.enclave);
    if (enclaveSeats.length && !f["allow-enclave-seat"])
      throw new Error(`committee ${committeeId.slice(0, 10)}… has an Enclave-operated seat (${enclaveSeats.map((m) => m.endpoint).join(", ")}): pass --allow-enclave-seat to accept it, or choose an independent committee`);
    const configText = f["config-file"] ? configTextOf(JSON.parse(h.readFile(f["config-file"])))
      : f["no-config"] ? "" : configTextFromEnvelope(st.lease ? st.lease.envelope : "");
    h.say(`rules: ${rules.kind === "shield" ? describeRules(rules.bytes).tier : "sev-snp (custody rules v1)"}`);
    h.say(`the values may only be substituted into the config with sha256 ${configSha256(configText).slice(0, 16)}… (${configText ? configText.length + " bytes" : "no config"})`);
    h.say(`encrypting to committee ${committeeId.slice(0, 10)}… (epoch ${committee.epoch}, ${committee.t} of ${committee.W} shares${enclaveSeats.length ? ", WITH an Enclave seat" : ", no Enclave seat"}): ${committee.machines.map((m) => m.endpoint).join(", ")}`);
    const secretRev = pol.secretRev + 1n;
    const bundle = buildBundleV2({ chainId: chain.chainId, vault: v.vault, id, secretRev, committeeId, Y: committee.Y, env, configText });
    update = { expectPolicyRev: pol.policyRev, setPolicy: true, committeeId, paused: false, rules: bytesToHex(rules.bytes), setBundle: true, bundle: bytesToHex(bundle), clear: false };
    expect = { secretRev, committeeId, paused: false, rules: bytesToHex(rules.bytes), bundle: bytesToHex(bundle) };
    summary = `custody v2: ${Object.keys(env).length} value(s) at secrets revision ${secretRev}`;
  }
  const tuple = tupleOf(update);
  const receipt = payer
    ? await send(payer, { address: v.vault, abi: UPDATE_V2_ABI, functionName: "updateBySig",
        args: [id, tuple, deadline, await owner.signTypedData(updateTypedDataV2({ chainId: chain.chainId, vault: v.vault, id, update: tuple, deadline }))] })
    : await send(owner, { address: v.vault, abi: UPDATE_V2_ABI, functionName: "update", args: [id, tuple] });
  const after = await readBack(reader, id, pol, expect, receipt);
  h.say(`${summary} (policy revision ${after.policy.policyRev}, read back at agreed block ${after.blockNumber}${payer ? `; gas paid by ${payer.address}` : ""})`);
  if (sub === "migrate") h.say("the relay's copy (if any) is NOT touched here: once a fresh start confirms the app has its values, clear it with the hosted `enclave secrets clear` and ROTATE each credential at its issuer");
  if (sub === "set" || sub === "migrate") h.say(`a running app picks them up on its next start: enclave --independent … restart ${h.short(id)}`);
}
export { UPDATE_V2_COMPONENTS };
