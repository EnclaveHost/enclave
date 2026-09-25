// test/helpers/tuf-fake-repo.mjs: a TUF repository minted for a test run: real ECDSA P-256 keys (node:crypto), root,
// timestamp, snapshot and targets metadata signed over canonical JSON (the same canonicalisation the verifier under test
// uses: @freedomofpress/crypto-browser), DER signatures as hex (as Sigstore's repository carries them), consistent
// snapshots (N.role.json, HASH.target), served over HTTP from this process with a mutable state so a test can tamper:
// drop or corrupt a signature, expire a role, roll a version back, take a file away half-way, change the target's bytes.
// Nothing here is a fixture: every run mints new keys.
import http from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalize } from "@freedomofpress/crypto-browser";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const days = (n, from = Date.now()) => new Date(from + n * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function mintKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const key = { keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256", keyval: { public: pem } };
  const keyid = sha256hex(Buffer.from(canonicalize(key), "utf8"));
  return { keyid, key, privateKey };
}
export const signMeta = (signed, signers) => ({ signatures: signers.map((k) => ({ keyid: k.keyid, sig: sign("sha256", Buffer.from(canonicalize(signed), "utf8"), { key: k.privateKey, dsaEncoding: "der" }).toString("hex") })), signed });
const metaOf = (bytes) => ({ length: bytes.length, hashes: { sha256: sha256hex(bytes) } });
export const bytesOf = (obj) => Buffer.from(JSON.stringify(obj, null, 1) + "\n", "utf8");

// A repository with one key per role (thresholds 1), the target file given, versions starting at 1. `roles` may
// carry several root keys and a threshold to exercise rotations.
export function createRepo({ targetName = "trusted_root.json", targetBytes = Buffer.from(JSON.stringify({ certificateAuthorities: [], tlogs: [], ctlogs: [] })), rootKeys = null, rootThreshold = 1, expiresDays = 30 } = {}) {
  const keys = { root: rootKeys ?? [mintKey()], timestamp: [mintKey()], snapshot: [mintKey()], targets: [mintKey()] };
  const state = { rootVersion: 0, roots: new Map(), timestamp: null, snapshots: new Map(), targetsMeta: new Map(), targets: new Map(), keys, rootThreshold, expiresDays, versions: { timestamp: 0, snapshot: 0, targets: 0 }, targetName, targetBytes, missing: new Set(), tamper: {} };
  const rootSigned = (version, k = keys, threshold = rootThreshold, expires = days(expiresDays)) => ({
    _type: "root", spec_version: "1.0", version, expires, consistent_snapshot: true,
    keys: Object.fromEntries([...k.root, ...k.timestamp, ...k.snapshot, ...k.targets].map((x) => [x.keyid, x.key])),
    roles: { root: { keyids: k.root.map((x) => x.keyid), threshold }, timestamp: { keyids: k.timestamp.map((x) => x.keyid), threshold: 1 }, snapshot: { keyids: k.snapshot.map((x) => x.keyid), threshold: 1 }, targets: { keyids: k.targets.map((x) => x.keyid), threshold: 1 } },
  });
  // publish root version N (signed by the previous root's keys AND the new ones, as a rotation must be)
  function publishRoot({ newKeys = null, signers = null, expires = undefined } = {}) {
    const prev = state.keys; if (newKeys) state.keys = { ...state.keys, ...newKeys };
    state.rootVersion += 1;
    const signed = rootSigned(state.rootVersion, state.keys, state.rootThreshold, expires ?? days(state.expiresDays));
    const bySigner = signers ?? [...new Map([...prev.root, ...state.keys.root].map((k) => [k.keyid, k])).values()];
    state.roots.set(state.rootVersion, bytesOf(signMeta(signed, bySigner)));
    return state.rootVersion;
  }
  // publish targets -> snapshot -> timestamp for the current target bytes (versions +1 each)
  function publish({ targetBytes = state.targetBytes, expires = {} , signers = {} } = {}) {
    state.targetBytes = targetBytes;
    const th = sha256hex(targetBytes); state.targets.set(`${th}.${state.targetName}`, targetBytes);
    state.versions.targets += 1;
    const targets = bytesOf(signMeta({ _type: "targets", spec_version: "1.0", version: state.versions.targets, expires: expires.targets ?? days(state.expiresDays), targets: { [state.targetName]: { length: targetBytes.length, hashes: { sha256: th } } } }, signers.targets ?? state.keys.targets));
    state.targetsMeta.set(state.versions.targets, targets);
    state.versions.snapshot += 1;
    const snapshot = bytesOf(signMeta({ _type: "snapshot", spec_version: "1.0", version: state.versions.snapshot, expires: expires.snapshot ?? days(state.expiresDays), meta: { "targets.json": { version: state.versions.targets, ...metaOf(targets) } } }, signers.snapshot ?? state.keys.snapshot));
    state.snapshots.set(state.versions.snapshot, snapshot);
    state.versions.timestamp += 1;
    state.timestamp = bytesOf(signMeta({ _type: "timestamp", spec_version: "1.0", version: state.versions.timestamp, expires: expires.timestamp ?? days(state.expiresDays), meta: { "snapshot.json": { version: state.versions.snapshot, ...metaOf(snapshot) } } }, signers.timestamp ?? state.keys.timestamp));
    return { ...state.versions };
  }
  publishRoot(); publish();
  const files = () => {
    const out = new Map();
    for (const [v, b] of state.roots) out.set(`${v}.root.json`, b);
    if (state.timestamp) out.set("timestamp.json", state.timestamp);
    for (const [v, b] of state.snapshots) out.set(`${v}.snapshot.json`, b);
    for (const [v, b] of state.targetsMeta) out.set(`${v}.targets.json`, b);
    for (const [n, b] of state.targets) out.set(`targets/${n}`, b);
    return out;
  };
  let srv = null, hits = [];
  async function serve() {
    srv = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || "/").replace(/^\//, "").split("?")[0]);
      hits.push(name);
      if (state.missing.has(name)) { res.writeHead(404); res.end("gone"); return; }
      const f = files().get(name);
      if (!f) { res.writeHead(404); res.end("not found"); return; }
      const body = state.tamper[name] ? state.tamper[name](f) : f;
      res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream" }); res.end(body);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}/`;
    return { metadataUrl: base, targetsUrl: `${base}targets/`, close: () => new Promise((r) => srv.close(() => r())) };
  }
  return { state, keys: () => state.keys, publishRoot, publish, serve, files, hits: () => hits, startingRoot: (v = 1) => state.roots.get(v).toString("utf8"),
           // corrupt the signature VALUE (a byte inside r), not the DER framing: the verifier reads r and s out of the DER and
           // verifies those, so a changed outer tag alone still verifies (measured 2026-09-25)
           tamperSignature: (name) => { state.tamper[name] = (b) => { const j = JSON.parse(b.toString("utf8")); const sig = j.signatures[0].sig; const i = 12; j.signatures[0].sig = sig.slice(0, i) + (sig[i] === "a" ? "b" : "a") + sig.slice(i + 1); return bytesOf(j); }; },
           tamperBody: (name, mut) => { state.tamper[name] = (b) => { const j = JSON.parse(b.toString("utf8")); mut(j.signed); return bytesOf(j); }; },
           tamperRaw: (name, fn) => { state.tamper[name] = fn; }, clearTamper: () => { state.tamper = {}; state.missing.clear(); } };
}
