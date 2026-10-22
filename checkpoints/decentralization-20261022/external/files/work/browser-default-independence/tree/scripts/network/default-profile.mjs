#!/usr/bin/env node
// The default independent profile packaged with the site: deterministic generation, read-only verification, the
// activation gate, and the build module (docs/network/default-independence.md).
//
//   generate  --authority FILE --expect-digest sha256:<hex> --expect-pins FILE [--service-index-pin FILE]
//             --rpc URL ... [--quorum N] [--confirmations N] [--max-block-age S] [--storage-plan FILE]
//             [--directory URL ...] [--host-policy-origin URL ...] [--name TEXT] [--provisional] --out-dir DIR
//             Writes DIR/profile.json (the browser profile, canonical: sorted keys, 2 spaces, one newline),
//             DIR/authority.json (the reviewed authority bytes, unchanged) and DIR/manifest.json (digests of every
//             input and output). Same inputs, same bytes. Refuses to overwrite.
//   verify    --dir DIR [--rpc URL ...] [--out FILE]
//             Read-only: the reviewed authority against agreeing RPCs (network/authority-profile.mjs
//             verifyProfileOnChain) and the service index pin (network/service-index.mjs readServiceIndex: the code
//             hash at an agreed block, and what it lists). Writes DIR/verification.json.
//   gate      --dir DIR --evidence FILE [--ledger-migration FILE] [--accept-ledger KEY] [--site-root DIR]
//             The activation gate (G1-G7); writes DIR/gate.json with "publishable". Missing evidence fails its gate.
//   module    --dir DIR [--provisional] --out FILE
//             The ES module scripts/build-site.mjs --default-profile takes. Refuses a gate report that is not
//             publishable unless --provisional (a test build; the page then starts only on a loopback origin).
// Nothing here signs, sends, publishes or activates anything.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseProfile as parseAuthorityProfile, contractPinsFromProfile, rpcClients, verifyProfileOnChain, MAX_PROFILE_BYTES } from "../../network/authority-profile.mjs";
import { validateContractPins } from "../../network/contract-pins.mjs";
import { rpcEndpoint } from "../../network/rpc-identity.mjs";
import { validateProfile as validateBrowserProfile, parseUniqueJSON, checkPackagedDefault, PROFILE_FORMAT, PROFILE_MAX_BYTES, DEFAULT_PROFILE_FORMAT } from "../../site/js/core/independent.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
const plain = (v) => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
export function canonicalText(value){
  const sort = (v) => Array.isArray(v) ? v.map(sort) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}
const readBounded = (file, max, what) => { const b = fs.readFileSync(file); if (b.length > max) throw Error(what + " is too large"); return b; };
const writeNew = (file, text) => fs.writeFileSync(file, text, { flag: "wx", mode: 0o644 });
const ADDR = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/;

