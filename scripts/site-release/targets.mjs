// Release targets (work/site-release-interface.txt §3): an operator's file names them; nothing here knows a host.
//   local-root  a directory a web server serves: <root>/<CID>/ holds verified releases side by side, <root>/current is a
//               link swapped atomically (rename), <root>/releases.jsonl records every swap. Mirrors stage under
//               <root>/.incoming-*, verify there completely and are renamed in; nothing live is ever overwritten.
//   kubo        a kubo node's RPC API: the CAR is imported with its root pinned, and the pin and root block are read
//               back. Auth is the NAME of an environment variable, never a value in the file.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { verifyRelease, deriveRelease, RETAIN_HOURS } from "./release.mjs";
import { readCar, extractCar } from "./car.mjs";
import { validateSshTarget, agentCall } from "./ssh.mjs";
import { withLock, fsyncDir, currentLink } from "./root-state.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const CID = /^b[a-z2-7]{58}$/;
const exact = (v, keys, need = []) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k)) && need.every((k) => k in v);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Strict target file: unknown keys refuse, so no secret or host can ride in unnoticed. */
export function loadTargets(file) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!exact(t, ["version", "targets"], ["version", "targets"]) || t.version !== 1 || !Array.isArray(t.targets) || !t.targets.length || t.targets.length > 16)
    throw new Error("a targets file is {version: 1, targets: [1..16]}");
  const names = new Set();
  for (const x of t.targets) {
    if (names.has(x?.name)) throw new Error(`target ${JSON.stringify(x?.name)}: a duplicate name`);
    validateTarget(x); names.add(x.name);
  }
  return t.targets;
}
/** One target, strictly (also an ssh agent's own agent.json, which is exactly one local-root target). */
export function validateTarget(x) {
  {
    if (!x || typeof x.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(x.name)) throw new Error(`target ${JSON.stringify(x?.name)}: a bad name`);
    if (x.kind === "ssh") return validateSshTarget(x);
    if (!exact(x, ["name", "kind", "root", "activate", "api", "authEnv", "keepHours", "maxCarBytes"], ["name", "kind"]))
      throw new Error(`target ${JSON.stringify(x?.name)}: unknown keys`);
    if (x.kind === "local-root") {
      if (typeof x.root !== "string" || !path.isAbsolute(x.root) || "api" in x || "authEnv" in x) throw new Error(`target ${x.name}: a local-root needs an absolute root`);
      if (x.keepHours !== undefined && !(Number.isInteger(x.keepHours) && x.keepHours >= RETAIN_HOURS)) throw new Error(`target ${x.name}: keepHours is at least ${RETAIN_HOURS}`);
      if (x.maxCarBytes !== undefined && !(Number.isInteger(x.maxCarBytes) && x.maxCarBytes >= 1 << 20 && x.maxCarBytes <= 1 << 30))
        throw new Error(`target ${x.name}: maxCarBytes is 1 MiB..1 GiB`);
      if (x.activate != null) {
        const a = x.activate;
        if (!exact(a, ["reload", "reloadTimeoutMs", "probe"])) throw new Error(`target ${x.name}: activate takes reload, reloadTimeoutMs and probe`);
        if (a.reload != null && !(Array.isArray(a.reload) && a.reload.length && a.reload.every((s) => typeof s === "string") && path.isAbsolute(a.reload[0])))
          throw new Error(`target ${x.name}: reload is an argv whose program is an absolute path (no shell)`);
        if (a.probe != null) {
          const p = a.probe;
          if (!exact(p, ["url", "servername", "caFile", "paths", "headers"], ["url", "paths"]) || !Array.isArray(p.paths) || !p.paths.length
              || !p.paths.every((s) => typeof s === "string" && /^[A-Za-z0-9._\/-]+$/.test(s) && !s.includes("..")))
            throw new Error(`target ${x.name}: probe is {url, paths: [tree paths], servername?, caFile?, headers?}`);
          const u = new URL(p.url);
          if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) || u.username || u.password || u.search || u.hash)
            throw new Error(`target ${x.name}: the probe is https (or http on loopback), without credentials`);
        }
      }
    } else if (x.kind === "kubo") {
      const u = new URL(x.api);
      if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) || u.username || u.password || u.search || u.hash || "root" in x || "activate" in x)
        throw new Error(`target ${x.name}: a kubo API is https (or http on loopback), without credentials in the URL`);
      if (x.authEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(x.authEnv)) throw new Error(`target ${x.name}: authEnv names an environment variable`);
    } else throw new Error(`target ${x.name}: kind is local-root, kubo or ssh`);
  }
  return x;
}

