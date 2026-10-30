// A site release: one immutable, content-addressed tree (work/site-release-interface.txt §2), staged, verified and
// renamed into place atomically, plus files DERIVED from that tree alone (release.json, headers.caddy, installers/,
// site.car, site-root.block, site-root.txt), so every mirror rebuilt from the CID holds byte-identical bytes.
//
// Retention for cached tabs: hashed chunks (js/chunks/**) and inline-script CSP hashes stay for RETAIN_HOURS after
// the last build that produced them. That state travels INSIDE the tree (/.well-known/enclave-site-release.json), so
// a release fetched by CID from any gateway still knows what it must keep.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { importDirectory } from "./unixfs.mjs";
import { writeCar, readCar, extractCar } from "./car.mjs";

export const RETAIN_HOURS = 48;
export const LEDGER_PATH = ".well-known/enclave-site-release.json";
const RETAINED = (p) => p.startsWith("js/chunks/");
const INSTALLERS = ["install.sh", "install.ps1", "host.ps1"];
const DEFAULT_HEADERS = new URL("./headers.json", import.meta.url);
const OUT_OF_TREE = ["headers.caddy", "installers", "release.json", "site", "site-root.block", "site-root.txt", "site.car"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const listFiles = (dir) => {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name, a = path.join(abs, e.name);
      if (e.isSymbolicLink()) throw new Error(`refusing a symlink: ${r}`);
      if (e.isDirectory()) walk(a, r); else if (e.isFile()) out.push(r); else throw new Error(`refusing a special file: ${r}`);
    }
  };
  walk(dir, "");
  return out.sort();
};
const copyFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); };

/** The script-src line of a build's csp-script-src.txt -> {base: "'self' …", hashes: ["'sha256-…'"]}. */
export function parseScriptSrc(text) {
  const line = String(text).split("\n").find((l) => l.startsWith("script-src "));
  if (!line) throw new Error("csp-script-src.txt carries no script-src line");
  const tokens = line.slice("script-src ".length).replace(/;\s*$/, "").trim().split(/\s+/);
  const hashes = tokens.filter((t) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(t));
  const base = tokens.filter((t) => !t.startsWith("'sha256-"));
  if (hashes.length + base.length !== tokens.length) throw new Error("csp-script-src.txt carries a malformed hash");
  return { base: base.join(" "), hashes };
}

/** Header policy -> validated {name: value}; CSP must carry the SCRIPT_SRC slot the union fills. */
export function loadHeaders(file = DEFAULT_HEADERS) {
  const h = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("the header policy is a JSON object of name: value");
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k) || typeof v !== "string" || !v || v.length > 4096 || /["\\\r\n{}]/.test(v))
      throw new Error(`header ${JSON.stringify(k)}: names are tokens and values plain text (no quotes, backslashes, braces or newlines)`);
  }
  if (!/script-src SCRIPT_SRC(;|$)/.test(h["Content-Security-Policy"] || "")) throw new Error("the Content-Security-Policy needs the `script-src SCRIPT_SRC` slot");
  return h;
}
export function effectiveHeaders(ledger) {
  const scriptSrc = [ledger.csp.scriptSrcBase, ...ledger.csp.hashes.map((x) => x.hash)].join(" ");
  return Object.fromEntries(Object.entries(ledger.headers).map(([k, v]) => [k, k === "Content-Security-Policy" ? v.replace("SCRIPT_SRC", scriptSrc) : v]));
}
/** The Caddy snippet a target imports inside the site vhost: only `header` lines, every value from the ledger. */
export function headersCaddy(cid, ledger) {
  const lines = Object.entries(effectiveHeaders(ledger)).map(([k, v]) => `    ${k} "${v}"`);
  return `# site release ${cid}: generated from its ledger (${LEDGER_PATH}); import it inside the site vhost\nheader {\n${lines.join("\n")}\n}\n`;
}

