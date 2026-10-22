#!/usr/bin/env node
// hold-site.mjs: hold a reviewed, immutable site release in an EXISTING s3-ipfs-adapter deployment, under the release's own
// content-addressed prefix, through the adapter's existing `POST /api/upload?path=` route, and prove the hold.
// Reuses the accepted site-release helpers (verifyRelease, fetchRelease, publicationPlan) from SITE_RELEASE_TOOLS
// (default: the frozen stage's scripts/site-release, byte-identical to work/enclave/scripts/site-release); only reads them.
//
//   plan    --release DIR --out MANIFEST [--prefix sites/<CID>/]                     offline
//           verifyRelease(DIR); the manifest lists every site file (path, bytes, sha256, cid); the line-mapped adapter model
//           (adapter-model.mjs) must give the directory at <prefix> exactly the release CID, or plan refuses.
//   upload  --adapter URL --api-key-env NAME --manifest FILE --release DIR [--execute]  network (root)
//           preflight: /api/status ready, not truncated, no error; /api/files under <prefix> holds only manifest files with the
//           manifest's size and CID (a resume), else refuse. Then each missing file, its sha256 re-checked from DIR, as
//           POST /api/upload?path=<prefix><path> with X-Api-Key from $NAME (the value is never printed or logged). Sequential;
//           the first failure stops. Without --execute: the dry-run count only.
//   verify  --adapter URL --manifest FILE --release DIR --out DIR                       network (root)
//           1 /api/status ready, truncated false, error null; 2 /api/files under <prefix> == the manifest exactly (paths, sizes,
//           CIDs); 3 HEAD+GET /ipfs/bafkqaaa?format=raw 200 (the HTTP-provider probe boxo needs); 4 the root block and a
//           deepest child block by ?format=raw, each hashing to its CID, the root == site-root.block; 5 fetchRelease from the
//           adapter alone (?format=car: one root, every block hashes, nothing missing or extra, every file reassembles, the
//           tree re-imports to the CID), then release.json, site.car, site-root.block and headers.caddy derived from the
//           fetched tree must be byte-identical to DIR's.
//   announce-config --shown FILE --release DIR --deployment ID --gateway URL --out DIR [--all-blocks]   offline
//           publicationPlan (value -> /ipfs/<CID>; ipnsKey/api_key must stay $NAME references) plus ipni.gatewayUrl -> URL
//           (and ipni.announceAllBlocks -> true with --all-blocks); every other key byte-for-byte; writes the config to sign.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { adapterIndex } from "./adapter-model.mjs";

const TOOLS = process.env.SITE_RELEASE_TOOLS || "/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/site-release-stage/src/scripts/site-release";
const { verifyRelease, fetchRelease } = await import(path.join(TOOLS, "release.mjs"));
const { publicationPlan } = await import(path.join(TOOLS, "publish.mjs"));
const { cidParse, cidString } = await import(path.join(TOOLS, "unixfs.mjs"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const PROBE = "bafkqaaa";
const KEY_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function parse(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute" || a === "--all-blocks") f[a.slice(2)] = true;
    else if (a.startsWith("--")) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); f[a.slice(2)] = argv[++i]; }
    else f._.push(a);
  }
  return f;
}
const need = (f, ...k) => { for (const x of k) if (!f[x]) throw new Error(`--${x} is required`); };
const prefixOf = (cid, p) => {
  const prefix = p ?? `sites/${cid}/`;
  if (!/^([A-Za-z0-9._-]+\/)+$/.test(prefix) || prefix.split("/").some((s) => s === "." || s === "..")) throw new Error("--prefix is relative segments ending in /");
  return prefix;
};
const baseUrl = (u) => {
  const x = new URL(u);
  if (x.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(x.hostname)) throw new Error("the adapter URL must be https (loopback excepted)");
  if (x.username || x.password || x.search || x.hash) throw new Error("the adapter URL carries no credentials, query or fragment");
  return x.origin + x.pathname.replace(/\/$/, "");
};