/* ---- generate (pure: tests call it) ---- */
export function generate({ authorityBytes, expectDigest, expectPins, serviceIndexPin = null, rpcs, quorum = 3, confirmations = 2, maxBlockAgeSeconds = 600,
  storage = null, directories = [], hostPolicyOrigins = [], name = "", provisional = false }){
  const { digest: authorityDigest, profile: authority } = parseAuthorityProfile(authorityBytes, { expectedDigest: expectDigest });
  const pins = contractPinsFromProfile(authority);
  const expected = validateContractPins(expectPins);
  for (const k of Object.keys(expected)) if (pins.contracts[k].toLowerCase() !== expected[k])
    throw Error("contract pin " + k + " in the authority profile (" + pins.contracts[k] + ") differs from the expected pins (" + expected[k] + ")");
  // RPCs: https only for a published profile; distinct vote identities (one public host = one vote)
  if (!Array.isArray(rpcs) || rpcs.length < 2 || rpcs.length > 8) throw Error("2 to 8 RPCs are required");
  const ids = rpcs.map((u) => rpcEndpoint(u).identity);
  if (new Set(ids).size !== ids.length) throw Error("RPCs must be distinct endpoints: one host is one vote");
  if (!provisional && rpcs.some((u) => !/^https:\/\//.test(u))) throw Error("a published default profile uses HTTPS RPCs only");
  for (const d of [...directories, ...hostPolicyOrigins]) if (!provisional && !/^https:\/\//.test(d)) throw Error("a published default profile uses HTTPS origins only: " + d);
  let serviceIndex = undefined;
  if (serviceIndexPin){
    if (!plain(serviceIndexPin) || serviceIndexPin.chainId !== authority.chainId || !ADDR.test(String(serviceIndexPin.address).toLowerCase()) || !HASH.test(String(serviceIndexPin.codeHash).toLowerCase()))
      throw Error("the service index pin must be {chainId, address, codeHash} on the authority's chain");
    serviceIndex = { address: serviceIndexPin.address.toLowerCase(), codeHash: serviceIndexPin.codeHash.toLowerCase() };
  }
  const feed = authority.contracts.deployments.reviewedState.ethUsdFeed;
  const out = { format: PROFILE_FORMAT, version: 1, name: name || ("Base · reviewed authority " + authorityDigest.slice(7, 19)), chainId: authority.chainId,
    rpcs, quorum, confirmations, maxBlockAgeSeconds,
    contractPins: { version: 1, chainId: pins.chainId, contracts: Object.fromEntries(Object.entries(pins.contracts).map(([k, v]) => [k, v.toLowerCase()])) },
    usdc: authority.contracts.usdc.address.toLowerCase(),
    ...(feed && !/^0x0{40}$/i.test(feed) ? { ethUsdFeed: feed.toLowerCase() } : {}),
    ...(storage ? { storage } : {}), ...(directories.length ? { directories } : {}), ...(hostPolicyOrigins.length ? { hostPolicyOrigins } : {}),
    ...(serviceIndex ? { serviceIndex } : {}),
    source: { authorityProfileDigest: authorityDigest, reviewBlock: String(authority.review.blockNumber) } };
  validateBrowserProfile(out);
  const text = canonicalText(out);
  if (Buffer.byteLength(text) > PROFILE_MAX_BYTES) throw Error("browser profile too large");
  // the browser's own load-time check, run here on the exact bytes it will get
  const authorityText = Buffer.from(authorityBytes).toString("utf8");
  checkPackagedDefault({ format: DEFAULT_PROFILE_FORMAT, provisional, profileText: text, profileDigest: sha(text), authorityText, authorityDigest }, { loopback: true });
  return { text, profileDigest: sha(text), authorityText, authorityDigest, authority, profile: out };
}

/* ---- the gate (pure over its inputs; tests call it) ---- */
const gate = (id, title, pass, detail, evidence = null) => ({ id, title, pass: !!pass, detail, ...(evidence ? { evidence } : {}) });
export function evaluateGate({ profile, authority, authorityDigest, verification, evidence, ledgerMigration = null, acceptLedger = null, siteClosure = null, now = Date.now() }){
  const gates = [];
  // G1 the reviewed authority verified on chain, recently, for exactly this digest
  const v = verification || {};
  const age = v.at ? now - Date.parse(v.at) : Infinity;
  gates.push(gate("G1", "reviewed authority verified on chain", v.authority && v.authority.ok === true && v.authorityDigest === authorityDigest && age < 24 * 3600 * 1000,
    v.authority ? (v.authority.ok ? "verified at block " + v.authority.blockNumber + " (" + Math.round(age / 60000) + " min ago)" : "refused: " + (v.authority.error || "")) : "no verification"));
  // G2 the ledger: live and unretired; a supplied migration result must be complete and pinned
  const dep = authority.contracts.deployments;
  let g2 = dep.reviewedState.retired === false, g2d = "pinned ledger " + dep.address + " schema " + dep.immutable.deploymentsSchema + (dep.reviewedState.retired ? " RETIRED" : "");
  if (ledgerMigration){
    const done = ledgerMigration.result === "complete" || ledgerMigration.status === "complete";
    const newLedger = String(ledgerMigration.addresses && (ledgerMigration.addresses.ledger17 || ledgerMigration.addresses.ledger) || "").toLowerCase();
    g2 = g2 && done && newLedger === dep.address;
    g2d += "; ledger migration result " + (ledgerMigration.kind || "?") + ": " + (ledgerMigration.result || ledgerMigration.status || "?") + (newLedger ? ", new ledger " + newLedger : "")
      + (newLedger && newLedger !== dep.address ? " (NOT the pinned ledger: regenerate from the post-migration reviewed authority profile)" : "");
  } else if (acceptLedger === dep.address + "@" + dep.immutable.deploymentsSchema){
    g2d += "; no migration result supplied; the publisher explicitly accepted this ledger for the default";
  } else { g2 = false; g2d += "; no ledger migration result supplied and this ledger was not explicitly accepted (--accept-ledger " + dep.address + "@" + dep.immutable.deploymentsSchema + ")"; }
  gates.push(gate("G2", "ledger is the activated one", g2, g2d));
  // G3 storage: every adapter in the plan supports smart-account (ERC-1271 v2) uploads and browser readback (gateway CORS)
  const ev = evidence || {};
  const adapters = profile.storage ? profile.storage.replicas.map((r) => new URL(r.upload).origin) : [];
  const stEv = (ev.storage && Array.isArray(ev.storage.adapters)) ? ev.storage.adapters : [];
  const stOk = adapters.length >= 2 && adapters.every((o) => stEv.some((a) => a.origin === o && a.erc1271v2 === true && a.gatewayCors === true && typeof a.evidence === "string"));
  gates.push(gate("G3", "storage adapters accept account uploads and browser readback", stOk,
    adapters.length ? adapters.map((o) => { const a = stEv.find((x) => x.origin === o); return o + ": " + (a ? (a.erc1271v2 ? "erc1271-v2" : "v1 only") + ", " + (a.gatewayCors ? "gateway CORS" : "no gateway CORS") : "no evidence"); }).join("; ")
      : "the profile has no storage plan (uploads would be off)"));
  // G4 directories and host management reachable from a browser
  const https = (ev.directories && Array.isArray(ev.directories.httpsReachable)) ? ev.directories.httpsReachable : [];
  const rollout = ev.management && ev.management.browserHostRollout === true;
  gates.push(gate("G4", "an HTTPS directory and the browser management transport are live", https.length > 0 && rollout,
    "HTTPS directories reachable: " + (https.length ? https.join(", ") : "none") + "; browser management transport on hosts: " + (rollout ? "rolled out" : "not rolled out")));
  // G5 custody for the Secrets path
  const custody = ev.custody && ev.custody.independentCommittee === true;
  gates.push(gate("G5", "an independent custody committee is active", custody, ev.custody ? (ev.custody.detail || JSON.stringify(ev.custody)) : "no custody evidence"));
  // G6 RPC quorum by distinct vote identity
  const ids = new Set(profile.rpcs.map((u) => rpcEndpoint(u).identity));
  gates.push(gate("G6", "at least three distinct RPC endpoints, quorum at least two", ids.size >= 3 && profile.quorum >= 2 && profile.quorum <= ids.size,
    ids.size + " distinct endpoint(s), quorum " + profile.quorum + " (distinct hosts are not proof of distinct operators)"));
  // G7 the site build's sources equal the recorded closure
  gates.push(gate("G7", "site source closure recorded and unchanged", !!(siteClosure && siteClosure.recorded && siteClosure.recorded === siteClosure.current),
    siteClosure ? "recorded " + siteClosure.recorded + ", current " + siteClosure.current : "no site closure"));
  return { publishable: gates.every((g) => g.pass), gates };
}

/* The site sources a build ships, as one digest (site/**, the network modules it imports; never dist/). */
export function siteClosureDigest(siteRoot = ROOT){
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })){ const p = path.join(dir, e.name);
    if (e.isDirectory()){ if (["dist", "node_modules"].includes(e.name)) continue; walk(p); } else files.push(p); } };
  walk(path.join(siteRoot, "site"));
  for (const f of ["network/rpc-identity.mjs", "network/canonical.mjs", "network/network-policy-core.mjs", "network/wg-config.mjs"]) if (fs.existsSync(path.join(siteRoot, f))) files.push(path.join(siteRoot, f));
  files.sort();
  const h = createHash("sha256");
  for (const f of files){ h.update(path.relative(siteRoot, f) + "\0"); h.update(createHash("sha256").update(fs.readFileSync(f)).digest()); }
  return { digest: "sha256:" + h.digest("hex"), files: files.length };
}

