// The packaged default independent profile, without a browser or a chain:
//   - js/core/sha256.js against node:crypto;
//   - js/core/authority-profile.js against the reference network/authority-profile.mjs (layout, canonical bytes, and the
//     verdict on the reviewed Base profile and on every single-value corruption of it);
//   - js/core/independent.js: the packaged default's load-time checks (digests, pins, provisional), precedence, the explicit
//     hosted choice, and one vote per RPC host;
//   - js/core/default-authority.js: code/binding mismatches refuse, reviewed governance drift is reported, not obeyed;
//   - scripts/network/default-profile.mjs: deterministic generation and the activation gate.
//   node --test test/site-default-authority.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as REF from "../network/authority-profile.mjs";
import { sha256Hex } from "../site/js/core/sha256.js";
import * as AP from "../site/js/core/authority-profile.js";
import * as IND from "../site/js/core/independent.js";
import { generate, evaluateGate, moduleText, canonicalText } from "../scripts/network/default-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_FILE = path.join(ROOT, "contracts/deployments/network-profile-base.json");
const AUTH_BYTES = fs.readFileSync(AUTH_FILE);
const AUTH_DIGEST = "sha256:" + createHash("sha256").update(AUTH_BYTES).digest("hex");
const PINS = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/contract-pins-base.json"), "utf8"));
const INDEX_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/service-index-pin-base.json"), "utf8"));
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.public.blockpi.network/v1/rpc/public"];
const sha = (t) => "sha256:" + createHash("sha256").update(t).digest("hex");
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test("sha256.js equals node:crypto, empty to multi-block", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 17404]){
    const b = randomBytes(n);
    assert.equal(sha256Hex(new Uint8Array(b)), createHash("sha256").update(b).digest("hex"), "length " + n);
  }
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("authority-profile.js: same layout, same canonical bytes, same verdict as network/authority-profile.mjs", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(AP.AUTHORITY_LAYOUT)), JSON.parse(JSON.stringify(REF.PROFILE_LAYOUT)));
  const value = JSON.parse(AUTH_BYTES.toString("utf8"));
  assert.equal(AP.encodeAuthority(value), REF.encodeProfile(value).toString("utf8"));
  assert.equal(AP.parseAuthority(AUTH_BYTES.toString("utf8"), { expectedDigest: AUTH_DIGEST }).digest, REF.parseProfile(AUTH_BYTES, { expectedDigest: AUTH_DIGEST }).digest);
  // every single-value corruption: both refuse, or (a value outside the pinned facts) both accept
  const verdict = (f, v) => { try { f(structuredClone(v)); return "ok"; } catch (e){ return "refused"; } };
  let n = 0;
  for (const [name, c] of Object.entries(value.contracts)){
    for (const field of ["address", "codeHash", "role", "codeProvenance"]){
      const v = structuredClone(value); v.contracts[name][field] = field === "address" ? "0x" + "ab".repeat(20) : field === "codeHash" ? "0xzz" : "wrong";
      assert.equal(verdict(AP.validateAuthority, v), verdict(REF.validateProfile, v), name + "." + field); n++;
    }
    for (const section of ["immutable", "reviewedState"]) for (const getter of Object.keys(c[section])){
      const v = structuredClone(value); const x = v.contracts[name][section][getter];
      v.contracts[name][section][getter] = typeof x === "boolean" ? "yes" : Array.isArray(x) ? [x[0]] : /^0x/.test(x) ? "0x" + "cd".repeat(20) : "12x";
      assert.equal(verdict(AP.validateAuthority, v), verdict(REF.validateProfile, v), name + "." + section + "." + getter); n++;
    }
  }
  for (const k of ["scope", "kind", "version", "chainId"]){ const v = structuredClone(value); v[k] = k === "chainId" ? 1 : k === "version" ? 2 : ""; assert.equal(verdict(AP.validateAuthority, v), "refused"); assert.equal(verdict(REF.validateProfile, v), "refused"); n++; }
  assert.ok(n > 80, "corruptions tried: " + n);
  assert.throws(() => AP.parseAuthority(AUTH_BYTES.toString("utf8").replace(/\n$/, ""), { expectedDigest: AUTH_DIGEST }), /digest mismatch/);
  const pretty = JSON.stringify(value) + "\n";
  assert.throws(() => AP.parseAuthority(pretty, { expectedDigest: sha(pretty) }), /not canonically encoded/);
});