/** A base release: a release dir (release.json), a production-format dir (manifest.json + site/), or a bare tree. */
export function openBase(dir, { builtAt = null, now }) {
  const site = fs.existsSync(path.join(dir, "site")) ? path.join(dir, "site") : dir;
  const ledgerFile = path.join(site, LEDGER_PATH);
  const ledger = fs.existsSync(ledgerFile) ? validateLedger(JSON.parse(fs.readFileSync(ledgerFile, "utf8"))) : null;
  let cid = null;
  for (const f of ["release.json", "manifest.json"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) { cid = JSON.parse(fs.readFileSync(p, "utf8")).cid || null; break; }
  }
  // a base fetched by CID (`fetch --as-base`) is named by its CID: believed only once the tree hashes to it
  if (!cid && /^b[a-z2-7]{58}$/.test(path.basename(path.resolve(dir))) && importDirectory(site).cid === path.basename(path.resolve(dir))) cid = path.basename(path.resolve(dir));
  // no ledger: every inherited file and hash is dated to the base's build time, or (conservatively) to now
  const at = ledger ? null : builtAt ? Date.parse(builtAt) : now;
  if (at !== null && !Number.isFinite(at)) throw new Error("--base-built-at must be an ISO time");
  const csp = fs.existsSync(path.join(site, "csp-script-src.txt")) ? parseScriptSrc(fs.readFileSync(path.join(site, "csp-script-src.txt"), "utf8")) : { hashes: [] };
  return {
    cid, site, ledger,
    lastBuiltAt: (p) => { const e = ledger?.retained.find((x) => x.path === p); return e ? Date.parse(e.lastBuiltAt) : at; },
    hashes: ledger ? ledger.csp.hashes.map((x) => ({ hash: x.hash, at: Date.parse(x.lastBuiltAt) })) : csp.hashes.map((hash) => ({ hash, at })),
  };
}

export function validateLedger(l) {
  const ok = l && l.schema === "enclave-site-release-ledger/1" && typeof l.builtAt === "string" && Number.isFinite(Date.parse(l.builtAt))
    && Number.isInteger(l.retainHours) && l.retainHours >= RETAIN_HOURS && Array.isArray(l.retained) && l.csp && typeof l.csp.scriptSrcBase === "string"
    && Array.isArray(l.csp.hashes) && l.headers && typeof l.headers === "object" && Array.isArray(l.installers)
    && l.retained.every((x) => typeof x.path === "string" && RETAINED(x.path) && Number.isFinite(Date.parse(x.lastBuiltAt)))
    && l.csp.hashes.every((x) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(x.hash) && Number.isFinite(Date.parse(x.lastBuiltAt)));
  if (!ok) throw new Error(`malformed release ledger (${LEDGER_PATH})`);
  return l;
}

/**
 * Prepare a release under `out`. -> {cid, dir, manifest}. The staging directory is renamed into out/<CID> only after
 * the CAR round-trips and every derived file checks; an existing out/<CID> is verified and reused, never overwritten.
 */