/** plan: the manifest, proven against the adapter model. */
export function plan({ release, out, prefix }) {
  const m = verifyRelease(release);
  const pre = prefixOf(m.cid, prefix), site = path.join(release, "site");
  const bucket = {};
  for (const f of m.files) bucket[pre + f.path] = fs.readFileSync(path.join(site, f.path));
  const idx = adapterIndex(bucket, "");
  const at = idx.dirs.get(pre.replace(/\/$/, ""));
  if (at !== m.cid) throw new Error(`the adapter model gives ${pre} the CID ${at}, not ${m.cid}: refusing`);
  const manifest = { schema: "enclave-site-hold/1", cid: m.cid, prefix: pre, car: m.car, rootBlockSha256: sha256(fs.readFileSync(path.join(release, "site-root.block"))),
    files: m.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, cid: f.cid })),
    totalBytes: m.files.reduce((s, f) => s + f.bytes, 0), largest: Math.max(...m.files.map((f) => f.bytes)), modelDagNodes: idx.nodes.size };
  if (manifest.largest > 32 * 1024 * 1024) throw new Error("a file exceeds the adapter's 32 MiB /api/upload cap");
  if (out) fs.writeFileSync(out, JSON.stringify(manifest, null, 1) + "\n", { flag: "wx" });
  return manifest;
}

async function getJson(fetchImpl, url, timeoutMs = 30000) {
  const r = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (r.status !== 200) throw new Error(`${new URL(url).pathname}: HTTP ${r.status}`);
  return r.json();
}
/** /api/status and the manifest-relevant slice of /api/files. */
async function adapterState(fetchImpl, base, manifest) {
  const status = await getJson(fetchImpl, base + "/api/status");
  const files = await getJson(fetchImpl, base + "/api/files", 120000);
  const under = files.filter((f) => typeof f.path === "string" && f.path.startsWith(manifest.prefix));
  return { status, under };
}
const statusProblems = (s) => [s.state !== "ready" && `state ${s.state}`, s.truncated !== false && "the index is truncated (maxKeys)", s.error != null && `error ${JSON.stringify(s.error).slice(0, 120)}`].filter(Boolean);

/** upload: idempotent, resumable, key by env NAME only. */
export async function upload({ adapter, apiKeyEnv, manifest: mf, release, execute = false, fetchImpl = fetch, env = process.env, log = console.log }) {
  if (!KEY_NAME.test(apiKeyEnv || "")) throw new Error("--api-key-env is the NAME of an environment variable");
  const key = env[apiKeyEnv];
  if (!key) throw new Error(`$${apiKeyEnv} is not set`);
  const base = baseUrl(adapter), manifest = JSON.parse(fs.readFileSync(mf, "utf8")), byPath = new Map(manifest.files.map((f) => [manifest.prefix + f.path, f]));
  const { status, under } = await adapterState(fetchImpl, base, manifest);
  const sp = statusProblems(status).filter((p) => !p.startsWith("state "));     // an upload restarts listing anyway
  if (sp.length) throw new Error(`adapter not ready for a hold: ${sp.join("; ")}`);
  for (const f of under) {
    const want = byPath.get(f.path);
    if (!want || want.bytes !== f.size || want.cid !== f.cid) throw new Error(`the prefix already holds ${f.path} (${f.size} bytes, ${f.cid}) that is not this release's: refusing`);
  }
  const have = new Set(under.map((f) => f.path)), todo = manifest.files.filter((f) => !have.has(manifest.prefix + f.path));
  const bytes = todo.reduce((s, f) => s + f.bytes, 0);
  log(`hold ${manifest.cid} at ${base} prefix ${manifest.prefix}: ${have.size} already held, ${todo.length} to upload (${bytes} bytes)`);
  if (!execute) return { dryRun: true, held: have.size, todo: todo.length, bytes };
  let n = 0;
  for (const f of todo) {
    const body = fs.readFileSync(path.join(release, "site", f.path));
    if (body.length !== f.bytes || sha256(body) !== f.sha256) throw new Error(`${f.path} differs from the manifest`);
    const q = new URLSearchParams({ path: manifest.prefix + f.path }).toString().replace(/%2F/g, "/");
    const r = await fetchImpl(`${base}/api/upload?${q}`, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(300000),
      headers: { "x-api-key": key, "content-type": "application/octet-stream" } });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`upload ${f.path}: HTTP ${r.status} ${text.slice(0, 160)} (${n} uploaded this run; re-run to resume)`);
    n++;
  }
  log(`uploaded ${n} files; the adapter re-lists after each upload: run verify once /api/status says ready`);
  return { dryRun: false, uploaded: n, held: have.size + n };
}