function packaged({ provisional = false, mutate = null, rpcs = RPCS } = {}){
  const g = generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, serviceIndexPin: INDEX_PIN, rpcs, quorum: 3, provisional });
  let mod = { format: IND.DEFAULT_PROFILE_FORMAT, provisional, profileText: g.text, profileDigest: g.profileDigest, authorityText: g.authorityText, authorityDigest: g.authorityDigest, gateDigest: null };
  if (mutate) mod = mutate(mod, g);
  return { mod, g };
}

test("the packaged default: digests, pins and provisional rules are checked before anything binds", () => {
  const { mod, g } = packaged();
  const ok = IND.checkPackagedDefault(mod, { loopback: false });
  assert.equal(ok.profile.contracts.deployments, PINS.contracts.deployments);
  assert.equal(ok.profile.serviceIndex.address, INDEX_PIN.address.toLowerCase());
  // a substituted profile text (another ledger) under the original digest
  const evil = g.text.replace(PINS.contracts.deployments, "0x" + "66".repeat(20));
  assert.throws(() => IND.checkPackagedDefault({ ...mod, profileText: evil }, { loopback: false }), /does not match its digest/);
  // ...or with a recomputed digest: the pins no longer equal the reviewed authority
  assert.throws(() => IND.checkPackagedDefault({ ...mod, profileText: evil, profileDigest: sha(evil) }, { loopback: false }), /pins deployments .* not the reviewed/);
  // a substituted authority
  assert.throws(() => IND.checkPackagedDefault({ ...mod, authorityText: g.authorityText.replace("observed", "observes") }, { loopback: false }), /digest mismatch/);
  // a profile naming another authority digest
  const other = g.text.replace(g.authorityDigest, "sha256:" + "0".repeat(64));
  assert.throws(() => IND.checkPackagedDefault({ ...mod, profileText: other, profileDigest: sha(other) }, { loopback: false }), /does not name the packaged authority/);
  // provisional: only on loopback; loopback RPCs only when provisional
  const prov = packaged({ provisional: true, rpcs: ["http://127.0.0.1:8545", "http://127.0.0.1:8546", "http://127.0.0.1:8547"] }).mod;
  assert.throws(() => IND.checkPackagedDefault(prov, { loopback: false }), /PROVISIONAL test profile/);
  assert.ok(IND.checkPackagedDefault(prov, { loopback: true }).provisional);
  assert.throws(() => IND.checkPackagedDefault({ ...prov, provisional: false }, { loopback: true }), /cannot name loopback RPCs/);
});