export function moduleText({ profileText, profileDigest, authorityText, authorityDigest, gateDigest, provisional }){
  return "// Generated by scripts/network/default-profile.mjs module. Do not edit: the page checks every digest below.\n"
    + "export const DEFAULT_PROFILE = Object.freeze(" + JSON.stringify({ format: DEFAULT_PROFILE_FORMAT, provisional: !!provisional, profileText, profileDigest,
      authorityText, authorityDigest, gateDigest }) + ");\n";
}

async function main(){
  const [cmd, ...argv] = process.argv.slice(2);
  const { values } = parseArgs({ args: argv, strict: true, options: { authority: { type: "string" }, "expect-digest": { type: "string" }, "expect-pins": { type: "string" },
    "service-index-pin": { type: "string" }, rpc: { type: "string", multiple: true }, quorum: { type: "string" }, confirmations: { type: "string" },
    "max-block-age": { type: "string" }, "storage-plan": { type: "string" }, directory: { type: "string", multiple: true }, "host-policy-origin": { type: "string", multiple: true },
    name: { type: "string" }, provisional: { type: "boolean" }, "out-dir": { type: "string" }, dir: { type: "string" }, out: { type: "string" },
    evidence: { type: "string" }, "ledger-migration": { type: "string" }, "accept-ledger": { type: "string" }, "site-root": { type: "string" } } });
  const int = (v, d) => v == null ? d : /^[0-9]+$/.test(v) ? Number(v) : (() => { throw Error("integer expected: " + v); })();
  if (cmd === "generate"){
    for (const k of ["authority", "expect-digest", "expect-pins", "out-dir"]) if (!values[k]) throw Error("--" + k + " is required");
    const authorityBytes = readBounded(values.authority, MAX_PROFILE_BYTES, "authority profile");
    const expectPins = parseUniqueJSON(readBounded(values["expect-pins"], 16384, "expected pins").toString("utf8"));
    const serviceIndexPin = values["service-index-pin"] ? parseUniqueJSON(readBounded(values["service-index-pin"], 4096, "service index pin").toString("utf8")) : null;
    const storage = values["storage-plan"] ? parseUniqueJSON(readBounded(values["storage-plan"], 16384, "storage plan").toString("utf8")) : null;
    const r = generate({ authorityBytes, expectDigest: values["expect-digest"], expectPins, serviceIndexPin, rpcs: values.rpc || [],
      quorum: int(values.quorum, 3), confirmations: int(values.confirmations, 2), maxBlockAgeSeconds: int(values["max-block-age"], 600), storage,
      directories: values.directory || [], hostPolicyOrigins: values["host-policy-origin"] || [], name: values.name || "", provisional: !!values.provisional });
    fs.mkdirSync(values["out-dir"], { recursive: true });
    const d = values["out-dir"];
    writeNew(path.join(d, "profile.json"), r.text);
    writeNew(path.join(d, "authority.json"), r.authorityText);
    const inputs = { authority: sha(authorityBytes), expectPins: sha(readBounded(values["expect-pins"], 16384, "")),
      ...(values["service-index-pin"] ? { serviceIndexPin: sha(readBounded(values["service-index-pin"], 4096, "")) } : {}),
      ...(values["storage-plan"] ? { storagePlan: sha(readBounded(values["storage-plan"], 16384, "")) } : {}) };
    writeNew(path.join(d, "manifest.json"), canonicalText({ kind: "enclave.default-profile.manifest", version: 1, provisional: !!values.provisional,
      profileDigest: r.profileDigest, authorityDigest: r.authorityDigest, inputs }));
    console.log(JSON.stringify({ dir: d, profileDigest: r.profileDigest, authorityDigest: r.authorityDigest }));
    return;
  }
  const dir = values.dir; if (!dir) throw Error("--dir is required");
  const profileText = fs.readFileSync(path.join(dir, "profile.json"), "utf8"), authorityText = fs.readFileSync(path.join(dir, "authority.json"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (sha(profileText) !== manifest.profileDigest || sha(authorityText) !== manifest.authorityDigest) throw Error("the profile directory does not match its manifest");
  const { profile: authority } = parseAuthorityProfile(Buffer.from(authorityText), { expectedDigest: manifest.authorityDigest });
  const profile = validateBrowserProfile(parseUniqueJSON(profileText));
  if (cmd === "verify"){
    const rpcs = values.rpc && values.rpc.length ? values.rpc : [...profile.rpcs];
    const out = { kind: "enclave.default-profile.verification", at: new Date().toISOString(), profileDigest: manifest.profileDigest, authorityDigest: manifest.authorityDigest };
    try { const v = await verifyProfileOnChain({ profile: authority, clients: rpcClients(rpcs), maxBlockAgeMs: 120000 });
      out.authority = { ok: true, blockNumber: String(v.blockNumber), blockHash: v.blockHash }; }
    catch (e){ out.authority = { ok: false, error: String(e.message).slice(0, 2000) }; }
    if (profile.serviceIndex){
      try {
        const { readServiceIndex } = await import("../../network/service-index.mjs");
        const s = await readServiceIndex({ clients: rpcClients(rpcs), pin: { chainId: profile.chainId, ...profile.serviceIndex }, kinds: ["directory", "storage"], maxBlockAgeMs: 120000 });
        out.serviceIndex = { ok: true, blockNumber: String(s.blockNumber), candidates: s.candidates.map((c) => ({ operator: c.operator, kind: c.kindName, endpoints: c.endpoints, expiresAt: c.expiresAt })) };
      } catch (e){ out.serviceIndex = { ok: false, error: String(e.message).slice(0, 1000) }; }
    }
    const file = values.out || path.join(dir, "verification.json");
    fs.writeFileSync(file, canonicalText(out));
    console.log(JSON.stringify({ file, authority: out.authority.ok, serviceIndex: out.serviceIndex ? out.serviceIndex.ok : null }));
    if (!out.authority.ok) process.exitCode = 2;
    return;
  }
  if (cmd === "gate"){
    if (!values.evidence) throw Error("--evidence is required (the capability evidence file; missing capabilities fail their gate)");
    const evidence = JSON.parse(fs.readFileSync(values.evidence, "utf8"));
    const verification = fs.existsSync(path.join(dir, "verification.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "verification.json"), "utf8")) : null;
    const ledgerMigration = values["ledger-migration"] ? JSON.parse(fs.readFileSync(values["ledger-migration"], "utf8")) : null;
    const siteRoot = values["site-root"] || ROOT;
    const current = siteClosureDigest(siteRoot).digest;
    const recordedFile = path.join(dir, "site-closure.txt");
    if (!fs.existsSync(recordedFile)) fs.writeFileSync(recordedFile, current + "\n");
    const recorded = fs.readFileSync(recordedFile, "utf8").trim();
    const report = { kind: "enclave.default-profile.gate", at: new Date().toISOString(), profileDigest: manifest.profileDigest, authorityDigest: manifest.authorityDigest,
      evidenceDigest: sha(fs.readFileSync(values.evidence)), ...(values["ledger-migration"] ? { ledgerMigrationDigest: sha(fs.readFileSync(values["ledger-migration"])) } : {}),
      ...evaluateGate({ profile, authority, authorityDigest: manifest.authorityDigest, verification, evidence, ledgerMigration, acceptLedger: values["accept-ledger"] || null,
        siteClosure: { recorded, current } }) };
    fs.writeFileSync(path.join(dir, "gate.json"), canonicalText(report));
    console.log(JSON.stringify({ publishable: report.publishable, failing: report.gates.filter((g) => !g.pass).map((g) => g.id) }));
    if (!report.publishable) process.exitCode = 3;
    return;
  }
  if (cmd === "module"){
    if (!values.out) throw Error("--out is required");
    const gateFile = path.join(dir, "gate.json");
    const gateText = fs.existsSync(gateFile) ? fs.readFileSync(gateFile, "utf8") : null;
    const g = gateText ? JSON.parse(gateText) : null;
    if (g && (g.profileDigest !== manifest.profileDigest || g.authorityDigest !== manifest.authorityDigest)) throw Error("the gate report is for another profile");
    if (!(g && g.publishable) && !values.provisional) throw Error("the gate report is not publishable" + (g ? ": failing " + g.gates.filter((x) => !x.pass).map((x) => x.id).join(", ") : " (none)") + "; only a --provisional test module can be built");
    if (manifest.provisional && !values.provisional) throw Error("a provisional profile can only become a provisional module");
    fs.writeFileSync(values.out, moduleText({ profileText, profileDigest: manifest.profileDigest, authorityText, authorityDigest: manifest.authorityDigest,
      gateDigest: gateText ? sha(gateText) : null, provisional: !!values.provisional }), { flag: "wx" });
    console.log(JSON.stringify({ out: values.out, provisional: !!values.provisional, gateDigest: gateText ? sha(gateText) : null }));
    return;
  }
  throw Error("usage: default-profile.mjs generate|verify|gate|module ...");
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error("default-profile: " + e.message); process.exitCode = 1; });