export function prepareRelease({ dist, installers, out, base = null, baseBuiltAt = null, noBase = false, headers = DEFAULT_HEADERS, now = Date.now(),
  source = {}, retainHours = RETAIN_HOURS }) {
  if (!base && !noBase) throw new Error("a release needs its base (the release it replaces) to keep the hashed chunks and CSP hashes of cached tabs; pass --base, or --no-base-i-accept-dropping-old-chunks for a first release");
  if (!Number.isInteger(retainHours) || retainHours < RETAIN_HOURS) throw new Error(`retention is at least ${RETAIN_HOURS}h`);
  const policy = loadHeaders(headers);
  fs.mkdirSync(out, { recursive: true });
  const staging = path.join(out, `.staging-${randomBytes(6).toString("hex")}`), site = path.join(staging, "site");
  fs.mkdirSync(site, { recursive: true });
  try {
    const cutoff = now - retainHours * 3600e3;
    const built = listFiles(dist);
    if (built.includes(LEDGER_PATH)) throw new Error(`the build must not carry ${LEDGER_PATH} (the release writes it)`);
    for (const p of built) copyFile(path.join(dist, p), path.join(site, p));
    // installers ride IN the tree (content-addressed with the site); installers/ beside it is derived from them
    const shipped = [];
    for (const n of INSTALLERS) {
      const f = path.join(installers, n);
      if (!fs.existsSync(f)) throw new Error(`installer ${n} is missing from ${installers}`);
      if (built.includes("get/" + n)) throw new Error(`the build already carries get/${n}`);
      copyFile(f, path.join(site, "get", n)); shipped.push("get/" + n);
    }
    // the union: base chunks the new build no longer produces, while they are inside the retention window
    const b = base ? openBase(base, { builtAt: baseBuiltAt, now }) : null;
    const retained = new Map(built.filter(RETAINED).map((p) => [p, now]));
    const inherited = [], expired = [];
    if (b) for (const p of listFiles(b.site).filter(RETAINED)) {
      const from = path.join(b.site, p), have = path.join(site, p);
      if (fs.existsSync(have)) {
        if (sha256(fs.readFileSync(have)) !== sha256(fs.readFileSync(from))) throw new Error(`hashed file ${p} differs from the base's copy: refusing (hashed names are content-addressed)`);
        continue;
      }
      const at = b.lastBuiltAt(p);
      if (at === null || !(at >= cutoff)) { expired.push(p); continue; }
      copyFile(from, have); retained.set(p, at); inherited.push(p);
    }
    const own = parseScriptSrc(fs.readFileSync(path.join(dist, "csp-script-src.txt"), "utf8"));
    const hashes = new Map(own.hashes.map((h) => [h, now]));
    const expiredHashes = [];
    if (b) for (const { hash, at } of b.hashes) {
      if (hashes.has(hash)) continue;
      if (at === null || !(at >= cutoff)) { expiredHashes.push(hash); continue; }
      hashes.set(hash, at);
    }
    const ledger = validateLedger({
      schema: "enclave-site-release-ledger/1", builtAt: iso(now), source: { commit: source.commit ?? null, dirty: source.dirty ?? null },
      previous: b?.cid ?? null, retainHours,
      retained: [...retained].sort(([a], [c]) => (a < c ? -1 : 1)).map(([p, at]) => ({ path: p, lastBuiltAt: iso(at) })),
      csp: { scriptSrcBase: own.base, hashes: [...hashes].sort(([a], [c]) => (a < c ? -1 : 1)).map(([hash, at]) => ({ hash, lastBuiltAt: iso(at) })) },
      headers: policy, installers: shipped,
    });
    fs.mkdirSync(path.join(site, ".well-known"), { recursive: true });
    fs.writeFileSync(path.join(site, LEDGER_PATH), JSON.stringify(ledger, null, 2) + "\n", { flag: "wx" });
    const manifest = deriveRelease(staging);
    const dropped = { chunks: expired, cspHashes: expiredHashes, inherited: inherited.length };
    const dest = path.join(out, manifest.cid);
    if (fs.existsSync(dest)) {
      verifyRelease(dest);
      fs.rmSync(staging, { recursive: true, force: true });
      return { cid: manifest.cid, dir: dest, manifest: JSON.parse(fs.readFileSync(path.join(dest, "release.json"), "utf8")), reused: true, dropped };
    }
    fs.renameSync(staging, dest);
    return { cid: manifest.cid, dir: dest, manifest, reused: false, dropped };
  } catch (e) { fs.rmSync(staging, { recursive: true, force: true }); throw e; }
}

/** Write every out-of-tree file of a release dir from its site/ tree ALONE (so any mirror derives the same bytes),
 *  then verify the whole dir. -> release.json */