// ---- local roots ---------------------------------------------------------------------------------------------------
function copyTree(from, to, onFile) {
  fs.mkdirSync(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, onFile);
    else if (e.isFile()) {
      fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(b, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      onFile?.(b);
    } else throw new Error(`refusing ${a}: not a regular file`);
  }
  fsyncDir(to);
}

/** Put a verified copy of the release at root/<CID>. -> {name, kind, cid, state: "mirrored"|"present"} */
export async function mirrorLocal(target, releaseDir, { onFile } = {}) {
  const src = verifyRelease(releaseDir), cid = src.cid, srcJson = fs.readFileSync(path.join(releaseDir, "release.json"));
  return withLock(target.root, () => {
    cleanStaging(target.root);
    const dest = path.join(target.root, cid);
    const present = () => {
      verifyRelease(dest);
      if (!fs.readFileSync(path.join(dest, "release.json")).equals(srcJson)) throw new Error(`${dest} holds a different release.json for the same CID: refusing to touch it`);
      return { name: target.name, kind: target.kind, cid, state: "present" };
    };
    if (fs.existsSync(dest)) return present();
    const incoming = path.join(target.root, `.incoming-${cid}-${randomBytes(4).toString("hex")}`);
    try {
      copyTree(releaseDir, incoming, onFile);
      verifyRelease(incoming);
      fs.renameSync(incoming, dest);
      fsyncDir(target.root);
    } catch (e) {
      fs.rmSync(incoming, { recursive: true, force: true });
      if (fs.existsSync(dest)) return present();
      throw e;
    }
    return { name: target.name, kind: target.kind, cid, state: "mirrored" };
  });
}

