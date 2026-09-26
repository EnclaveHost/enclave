// windows/node/hosting.mjs -- the box owner's hosting caps, and the local-only API the tray app (windows/tray) sets
// them through.
//
// Two caps, each a fraction of THIS MACHINE: the most of its CPU, and of its GPU, that the node offers to hosting.
// They are the owner's, set on the box itself, and they only ever NARROW what the node takes on (host.mjs:
// cpuShareFree / gpuShareFree, which the claim gate and /availability read, and the isolated backend's spawn gate).
// Lowering one below what is already in use stops nothing that runs. It stops NEW work until use drops below it.
// Absent, both are 1.0, which is the node exactly as it was before they existed.
//
// THE API IS LOCAL ONLY, three ways over: it listens on 127.0.0.1 alone, on its own port, never on the tunnel (the
// agent's handle() does not know these routes); it refuses a peer that is not loopback even if a later change binds
// it wider; and it wants a bearer token from a file that only SYSTEM, Administrators, this process's own account and
// the configured tray user can read.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// The sliders move in twentieths. A cap that is not on the grid is snapped to it, so what the file holds, what the
// node enforces and what the tray shows are the same number.
const STEPS = 20;
export const CAP_STEP = 1 / STEPS;
export const DEFAULT_CAPS = Object.freeze({ cpuShare: 1, gpuShare: 1 });
const AXES = ["cpuShare", "gpuShare"];

/** snapShare(v) -> v snapped to CAP_STEP, or null when v is not a number in [0, 1]. A string is not a number here. */
export function snapShare(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
  return Math.round(v * STEPS) / STEPS;
}

/**
 * The caps on disk, or the defaults when there is no file.
 *
 * A file that is THERE but cannot be read, parsed or trusted fails CLOSED: 0 on both axes, with the reason. It exists
 * only because the owner moved a slider, so the owner asked for less than everything, and reading their unreadable
 * wish as "offer the whole machine" is the one wrong answer. Nothing running is touched by 0 (it only stops new
 * work), and the next PUT from the tray writes a good file.
 *   -> { caps: { cpuShare, gpuShare }, error: string | null }
 */
export function loadCaps(file) {
  const closed = (why) => ({ caps: { cpuShare: 0, gpuShare: 0 },
    error: `the owner's hosting caps (${file}) ${why}: offering nothing new until they are set again from the tray` });
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return e.code === "ENOENT" ? { caps: { ...DEFAULT_CAPS }, error: null } : closed(`could not be read (${e.code || e.message})`); }
  let o;
  try { o = JSON.parse(text); } catch { return closed("do not parse"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return closed("are not an object");
  const caps = {};
  for (const k of AXES) {
    if (o[k] === undefined) { caps[k] = DEFAULT_CAPS[k]; continue; }
    const s = snapShare(o[k]);
    if (s === null) return closed(`state ${k}=${JSON.stringify(o[k]).slice(0, 32)}, which is not a share from 0 to 1`);
    caps[k] = s;
  }
  return { caps, error: null };
}

/** Write the caps ATOMICALLY: a temporary file beside the target, flushed, then renamed over it. A crash mid-write
 *  leaves the old file or the new one, never half of either (which loadCaps would read as 0). */
export function saveCaps(file, caps) {
  const body = JSON.stringify({ cpuShare: caps.cpuShare, gpuShare: caps.gpuShare, updatedAt: new Date().toISOString() }, null, 1) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o644);
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * capsUpdate(current, body) -> the caps a PUT asks for, each validated and snapped. Throws an Error with status 400
 * naming the field. At least one cap; no other keys (a typo such as "cpu" must not read as "leave it alone").
 */
export function capsUpdate(current, body) {
  const bad = (m) => Object.assign(new Error(m), { status: 400, code: "bad_request" });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("the body must be a JSON object: {\"cpuShare\": 0.5, \"gpuShare\": 0.25}");
  const extra = Object.keys(body).filter((k) => !AXES.includes(k));
  if (extra.length) throw bad(`unknown field ${JSON.stringify(extra[0]).slice(0, 40)}: only cpuShare and gpuShare can be set`);
  if (!AXES.some((k) => k in body)) throw bad("nothing to set: give cpuShare, gpuShare or both");
  const next = { ...current };
  for (const k of AXES) {
    if (!(k in body)) continue;
    const s = snapShare(body[k]);
    if (s === null) throw bad(`${k} must be a number from 0 to 1 (it is snapped to steps of ${CAP_STEP})`);
    next[k] = s;
  }
  return next;
}

// ---- the token ------------------------------------------------------------------------------------------------------

/** Where the node writes the token and the tray reads it, unless both are told otherwise. ProgramData on Windows, so
 *  the tray finds it without knowing where the node is installed. */
export function tokenFileDefault(dir) {
  return process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "Enclave", "hosting-admin.token")
    : path.join(dir, "hosting-admin.token");
}