test("precedence: an owner-chosen profile over the default; the hosted service only by an explicit, per-tab choice; an invalid default never falls back", () => {
  const { mod } = packaged();
  let ls = mem(), tab = mem();
  const s1 = IND.loadProfileState(ls, null, tab, mod, { loopback: false });
  assert.equal(s1.state, "on"); assert.equal(s1.source, "default"); assert.ok(s1.authority);
  // a hosted choice planted in localStorage is NOT honoured in a tab that did not confirm it
  ls.setItem(IND.HOSTED_OPTIN_KEY, "1");
  const s2 = IND.loadProfileState(ls, null, tab, mod, { loopback: false });
  assert.equal(s2.state, "on"); assert.equal(s2.hosted.chosen, true); assert.equal(s2.hosted.confirmed, false);
  IND.confirmHostedService(tab);
  assert.equal(IND.loadProfileState(ls, null, tab, mod, { loopback: false }).state, "off");
  IND.returnToDefault(ls, tab);
  assert.equal(IND.loadProfileState(ls, null, tab, mod, { loopback: false }).source, "default");
  // an owner-chosen saved profile wins once confirmed
  const own = JSON.stringify({ format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    contractPins: { version: 1, chainId: 8453, contracts: PINS.contracts }, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  IND.saveProfile(own, ls, tab);
  const s3 = IND.loadProfileState(ls, null, tab, mod, { loopback: false });
  assert.equal(s3.source, "saved"); assert.equal(s3.state, "on"); assert.ok(s3.packaged, "the default is still offered");
  // a substituted default: invalid, never "off"
  ls = mem(); tab = mem();
  const bad = { ...mod, profileText: mod.profileText.replace("Base", "Bass") };
  const s4 = IND.loadProfileState(ls, null, tab, bad, { loopback: false });
  assert.equal(s4.state, "invalid"); assert.equal(s4.source, "default"); assert.match(s4.error, /does not match its digest/);
  // no packaged default at all: today's hosted default, unchanged
  assert.equal(IND.loadProfileState(mem(), null, mem(), null).state, "off");
});

test("one public host is one vote; loopback aliases are allowed only as marked test fixtures", () => {
  const base = { format: "enclave-browser-profile", version: 1, chainId: 8453, contractPins: { version: 1, chainId: 8453, contracts: PINS.contracts }, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
  // same origin, two paths: the existing distinct-origin rule refuses first; another port: the one-vote rule
  assert.throws(() => IND.validateProfile({ ...base, rpcs: ["https://rpc.example/a", "https://rpc.example/b"] }), /must be distinct|one host is one vote/);
  assert.throws(() => IND.validateProfile({ ...base, rpcs: ["https://RPC.example.", "https://rpc.example:8443"] }), /one host is one vote/);
  const lo = IND.validateProfile({ ...base, rpcs: ["http://127.0.0.1:8545", "http://localhost:8545"] });
  assert.equal(lo.loopbackAliases, true);
  assert.equal(IND.validateProfile({ ...base, rpcs: ["https://a.example", "https://b.example"] }).loopbackAliases, false);
  assert.throws(() => IND.validateProfile({ ...base, rpcs: RPCS.slice(0, 2), serviceIndex: { address: "0x" + "0".repeat(40), codeHash: "0x" + "1".repeat(64) } }), /index contract/);
  assert.throws(() => IND.validateProfile({ ...base, rpcs: RPCS.slice(0, 2), hostPolicyOrigins: ["http://mirror.example"] }), /HTTPS/);
});

test("authority on chain: code or bindings that differ refuse; reviewed governance drift is reported but does not stop the page", async () => {
  const profile = JSON.parse(AUTH_BYTES.toString("utf8"));
  // a stub agreed reader that serves exactly the reviewed facts (code is synthesized to the reviewed hash below)
  const { keccak256Hex } = await import("../site/js/core/keccak.js");
  // the stub serves marker code per contract; the "reviewed" copy pins exactly those markers' hashes
  const codeFor = new Map();
  const fake = (name) => "0x" + Buffer.from(name.padEnd(4, "_")).toString("hex");
  const reviewed = structuredClone(profile);
  for (const [name, c] of Object.entries(reviewed.contracts)){ const code = fake(name); codeFor.set(c.address, code); c.codeHash = keccak256Hex(code); c.runtimeBytes = (code.length - 2) / 2; }
  const words = (type, v) => type === "bool" ? (v ? "1" : "0").padStart(64, "0") : type === "uint256" ? BigInt(v).toString(16).padStart(64, "0")
    : type === "address,address,address" ? v.map((a) => a.slice(2).padStart(64, "0")).join("") : v.slice(2).padStart(64, "0");
  const { keccak256Utf8 } = await import("../site/js/core/keccak.js");
  const answers = new Map();
  for (const [name, layout] of Object.entries(AP.AUTHORITY_LAYOUT)) for (const section of ["immutable", "reviewedState"]) for (const [getter, type] of Object.entries(layout[section]))
    answers.set(reviewed.contracts[name].address + ":" + keccak256Utf8(getter + "()").slice(0, 10), "0x" + words(type, reviewed.contracts[name][section][getter]));
  const reader = (over = {}) => ({ snapshot: async () => ({ number: 100, hash: "0x" + "a".repeat(64), timestamp: 1, rpcs: ["a", "b", "c"] }),
    code: async (_s, a) => (over.code && over.code[a]) || codeFor.get(a), call: async (_s, a, d) => { const k = a + ":" + d; if (over.calls && k in over.calls) return over.calls[k]; return answers.get(k); } });
  const okObs = await AP.observeAuthority(reviewed, reader());
  assert.deepEqual(AP.authorityProblems(reviewed, okObs), []);
  // a different deployments code: hard refusal
  const dep = reviewed.contracts.deployments.address;
  const badCode = AP.authorityProblems(reviewed, await AP.observeAuthority(reviewed, reader({ code: { [dep]: "0x6000" } })));
  const DA = await import("../site/js/core/default-authority.js");
  assert.ok(DA.classifyProblems(badCode).hard.some((p) => /deployments: code hash mismatch/.test(p)));
  // the ledger owner moved pendingOwner: drift, not a refusal
  const pend = dep + ":" + keccak256Utf8("pendingOwner()").slice(0, 10);
  const drifted = AP.authorityProblems(reviewed, await AP.observeAuthority(reviewed, reader({ calls: { [pend]: "0x" + "ee".repeat(20).padStart(64, "0") } })));
  const c = DA.classifyProblems(drifted);
  assert.equal(c.hard.length, 0); assert.ok(c.drift.some((p) => /deployments.pendingOwner/.test(p)));
  // an immutable binding that differs (a factory pointing elsewhere): hard
  const impl = reviewed.contracts.sessionVaultFactory.address + ":" + keccak256Utf8("implementation()").slice(0, 10);
  const swapped = AP.authorityProblems(reviewed, await AP.observeAuthority(reviewed, reader({ calls: { [impl]: "0x" + "ee".repeat(20).padStart(64, "0") } })));
  assert.ok(DA.classifyProblems(swapped).hard.some((p) => /sessionVaultFactory.implementation: binding mismatch/.test(p)));
  // a reverting getter is a fact, never a pass
  const rv = reviewed.contracts.registry.address + ":" + keccak256Utf8("registrySchema()").slice(0, 10);
  const rdr = reader(); const call0 = rdr.call; rdr.call = async (s, a, d) => { if (a + ":" + d === rv){ const e = new Error("reverted"); e.revert = true; throw e; } return call0(s, a, d); };
  assert.ok(AP.authorityProblems(reviewed, await AP.observeAuthority(reviewed, rdr)).some((p) => /registry.registrySchema: binding mismatch \("!reverted"\)/.test(p)));
});

test("generation is deterministic and refuses what a published default cannot carry", () => {
  const a = generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, serviceIndexPin: INDEX_PIN, rpcs: RPCS, quorum: 3 });
  const b = generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, serviceIndexPin: INDEX_PIN, rpcs: RPCS, quorum: 3 });
  assert.equal(a.text, b.text); assert.equal(a.profileDigest, b.profileDigest);
  assert.equal(a.text, canonicalText(JSON.parse(a.text)), "canonical text");
  assert.throws(() => generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, rpcs: ["http://127.0.0.1:1", "http://127.0.0.1:2"] }), /HTTPS RPCs only/);
  assert.throws(() => generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, rpcs: ["https://a.example/x", "https://a.example/y"] }), /one host is one vote/);
  assert.throws(() => generate({ authorityBytes: AUTH_BYTES, expectDigest: "sha256:" + "1".repeat(64), expectPins: PINS, rpcs: RPCS }), /digest mismatch/);
  const wrongPins = structuredClone(PINS); wrongPins.contracts.deployments = "0x" + "77".repeat(20);
  assert.throws(() => generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: wrongPins, rpcs: RPCS }), /differs from the expected pins/);
  // the module round-trips through the browser's own check
  const src = moduleText({ profileText: a.text, profileDigest: a.profileDigest, authorityText: a.authorityText, authorityDigest: a.authorityDigest, gateDigest: "sha256:" + "2".repeat(64), provisional: false });
  assert.match(src, /^\/\/ Generated by/);
});