/** verify: index, probe, blocks, complete CAR, byte-identical derived release. */
export async function verify({ adapter, manifest: mf, release, out, fetchImpl = fetch }) {
  const base = baseUrl(adapter), manifest = JSON.parse(fs.readFileSync(mf, "utf8")), fail = [], report = { adapter: base, cid: manifest.cid, prefix: manifest.prefix };
  const { status, under } = await adapterState(fetchImpl, base, manifest);
  report.status = { state: status.state, truncated: status.truncated, error: status.error ?? null, files: status.files, app: status.app };
  fail.push(...statusProblems(status));
  const want = new Map(manifest.files.map((f) => [manifest.prefix + f.path, f])), got = new Map(under.map((f) => [f.path, f]));
  const missing = [...want.keys()].filter((p) => !got.has(p)), extra = [...got.keys()].filter((p) => !want.has(p));
  const wrong = [...want].filter(([p, f]) => got.has(p) && (got.get(p).cid !== f.cid || got.get(p).size !== f.bytes)).map(([p]) => p);
  report.index = { held: got.size, missing: missing.length, extra: extra.length, wrong: wrong.length };
  if (missing.length || extra.length || wrong.length) fail.push(`index under the prefix differs: missing ${missing.slice(0, 3)}, extra ${extra.slice(0, 3)}, wrong ${wrong.slice(0, 3)}`);
  for (const method of ["HEAD", "GET"]) {
    const r = await fetchImpl(`${base}/ipfs/${PROBE}?format=raw`, { method, headers: { accept: "application/vnd.ipld.raw" }, redirect: "error", signal: AbortSignal.timeout(30000) });
    report[`probe${method}`] = r.status; await r.arrayBuffer().catch(() => {});
    if (r.status !== 200) fail.push(`${method} /ipfs/${PROBE}?format=raw answered ${r.status} (HTTP-provider clients will not use this gateway)`);
  }
  const raw = async (cid) => {
    const r = await fetchImpl(`${base}/ipfs/${cid}?format=raw`, { headers: { accept: "application/vnd.ipld.raw" }, redirect: "error", signal: AbortSignal.timeout(60000) });
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.status === 200 && createHash("sha256").update(b).digest().equals(cidParse(cid).subarray(4)), bytes: b };
  };
  const root = await raw(manifest.cid);
  report.rootBlock = root.status;
  if (!root.ok || sha256(root.bytes) !== manifest.rootBlockSha256) fail.push(`root block ${manifest.cid}: HTTP ${root.status}, not the release's site-root.block`);
  const deep = [...manifest.files].sort((a, b) => b.path.split("/").length - a.path.split("/").length || (a.path < b.path ? -1 : 1))[0];
  const child = await raw(deep.cid);
  report.childBlock = { path: deep.path, cid: deep.cid, status: child.status };
  if (!child.ok) fail.push(`child block ${deep.path} (${deep.cid}): HTTP ${child.status} or a hash mismatch`);
  fs.mkdirSync(out, { recursive: true });
  try {
    const got2 = await fetchRelease({ cid: manifest.cid, gateways: [base], out, fetchImpl });
    report.car = { fetchedTo: got2.dir };
    for (const f of ["release.json", "site.car", "site-root.block", "headers.caddy"])
      if (!fs.readFileSync(path.join(got2.dir, f)).equals(fs.readFileSync(path.join(release, f)))) fail.push(`${f} derived from the adapter's CAR differs from the release's`);
  } catch (e) { fail.push(`complete CAR from the adapter: ${String(e.message).slice(0, 200)}`); }
  report.failures = fail;
  report.ok = fail.length === 0;
  return report;
}