/** icacls' arguments: inheritance removed, and exactly these grants. SIDs, not names, where a name is localised. */
export function aclArgs(file, { selfSid = "", trayUser = "" } = {}) {
  const args = [file, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"];   // SYSTEM, Administrators
  if (selfSid && selfSid !== "S-1-5-18") args.push(`*${selfSid}:F`);                    // the node's own account, to write it
  if (trayUser) args.push(`${trayUser}:R`);                                                // the owner's interactive account, to read it
  return args;
}
const system32 = (exe) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", exe);
/** The SID of the account this process runs as (whoami /user), so the node can still write the file it locked. */
function windowsSelfSid() {
  const out = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, stdio: "pipe", timeout: 30_000 });
  const m = /"(S-1-[0-9-]+)"/.exec(String(out));
  if (!m) throw new Error(`whoami did not name this account's SID (${String(out).trim().slice(0, 80)})`);
  return m[1];
}
function windowsRestrict(file, trayUser) {
  execFileSync(system32("icacls.exe"), aclArgs(file, { selfSid: windowsSelfSid(), trayUser }), { windowsHide: true, stdio: "pipe", timeout: 30_000 });
}

/**
 * A FRESH token, every start, in a file only SYSTEM, Administrators, this process's account and the tray's user can
 * read. Returns the token; throws when the file cannot be made private, and the caller then serves no admin API.
 *
 * Fresh rather than reused, because the default directory is one an ordinary user can create files in (ProgramData):
 * a token file found there may have been planted. Deleting it and creating a new one with create-new means the file
 * is this process's own. The ACL is set while the file is still EMPTY and the token written after, so there is no
 * moment when a file anybody else can read holds it. The tray re-reads the file on every call, so a new token per
 * node start costs it nothing.
 *
 * `restrict` is the Windows ACL step, replaceable in tests; elsewhere the file is created 0600.
 */
export function mintToken(file, { trayUser = "", platform = process.platform, restrict = windowsRestrict } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  try {
    if (platform === "win32") restrict(file, trayUser);
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(file, token + "\n", { flag: "r+" });
    return token;
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    throw e;
  }
}

// ---- the API ------------------------------------------------------------------------------------------------------

/** Is this socket peer the machine itself? 127/8, ::1 and the v4-mapped 127/8. */
export function isLoopback(addr) {
  const a = String(addr || "");
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/i.test(a);
}

const MAX_BODY = 4096;
// Drained to the end rather than abandoned: leaving a request stream early destroys the socket under the answer.
// null when it was larger than MAX_BODY (nothing past the limit is kept).
const readBody = (req) => new Promise((resolve) => {
  const chunks = []; let n = 0;
  req.on("data", (c) => { n += c.length; if (n <= MAX_BODY) chunks.push(c); });
  req.on("end", () => resolve(n > MAX_BODY ? null : Buffer.concat(chunks)));
  req.on("error", () => resolve(null));
});

/**
 * The request handler, apart from the listener so a test can drive it over any bind. `host` is the Host (host.mjs):
 * hostingView(), hostingCaps(), setHostingCaps(next).
 *
 *   GET /v1/local/hosting   the caps, what is sold, in use and free, deployments served, the backend, and whether
 *                           anything on that backend uses the GPU
 *   PUT /v1/local/hosting   {cpuShare?, gpuShare?}, each 0..1, snapped to 0.05; answers the GET body after the change
 *
 * Order matters: the peer first (a remote caller learns nothing, not even that a token is wanted), then the token
 * (an unauthenticated local caller learns no routes), then the route.
 */
export function hostingAdminHandler({ host, token, log = () => {} }) {
  const want = crypto.createHash("sha256").update(String(token || "")).digest();
  const authorized = (h) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(h || ""));
    if (!token || !m) return false;
    return crypto.timingSafeEqual(crypto.createHash("sha256").update(m[1]).digest(), want);
  };
  return async (req, res) => {
    const json = (status, o, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
      res.end(JSON.stringify(o));
    };
    if (!isLoopback(req.socket?.remoteAddress)) {
      log(`refused a hosting-controls request from ${String(req.socket?.remoteAddress).slice(0, 64)}: loopback only`);
      return json(403, { error: "forbidden", message: "the hosting controls answer this machine only" }, { connection: "close" });
    }
    if (!authorized(req.headers?.authorization))
      return json(401, { error: "unauthorized", message: "a bearer token from the node's hosting-admin.token file is required" },
                  { "www-authenticate": "Bearer" });
    const p = String(req.url || "").split("?")[0];
    if (p !== "/v1/local/hosting") return json(404, { error: "not_found" });
    if (req.method === "GET") return json(200, host.hostingView());
    if (req.method !== "PUT") return json(405, { error: "method_not_allowed" }, { allow: "GET, PUT" });
    const raw = await readBody(req);
    if (raw === null) return json(413, { error: "too_large", message: `a caps update is at most ${MAX_BODY} bytes` }, { connection: "close" });
    let body;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { return json(400, { error: "bad_request", message: "the body is not JSON" }); }
    let next;
    try { next = capsUpdate(host.hostingCaps(), body); }
    catch (e) { return json(e.status || 400, { error: e.code || "bad_request", message: e.message }); }
    try { host.setHostingCaps(next); }
    catch (e) { return json(500, { error: "not_saved", message: `the caps were not saved, so nothing changed: ${e.message}` }); }
    return json(200, host.hostingView());
  };
}

/** Listen on 127.0.0.1:port and nowhere else. Returns the server. */
export function startHostingAdmin({ host, port, token, log = () => {} }) {
  const server = http.createServer(hostingAdminHandler({ host, token, log }));
  server.on("error", (e) => log(`hosting controls on 127.0.0.1:${port} failed: ${e.message}`));
  server.listen(port, "127.0.0.1", () => log(`hosting controls on 127.0.0.1:${port} (loopback only, bearer token)`));
  return server;
}