test("the activation gate: live rev 16 today is NOT publishable, and says exactly why; complete evidence passes", () => {
  const g = generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, serviceIndexPin: INDEX_PIN, rpcs: RPCS, quorum: 3 });
  const now = Date.parse("2026-10-20T06:00:00Z");
  const verification = { at: "2026-10-20T05:50:00Z", authorityDigest: AUTH_DIGEST, authority: { ok: true, blockNumber: "52843000" } };
  const today = evaluateGate({ profile: g.profile, authority: g.authority, authorityDigest: AUTH_DIGEST, verification, now,
    evidence: { management: { browserHostRollout: false }, directories: { httpsReachable: [] }, custody: { independentCommittee: false, detail: "epoch 1, one Enclave machine" } },
    siteClosure: { recorded: "sha256:x", current: "sha256:x" } });
  assert.equal(today.publishable, false);
  const failing = today.gates.filter((x) => !x.pass).map((x) => x.id);
  assert.deepEqual(failing, ["G2", "G3", "G4", "G5"]);
  assert.match(today.gates.find((x) => x.id === "G4").detail, /not rolled out/);
  // a ledger migration result naming another ledger fails G2 precisely; a stale verification fails G1
  const mig = evaluateGate({ profile: g.profile, authority: g.authority, authorityDigest: AUTH_DIGEST, verification: { ...verification, at: "2026-10-18T00:00:00Z" }, now, evidence: {},
    ledgerMigration: { kind: "enclave.ledger17.result", result: "complete", addresses: { ledger17: "0x72cbbbdcc19bb459dae088535cf4c8538e279ec8" } } });
  assert.match(mig.gates.find((x) => x.id === "G2").detail, /NOT the pinned ledger/);
  assert.equal(mig.gates.find((x) => x.id === "G1").pass, false);
  // complete evidence (as it would read after activation; fixture values, not today's facts)
  const storage = { version: 1, minimumCopies: 2, replicas: [
    { upload: "https://s1.storage-a.net/add-json", audience: "0x" + "a1".repeat(32), gateway: "https://s1.storage-a.net/ipfs" },
    { upload: "https://s2.storage-b.net/add-json", audience: "0x" + "b2".repeat(32), gateway: "https://s2.storage-b.net/ipfs" }] };
  const g2 = generate({ authorityBytes: AUTH_BYTES, expectDigest: AUTH_DIGEST, expectPins: PINS, serviceIndexPin: INDEX_PIN, rpcs: RPCS, quorum: 3, storage });
  const full = evaluateGate({ profile: g2.profile, authority: g2.authority, authorityDigest: AUTH_DIGEST, verification, now, acceptLedger: PINS.contracts.deployments + "@16",
    evidence: { storage: { adapters: storage.replicas.map((r) => ({ origin: new URL(r.upload).origin, erc1271v2: true, gatewayCors: true, evidence: "fixture" })) },
      management: { browserHostRollout: true }, directories: { httpsReachable: ["https://dir.operator-a.net"] }, custody: { independentCommittee: true } },
    siteClosure: { recorded: "sha256:y", current: "sha256:y" } });
  assert.equal(full.publishable, true, JSON.stringify(full.gates.filter((x) => !x.pass)));
  // a changed site source after the gate fails G7
  assert.equal(evaluateGate({ profile: g2.profile, authority: g2.authority, authorityDigest: AUTH_DIGEST, verification, now, acceptLedger: PINS.contracts.deployments + "@16",
    evidence: {}, siteClosure: { recorded: "sha256:y", current: "sha256:z" } }).gates.find((x) => x.id === "G7").pass, false);
});

