// READ-ONLY public probe (exactly 9 unauthenticated GETs by default; `--follow-trustless` makes the ONE 10th request of the
// assessment: the trustless-gateway.link target that ipfs.io and dweb.link redirected to in public-read-1, each <= 30 s, bodies capped at 64 KiB, no redirects followed, no
// cookies/keys/admin routes). IPNS records are verified OFFLINE with a throwaway local kubo repo (`ipfs name inspect --verify`,
// no daemon, no network). Nothing is published, reset or written anywhere but evidence/public-read-<stamp>.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const NAME = "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52";
const PUB = "https://d9798e4c.app.enclave.host";
const OLD = "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const REC = { accept: "application/vnd.ipfs.ipns-record" };
const READS = [
  ["publisher-status", `${PUB}/api/status`, {}, "json"],
  ["publisher-record", `${PUB}/routing/v1/ipns/${NAME}`, REC, "record"],
  ["value-source", "https://ipfs.enclave.host/site-root", {}, "text"],
  ["delegated-ipfs.dev", `https://delegated-ipfs.dev/routing/v1/ipns/${NAME}`, REC, "record"],
  ["ipfs.io", `https://ipfs.io/ipns/${NAME}?format=ipns-record`, REC, "record"],
  ["dweb.link", `https://dweb.link/ipns/${NAME}?format=ipns-record`, REC, "record"],
  ["ipfs.enclave.host-record", `https://ipfs.enclave.host/ipns/${NAME}?format=ipns-record`, REC, "record"],
  ["ipfs.enclave.host-name-path", `https://ipfs.enclave.host/ipns/${NAME}/`, {}, "head-only"],
  ["old-site-root-block", `https://ipfs.enclave.host/ipfs/${OLD}?format=raw`, { accept: "application/vnd.ipld.raw" }, "block"],
];
if (process.argv.includes("--follow-trustless")) READS.splice(0, READS.length, ["trustless-gateway.link", `https://trustless-gateway.link/ipns/${NAME}?format=ipns-record`, REC, "record"]);
if (READS.length > 10) throw Error("request cap");
const repo = mkdtempSync(join(tmpdir(), "pubread-kubo-")), env = { ...process.env, IPFS_PATH: join(repo, "kubo") };
execFileSync("ipfs", ["init", "--profile=test"], { env, stdio: "ignore" });
const inspect = (b) => { const j = JSON.parse(execFileSync("ipfs", ["name", "inspect", "--enc=json", "--dump=false", "--verify", NAME], { env, input: b }).toString());
  return { valid: j.Validation?.Valid === true, validationReason: j.Validation?.Reason || null, sequence: j.Entry?.Sequence, value: j.Entry?.Value, validity: j.Entry?.Validity,
    ttlSecs: Number(j.Entry?.TTL) / 1e9, signatureType: j.SignatureType, bytes: b.length, sha256: sha(b) }; };
// multihash of a base32 CIDv1 dag-pb/raw sha2-256 CID -> hex digest
const b32 = (s) => { const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const cidDigest = (cid) => { const b = b32(cid.slice(1)); if (b[0] !== 1 || b[2] !== 0x12 || b[3] !== 0x20) throw Error("not a CIDv1 sha2-256"); return b.subarray(4, 36).toString("hex"); };
const out = { at: new Date().toISOString(), readOnly: true, requests: READS.length, name: NAME, reads: {} };
for (const [k, url, headers, kind] of READS) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const chunks = []; let n = 0;
    for await (const c of r.body ?? []) { n += c.length; if (n > 65536) break; chunks.push(c); }
    const b = Buffer.concat(chunks).subarray(0, 65536);
    const e = { url, http: r.status, ms: Date.now() - t0, bytes: b.length, sha256: sha(b), contentType: r.headers.get("content-type"),
      location: r.headers.get("location"), etag: r.headers.get("etag"), lastModified: r.headers.get("last-modified"), age: r.headers.get("age"),
      cacheControl: r.headers.get("cache-control"), xIpnsSequence: r.headers.get("x-ipns-sequence") };
    if (r.status === 200 && kind === "json") e.json = JSON.parse(b.toString());
    else if (r.status === 200 && kind === "record") e.record = inspect(b);
    else if (r.status === 200 && kind === "text") e.firstLine = b.toString().split("\n")[0].trim().slice(0, 200);
    else if (r.status === 200 && kind === "block") e.blockMatchesCid = sha(b) === cidDigest(OLD);
    else if (kind !== "head-only" || r.status !== 200) e.bodyStart = b.toString().slice(0, 160);
    out.reads[k] = e;
  } catch (err) { out.reads[k] = { url, ms: Date.now() - t0, error: String(err.message ?? err).slice(0, 200) }; }
}
rmSync(repo, { recursive: true, force: true });
const recs = Object.entries(out.reads).filter(([, v]) => v.record?.valid);
out.summary = { validRecords: recs.map(([k, v]) => `${k}: seq ${v.record.sequence} ${v.record.value} until ${v.record.validity}`),
  maxSequence: recs.reduce((a, [, v]) => Math.max(a, Number(v.record.sequence)), -1) };
const f = `evidence/public-read-${out.at.replace(/[-:]/g, "").slice(0, 15)}Z.json`;
writeFileSync(f, JSON.stringify(out, null, 1) + "\n", { flag: "wx" });
console.log(f); console.log(JSON.stringify(out.summary, null, 1));
for (const [k, v] of Object.entries(out.reads)) console.log(k, v.http ?? v.error, v.ms + "ms", v.firstLine ?? v.record?.sequence ?? v.blockMatchesCid ?? v.location ?? "");
