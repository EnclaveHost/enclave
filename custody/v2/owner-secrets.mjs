// The policy owner's side of custody v2 secrets CRUD, for EVERY client (CLI: cli/custody-independent.mjs; the browser): read
// the current values back through the committee (custody/v2/custodian.mjs ownerRead), plan an edit, and build the vault
// update that writes it under the exact revision the read was made at. Isomorphic (no node: imports). It holds no key:
// the owner's signer and the transport are injected, and the recipient key is EPHEMERAL (generated here, zeroed after use).
//
// readOwnerSecrets    challenge every committee machine (purpose "owner-read"), sign ONE EIP-712 OwnerRead, collect the
//                     sealed partials, check each (DLEQ against the committee's commitments), combine exactly t, open
//                     the bundle. Fewer than t valid partials: it throws (fail closed).
// planSecretsEdit     set (merge) | replace | rm (each key must exist) | clear: the new map, nothing else.
// ownerEditUpdate     the vault Update: setPolicy false (rules and pause untouched), a fresh bundle under the SAME
//                     configSha256 the values were bound to, expectPolicyRev = the read's revision (the vault's
//                     StaleRevision guard: two editors never lose each other's changes); an empty map is the vault's clear.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as v2 from "./protocol.mjs";
import * as hpke from "../hpke.mjs";
import { checkEnv } from "../protocol.mjs";
import { parseRules, ownerReadAllowed } from "../rules.mjs";
import { parseShieldRules, SHIELD_RULES_FORMAT } from "./shield-rules.mjs";

export const OWNER_READ_CHALLENGE_PATH = "/v2/custody/owner-read/challenge";
export const OWNER_READ_PATH = "/v2/custody/owner-read";
const ZERO32 = "0x" + "00".repeat(32);
const HEX32 = /^[0-9a-f]{64}$/;
const lc = (x) => String(x).toLowerCase();
const strip0x = (h) => lc(h).replace(/^0x/, "");
const b64ToBytes = (s) => { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const short = (e) => String(e?.message || e).slice(0, 160);

/** the policy's rules bytes -> { kind, rules, ownerRead } by their own format (SNP or Shield); throws if unparseable */
export function policyRulesOf(bytes) {
  const b = typeof bytes === "string" ? hexToBytes(strip0x(bytes)) : bytes;
  const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  const rules = o && o.format === SHIELD_RULES_FORMAT ? parseShieldRules(b) : parseRules(b);
  return { kind: o && o.format === SHIELD_RULES_FORMAT ? "shield" : "snp", rules, ownerRead: ownerReadAllowed(rules) };
}

/**
 * readOwnerSecrets({ chainId, vault, id, state, owner, post, now, expirySec })
 *   state  the caller's AGREED chain read (custody/v2/chain.mjs readRelease): { policy, committee, bundle }
 *   owner  { address, signTypedData(typedData) -> 0x signature } (an EOA, or a contract owner's ERC-1271 signer)
 *   post   async (url, body) -> parsed JSON; throws on a refusal (the caller bounds it: https, timeout, size)
 * -> { env, names, configSha256, policyRev, secretRev, committeeId, epoch, answered }
 */
export async function readOwnerSecrets({ chainId, vault, id, state, owner, post, now = Date.now, expirySec = 120 }) {
  vault = lc(vault); id = lc(id);
  const pol = state?.policy, com = state?.committee, bundle = state?.bundle?.data;
  if (!pol || pol.policyRev === 0n) throw new Error("no custody policy for this deployment");
  if (!bundle || !bundle.length) throw new Error("no secrets are stored for this deployment (nothing to read)");
  if (!com || lc(com.committeeId) !== lc(pol.committeeId)) throw new Error("the policy's committee could not be read");
  if (pol.paused) throw new Error("the policy is paused: custodians release nothing, owner reads included (resume first)");
  if (!policyRulesOf(pol.rules).ownerRead) throw new Error("this policy's rules do not allow an owner read (ownerRead is not true): set rules with ownerRead to edit or list its values");
  if (typeof owner?.signTypedData !== "function" || !/^0x[0-9a-fA-F]{40}$/.test(String(owner?.address || ""))) throw new Error("an owner read needs the owner's signer");
  if (lc(owner.address) !== lc(pol.owner)) throw new Error(`the policy belongs to ${pol.owner}; this signer is ${owner.address}`);
  // 1. one owner-read challenge from each machine (its committee key must answer)
  const failures = [];
  const got = await Promise.allSettled(com.machines.map(async (m) => {
    const r = await post(`${m.endpoint}${OWNER_READ_CHALLENGE_PATH}`, {});
    if (!r || strip0x(r.encKey) !== strip0x(m.encKey) || !HEX32.test(String(r.nonce || ""))) throw new Error("answered as another key");
    return { m, encKey: hexToBytes(strip0x(m.encKey)), nonce: hexToBytes(r.nonce) };
  }));
  const chs = [];
  got.forEach((g, i) => (g.status === "fulfilled" ? chs.push(g.value) : failures.push(`${com.machines[i].endpoint}: ${short(g.reason)}`)));
  if (!chs.length) throw new Error(`no custodian issued an owner-read challenge (${failures.slice(0, 4).join("; ")})`);
  // 2. the ephemeral recipient key, the expiry, ONE signature
  const kp = hpke.generateKeyPair();
  try {
    const expiry = Math.floor(now() / 1000) + expirySec;
    const fields = { chainId, vault, id, policyRev: pol.policyRev, secretRev: pol.secretRev, committeeId: lc(pol.committeeId), epoch: com.epoch,
                     challenges: chs.map((c) => ({ encKey: c.encKey, nonce: c.nonce })), recipientKey: kp.publicKey, expiry };
    const sig = await owner.signTypedData(v2.ownerReadTypedData(fields));
    const req = { v: 2, purpose: v2.OWNER_READ_PURPOSE, id, committeeId: fields.committeeId, epoch: com.epoch, policyRev: String(pol.policyRev),
                  secretRev: String(pol.secretRev), recipientKey: bytesToHex(kp.publicKey), expiry, sig: lc(sig),
                  challenges: chs.map((c) => ({ encKey: bytesToHex(c.encKey), nonce: bytesToHex(c.nonce) })) };
    const binding = v2.ownerReadBinding(fields);
    const R = v2.parseBundle(bundle).R;
    const commitments = [];
    for (let i = 0; i < com.commitments.length; i += 33) commitments.push(com.commitments.subarray(i, i + 33));
    // 3. the sealed partials; each opened with the ephemeral key and checked against the commitments
    const answers = await Promise.allSettled(chs.map((c) => post(`${c.m.endpoint}${OWNER_READ_PATH}`, req)));
    const verified = new Map();
    answers.forEach((a, i) => {
      if (a.status !== "fulfilled") return failures.push(`${chs[i].m.endpoint}: ${short(a.reason)}`);
      try {
        if (strip0x(a.value?.encKey) !== bytesToHex(chs[i].encKey)) throw new Error("answered as another key");
        const recs = v2.openPartials({ recipientPrivate: kp.privateKey, binding, encKey: chs[i].encKey, count: Number(a.value.count), sealed: b64ToBytes(a.value.sealed) });
        for (const record of recs) { const p = v2.verifyPartial({ record, R, binding, commitments }); if (!verified.has(p.k)) verified.set(p.k, p); }
      } catch (e) { failures.push(`${chs[i].m.endpoint}: ${short(e)}`); }
    });
    if (verified.size < com.t)
      throw new Error(`insufficient custodians: ${verified.size} valid share(s) of the ${com.t} needed (${failures.slice(0, 4).join("; ") || "no refusal reason"})`);
    const S = v2.combine([...verified.values()].slice(0, com.t), com.t);
    const opened = v2.decryptBundle({ S, label: v2.labelOf({ chainId, vault, id, secretRev: pol.secretRev, committeeId: lc(pol.committeeId) }), bundle });
    return { env: opened.env, names: Object.keys(opened.env).sort(), configSha256: opened.configSha256, policyRev: pol.policyRev, secretRev: pol.secretRev,
             committeeId: lc(pol.committeeId), epoch: com.epoch, answered: verified.size };
  } finally { kp.privateKey.fill(0); }
}

/** the new map for an edit; never touches anything else */
export function planSecretsEdit({ op, current = {}, pairs = {}, keys = [] }) {
  let env;
  if (op === "set") env = { ...current, ...pairs };
  else if (op === "replace") env = { ...pairs };
  else if (op === "rm") {
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(current, k));
    if (!keys.length || missing.length) throw new Error(missing.length ? `not stored: ${missing.join(", ")}` : "rm needs at least one KEY");
    env = { ...current }; for (const k of keys) delete env[k];
  } else if (op === "clear") env = {};
  else throw new Error(`unknown edit ${op}`);
  if (Object.keys(env).length) checkEnv(env);
  return env;
}