test("WalletConnect is the owner's choice of project id and relay, never a default in independent mode", async () => {
  const C = await import("../site/js/core/config.js");
  const saved = globalThis.localStorage;
  try {
    globalThis.localStorage = mem();
    assert.equal(C.ownerWalletConnect(), null, "nothing chosen: off");
    globalThis.localStorage.setItem(C.WC_TRANSPORT_KEY, JSON.stringify({ projectId: "ab".repeat(16), relayUrl: "wss://relay.example.org" }));
    assert.deepEqual(C.ownerWalletConnect(), { projectId: "ab".repeat(16), relayUrl: "wss://relay.example.org" });
    for (const bad of [{ projectId: "xyz", relayUrl: "wss://r.example" }, { projectId: "ab".repeat(16), relayUrl: "https://r.example" },
      { projectId: "ab".repeat(16), relayUrl: "wss://u:p@r.example" }, { projectId: "ab".repeat(16), relayUrl: "wss://r.example/#x" }]){
      globalThis.localStorage.setItem(C.WC_TRANSPORT_KEY, JSON.stringify(bad));
      assert.equal(C.ownerWalletConnect(), null, JSON.stringify(bad));
    }
    // config.js evaluated with no profile (hosted default): the hosted project id is unchanged
    assert.equal(C.WALLETCONNECT_PROJECT_ID, "e935970def12ab5d05b6b8ff7abd8d75");
  } finally { globalThis.localStorage = saved; }
});