/** announce-config: the publisher config that points IPNS at the CID and IPNI retrieval at this adapter. */
export function announceConfig({ shown, release, deployment, gateway, out, allBlocks = false }) {
  const g = new URL(gateway);
  if (g.protocol !== "https:" || g.pathname !== "/" || g.search || g.hash || g.username) throw new Error("--gateway is an https origin (the adapter's public gateway)");
  const s = JSON.parse(fs.readFileSync(shown, "utf8"));
  const base = publicationPlan({ releaseDir: release, shown: s, deployment, out: path.join(out, "value-only") });
  const before = s.config, next = JSON.parse(fs.readFileSync(base.configFile, "utf8"));
  if (!next.ipni || typeof next.ipni !== "object") throw new Error("the publisher config has no ipni block: IPNI announcement is not configured on this deployment");
  next.ipni = { ...next.ipni, gatewayUrl: g.origin, ...(allBlocks ? { announceAllBlocks: true } : {}) };
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v, p + k + ".") : [[p + k, JSON.stringify(v)]]));
  const a = new Map(flat(before)), b = new Map(flat(next));
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
  const allowed = new Set(["value", "ipni.gatewayUrl", "ipni.announceAllBlocks"]);
  if (!changed.every((k) => allowed.has(k))) throw new Error(`refusing: the change would touch ${changed.join(", ")}`);
  const file = path.join(out, `publisher-config-hold-${base.plan.cid}.json`);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return { file, changed, from: { value: before.value ?? null, gatewayUrl: before.ipni?.gatewayUrl ?? null, announceAllBlocks: before.ipni?.announceAllBlocks ?? null },
    to: { value: next.value, gatewayUrl: next.ipni.gatewayUrl, announceAllBlocks: next.ipni.announceAllBlocks ?? null },
    sign: ["enclave", "config", "set", base.plan.deployment, "--file", file], identity: base.plan.identity };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2), f = parse(rest);
  try {
    let r;
    if (cmd === "plan") { need(f, "release", "out"); const m = plan({ release: f.release, out: f.out, prefix: f.prefix }); r = { cid: m.cid, prefix: m.prefix, files: m.files.length, totalBytes: m.totalBytes, largest: m.largest }; }
    else if (cmd === "upload") { need(f, "adapter", "api-key-env", "manifest", "release"); r = await upload({ adapter: f.adapter, apiKeyEnv: f["api-key-env"], manifest: f.manifest, release: f.release, execute: !!f.execute }); }
    else if (cmd === "verify") { need(f, "adapter", "manifest", "release", "out"); r = await verify({ adapter: f.adapter, manifest: f.manifest, release: f.release, out: f.out }); }
    else if (cmd === "announce-config") { need(f, "shown", "release", "deployment", "gateway", "out"); r = announceConfig({ shown: f.shown, release: f.release, deployment: f.deployment, gateway: f.gateway, out: f.out, allBlocks: !!f["all-blocks"] }); }
    else { console.error("usage: hold-site.mjs plan|upload|verify|announce-config ... (see the header)"); process.exit(2); }
    console.log(JSON.stringify(r, null, 1));
    if (r && r.ok === false) { console.error("HOLD-VERIFY-FAILED"); process.exit(1); }
    if (cmd === "verify") console.log("HOLD-VERIFY-OK");
  } catch (e) { console.error(`hold-site ${cmd}: ${e.message}`); process.exit(1); }
}