export function deriveRelease(dir) {
  const site = path.join(dir, "site");
  const imp = importDirectory(site);
  const ledger = validateLedger(JSON.parse(fs.readFileSync(path.join(site, LEDGER_PATH), "utf8")));
  const car = writeCar(path.join(dir, "site.car"), imp.cid, imp.blocks);
  fs.writeFileSync(path.join(dir, "site-root.block"), imp.root, { flag: "wx" });
  fs.writeFileSync(path.join(dir, "site-root.txt"), imp.cid + "\n", { flag: "wx" });
  fs.writeFileSync(path.join(dir, "headers.caddy"), headersCaddy(imp.cid, ledger), { flag: "wx" });
  fs.mkdirSync(path.join(dir, "installers"));
  const installers = ledger.installers.map((p) => {
    const bytes = fs.readFileSync(path.join(site, p));
    fs.writeFileSync(path.join(dir, "installers", path.basename(p)), bytes, { flag: "wx", mode: 0o644 });
    return { name: path.basename(p), path: p, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const cutoffOf = (at) => iso(Date.parse(at) + ledger.retainHours * 3600e3);
  const manifest = {
    schema: "enclave-site-release/1", cid: imp.cid, createdAt: ledger.builtAt, source: ledger.source, base: ledger.previous,
    car: car, rootBlock: { sha256: sha256(imp.root), bytes: imp.root.length },
    counts: { files: imp.files.length, retainedChunks: ledger.retained.filter((x) => x.lastBuiltAt !== ledger.builtAt).length,
      cspHashes: ledger.csp.hashes.length },
    retention: { hours: ledger.retainHours, kept: ledger.retained.filter((x) => x.lastBuiltAt !== ledger.builtAt).map((x) => ({ path: x.path, until: cutoffOf(x.lastBuiltAt) })) },
    headers: effectiveHeaders(ledger), installers, files: imp.files,
  };
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  verifyRelease(dir);
  return manifest;
}

/**
 * Re-verify a release dir from scratch: the tree hashes to its CID and to release.json, the CAR verifies on its own and
 * carries exactly the tree, and every derived file equals what the tree derives. -> release.json, or throws.
 */
export function verifyRelease(dir) {
  const names = fs.readdirSync(dir).sort();
  if (JSON.stringify(names) !== JSON.stringify(OUT_OF_TREE)) throw new Error(`a release dir holds exactly ${OUT_OF_TREE.join(", ")} (found ${names.join(", ")})`);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
  if (m.schema !== "enclave-site-release/1") throw new Error("not a site release (release.json schema)");
  const imp = importDirectory(path.join(dir, "site"));
  if (imp.cid !== m.cid) throw new Error(`the tree hashes to ${imp.cid}, not the release's ${m.cid}`);
  if (path.basename(dir) !== m.cid && !path.basename(dir).startsWith(".")) throw new Error(`a release dir is named by its CID (${m.cid})`);
  if (JSON.stringify(imp.files) !== JSON.stringify(m.files)) throw new Error("the tree's files differ from release.json");
  const carBytes = fs.readFileSync(path.join(dir, "site.car"));
  if (sha256(carBytes) !== m.car.sha256 || carBytes.length !== m.car.bytes) throw new Error("site.car differs from release.json");
  const car = readCar(carBytes, { expectRoot: m.cid });
  if (JSON.stringify(car.files) !== JSON.stringify(imp.files)) throw new Error("the CAR's files differ from the tree");
  if (car.blocks.size !== imp.blocks.size) throw new Error("the CAR's blocks differ from the tree's DAG");
  if (!fs.readFileSync(path.join(dir, "site-root.block")).equals(imp.root)) throw new Error("site-root.block is not the root block");
  if (fs.readFileSync(path.join(dir, "site-root.txt"), "utf8") !== m.cid + "\n") throw new Error("site-root.txt does not name the CID");
  const ledger = validateLedger(JSON.parse(fs.readFileSync(path.join(dir, "site", LEDGER_PATH), "utf8")));
  if (fs.readFileSync(path.join(dir, "headers.caddy"), "utf8") !== headersCaddy(m.cid, ledger)) throw new Error("headers.caddy differs from the ledger");
  if (JSON.stringify(m.headers) !== JSON.stringify(effectiveHeaders(ledger))) throw new Error("release.json headers differ from the ledger");
  const inst = fs.readdirSync(path.join(dir, "installers")).sort();
  if (JSON.stringify(inst) !== JSON.stringify(ledger.installers.map((p) => path.basename(p)).sort())) throw new Error("installers/ differs from the ledger");
  for (const p of ledger.installers)
    if (!fs.readFileSync(path.join(dir, "installers", path.basename(p))).equals(fs.readFileSync(path.join(dir, "site", p)))) throw new Error(`installers/${path.basename(p)} differs from the tree`);
  // every retained chunk the ledger promises is in the tree, and the build's CSP hashes are in the union
  const have = new Set(imp.files.map((f) => f.path));
  for (const r of ledger.retained) if (!have.has(r.path)) throw new Error(`the ledger retains ${r.path}, which the tree lacks`);
  const own = parseScriptSrc(fs.readFileSync(path.join(dir, "site", "csp-script-src.txt"), "utf8"));
  const union = new Set(ledger.csp.hashes.map((x) => x.hash));
  for (const h of own.hashes) if (!union.has(h)) throw new Error(`the CSP union lacks the build's own hash ${h}`);
  return m;
}

/** Human review of a release (writes nothing). */
export function reviewRelease(dir) {
  const m = verifyRelease(dir), ledger = JSON.parse(fs.readFileSync(path.join(dir, "site", LEDGER_PATH), "utf8"));
  const lines = [
    `site release ${m.cid}`,
    `  built ${m.createdAt} from commit ${m.source.commit ?? "unknown"}${m.source.dirty ? " (uncommitted changes)" : ""}; base ${m.base ?? "none"}`,
    `  ${m.counts.files} files; CAR ${m.car.bytes} bytes sha256 ${m.car.sha256}; root block sha256 ${m.rootBlock.sha256}`,
    `  retained for cached tabs: ${m.retention.kept.length} older hashed chunks (${m.retention.hours}h after their last build)`,
    `  CSP script-src: ${ledger.csp.hashes.length} inline-script hashes (union over ${ledger.retainHours}h)`,
    ...Object.entries(m.headers).map(([k, v]) => `  header ${k}: ${v.length > 110 ? v.slice(0, 107) + "…" : v}`),
    ...m.installers.map((i) => `  installer ${i.name}: ${i.bytes} bytes sha256 ${i.sha256}`),
    `  approve it with: --approve ${m.cid}`,
  ];
  return { manifest: m, text: lines.join("\n") };
}

/**
 * Fetch a release (or a base) by CID from UNTRUSTED gateways: the CAR must verify to the CID. -> {dir}. With
 * asBase:true any UnixFS tree is accepted (out/site only); otherwise the tree must carry a ledger and the whole
 * release dir is re-derived from it, byte-identical to the one prepared.
 */
export async function fetchRelease({ cid, gateways, out, asBase = false, fetchImpl = fetch, maxBytes = 1 << 30, timeoutMs = 300000 }) {
  if (!Array.isArray(gateways) || !gateways.length) throw new Error("name at least one gateway (--gateway URL); there is no default");
  const errors = [];
  for (const g of gateways) {
    const u = new URL(g);
    if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) { errors.push(`${u.origin}: https required`); continue; }
    try {
      const res = await fetchImpl(`${g.replace(/\/$/, "")}/ipfs/${cid}?format=car`, { headers: { accept: "application/vnd.ipld.car" }, redirect: "error",
        signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const chunks = []; let n = 0;
      for await (const c of res.body) { n += c.length; if (n > maxBytes) throw new Error("CAR too large"); chunks.push(c); }
      const car = readCar(Buffer.concat(chunks), { expectRoot: cid });
      const dest = path.join(out, cid), staging = path.join(out, `.fetch-${randomBytes(6).toString("hex")}`);
      fs.mkdirSync(out, { recursive: true });
      try {
        fs.mkdirSync(staging);
        extractCar(car, path.join(staging, "site"));
        if (!asBase) deriveRelease(staging);
        if (fs.existsSync(dest)) { if (!asBase) verifyRelease(dest); fs.rmSync(staging, { recursive: true, force: true }); }
        else fs.renameSync(staging, dest);
      } catch (e) { fs.rmSync(staging, { recursive: true, force: true }); throw e; }
      return { dir: dest, gateway: u.origin };
    } catch (e) { errors.push(`${u.origin}: ${String(e.message).slice(0, 160)}`); }
  }
  throw new Error(`no gateway returned a CAR verifying to ${cid}: ${errors.join("; ")}`);
}