/**
 * ownerEditUpdate({ chainId, vault, id, read, committee, env, configSha256 }) -> { update, expect }
 *   read       readOwnerSecrets' result (its policyRev / secretRev / committeeId are the guard)
 *   committee  the policy's committee (its key Y), from the same agreed state the read used
 * The update is the vault's Update tuple; write it with update() (the owner pays) or updateBySig (owner-signed typed data).
 */
export function ownerEditUpdate({ chainId, vault, id, read, committee, env, configSha256 }) {
  vault = lc(vault); id = lc(id);
  if (!committee || lc(committee.committeeId) !== lc(read.committeeId)) throw new Error("the committee is not the one the values were read under");
  const secretRev = BigInt(read.secretRev) + 1n;
  if (!Object.keys(env).length)
    return { update: { expectPolicyRev: BigInt(read.policyRev), setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true },
             expect: { secretRev, bundle: "0x" } };
  if (!HEX32.test(String(configSha256 || ""))) throw new Error("the values' config commitment is unknown");
  checkEnv(env);
  const bundle = v2.encryptBundle({ Y: committee.Y, label: v2.labelOf({ chainId, vault, id, secretRev, committeeId: lc(read.committeeId) }), env, configSha256 });
  return { update: { expectPolicyRev: BigInt(read.policyRev), setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: true, bundle: "0x" + bytesToHex(bundle), clear: false },
           expect: { secretRev, bundle: "0x" + bytesToHex(bundle) } };
}

/** an https POST for custodian endpoints (CLI default): bounded time and size, no redirects, JSON in and out */
export function custodianPost({ fetchImpl = globalThis.fetch, timeoutMs = 20000, maxBytes = 1 << 20, allowHttpLoopback = false } = {}) {
  return async (url, body) => {
    const u = new URL(url);
    const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(allowHttpLoopback && loop && u.protocol === "http:")) throw new Error("custodian endpoints are https");
    const r = await fetchImpl(u.href, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
                                         signal: AbortSignal.timeout(timeoutMs) });
    const declared = r.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) {
      await r.body?.cancel().catch(() => {});
      throw new Error("custodian answer too large");
    }
    const chunks = []; let size = 0;
    const reader = r.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("custodian answer too large");
          chunks.push(value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    let j; try { j = JSON.parse(text); } catch { throw new Error(`custodian answered HTTP ${r.status} (not JSON)`); }
    if (!r.ok) throw new Error(`${j.error || r.status}: ${String(j.message || "").slice(0, 200)}`);
    return j;
  };
}