function cleanStaging(root) {
  for (const n of fs.readdirSync(root)) if (/^\.(incoming|link|headers|state)-/.test(n)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
}
/** A staging directory for an incoming release (the agent streams its CAR there before taking the lock). */
export const incomingDir = (root, cid) => path.join(root, `.incoming-${cid}-${randomBytes(4).toString("hex")}`);
/**
 * The agent's receive: a release arrives as its CAR only, already streamed to `carFile` inside `incoming` (bounded by
 * the host's maxCarBytes, never held twice in memory). The whole dir is re-derived from the verified tree (the
 * derivation is deterministic), and the sender's release.json sha256 must equal the derived one. -> {cid, state}
 */
export async function receiveCar(target, { incoming, carFile }, { cid, releaseSha256 }) {
  if (!CID.test(cid) || !/^[0-9a-f]{64}$/.test(releaseSha256)) throw new Error("receive needs a CID and the release.json sha256");
  return withLock(target.root, () => {
    for (const n of fs.readdirSync(target.root)) if (/^\.(link|headers|state)-/.test(n)) fs.rmSync(path.join(target.root, n), { recursive: true, force: true });
    const dest = path.join(target.root, cid);
    const same = (dir) => sha256(fs.readFileSync(path.join(dir, "release.json"))) === releaseSha256;
    try {
      if (fs.existsSync(dest)) {
        verifyRelease(dest);
        if (!same(dest)) throw new Error(`${dest} holds a different release.json for the same CID: refusing to touch it`);
        return { cid, state: "present" };
      }
      const car = readCar(fs.readFileSync(carFile), { expectRoot: cid });
      fs.rmSync(carFile);
      extractCar(car, path.join(incoming, "site"));
      deriveRelease(incoming);
      if (!same(incoming)) throw new Error("the release derived here differs from the sender's release.json (a different tool version?)");
      fs.renameSync(incoming, dest);
      fsyncDir(target.root);
    } finally { fs.rmSync(incoming, { recursive: true, force: true }); }
    return { cid, state: "mirrored" };
  });
}
/** Remove superseded releases older than keepHours (never current, never previous, never one with no record). */
export async function prune(target, { keepHours = target.keepHours ?? RETAIN_HOURS, now = Date.now() } = {}) {
  if (!(Number.isInteger(keepHours) && keepHours >= RETAIN_HOURS)) throw new Error(`keep at least ${RETAIN_HOURS}h`);
  return withLock(target.root, () => {
    const log = fs.existsSync(path.join(target.root, "releases.jsonl"))
      ? fs.readFileSync(path.join(target.root, "releases.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const superseded = new Map(); let cur = null, previous = null;
    for (const e of log) {
      if (cur && e.cid !== cur) { superseded.set(cur, Date.parse(e.at)); previous = cur; }
      if (e.cid) superseded.delete(e.cid);
      cur = e.cid;
    }
    const keep = new Set([currentLink(target.root), previous].filter(Boolean)), removed = [];
    for (const n of fs.readdirSync(target.root)) {
      if (!CID.test(n) || keep.has(n) || !superseded.has(n)) continue;
      if (now - superseded.get(n) > keepHours * 3600e3) { fs.rmSync(path.join(target.root, n), { recursive: true, force: true }); removed.push(n); }
    }
    return { name: target.name, kept: [...keep], removed };
  });
}

// ---- kubo ----------------------------------------------------------------------------------------------------------
export async function mirrorKubo(target, releaseDir, { fetchImpl = fetch, env = process.env, timeoutMs = 300000 } = {}) {
  const m = verifyRelease(releaseDir), api = target.api.replace(/\/$/, "");
  const auth = target.authEnv ? env[target.authEnv] : null;
  if (target.authEnv && !auth) throw new Error(`target ${target.name}: ${target.authEnv} is not set`);
  const call = async (p, body) => {
    const res = await fetchImpl(`${api}/api/v0/${p}`, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: auth ? { authorization: auth } : {} });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`${p.split("?")[0]}: HTTP ${res.status}`);
    return bytes;
  };
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(path.join(releaseDir, "site.car"))], { type: "application/vnd.ipld.car" }), "site.car");
  const imported = (await call("dag/import?pin-roots=true&stats=false", form)).toString("utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const root = imported.find((x) => x.Root)?.Root;
  if (!root || root.Cid?.["/"] !== m.cid || root.PinErrorMsg) throw new Error(`target ${target.name}: the node did not import and pin ${m.cid}${root?.PinErrorMsg ? ` (${root.PinErrorMsg})` : ""}`);
  const pins = JSON.parse((await call(`pin/ls?arg=${m.cid}&type=recursive`)).toString("utf8"));
  if (pins?.Keys?.[m.cid]?.Type !== "recursive") throw new Error(`target ${target.name}: ${m.cid} is not pinned recursively`);
  const block = await call(`block/get?arg=${m.cid}`);
  if (!block.equals(fs.readFileSync(path.join(releaseDir, "site-root.block")))) throw new Error(`target ${target.name}: the node's root block differs`);
  return { name: target.name, kind: "kubo", cid: m.cid, state: "pinned" };
}

/** The release's CAR to the host's agent, which re-derives and verifies the whole dir there. */
export async function mirrorSsh(t, releaseDir, opts = {}) {
  const m = verifyRelease(releaseDir), releaseSha256 = sha256(fs.readFileSync(path.join(releaseDir, "release.json")));
  const a = await agentCall(t, "receive", [m.cid, releaseSha256], { stdinFile: path.join(releaseDir, "site.car"), ...(opts.env ? { env: opts.env } : {}) });
  if (!a.ok) throw new Error(a.error || "the agent refused the release");
  if (a.cid !== m.cid) throw new Error(`the agent reports ${a.cid}, not ${m.cid}`);
  return { name: t.name, kind: "ssh", cid: m.cid, state: a.state, bytes: a.bytes, agentMaxRssMiB: a.maxRssMiB };
}

/** Mirror one release to every target; the run succeeds only when EVERY target holds the same verified CID. */
export async function mirror(targets, releaseDir, opts = {}) {
  const results = [];
  for (const t of targets) {
    try { results.push(t.kind === "kubo" ? await mirrorKubo(t, releaseDir, opts) : t.kind === "ssh" ? await mirrorSsh(t, releaseDir, opts) : await mirrorLocal(t, releaseDir, opts)); }
    catch (e) { results.push({ name: t.name, kind: t.kind, state: "failed", error: String(e.message).slice(0, 300) }); }
  }
  const cids = new Set(results.filter((r) => r.cid).map((r) => r.cid));
  return { ok: results.every((r) => r.state !== "failed") && cids.size === 1, results };
}
