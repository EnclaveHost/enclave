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
// the configured tray user can read, in a directory whose DACL makes the file private from the moment it exists.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

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
//
// ON WINDOWS THE TOKEN FILE MUST BE BORN PRIVATE. Access is checked when a handle is OPENED, and a later DACL change
// does not revoke a handle already open: a file created under an inherited Users:(RX) and locked a moment afterwards
// can be held open through the lock by a local user, who then reads the token once it is written (enclave-bf's review
// of 1fdcedddd). So the token lives in a DEDICATED directory whose own DACL is protected, exact and read back BEFORE
// any file is created in it, and a file created there inherits that DACL at the instant it exists. When the directory
// is missing it is created WITH that DACL (Directory.CreateDirectory with a DirectorySecurity), so it has no
// permissive moment either. Anything unexpected - a reparse point, a foreign owner, a DACL that does not read back as
// set - and no token is minted: the hosting controls stay off and the node says why.

const SYSTEM = "S-1-5-18", ADMINS = "S-1-5-32-544";
const FULL = 0x1F01FF, READ_EXEC = 0x1200A9, SYNCHRONIZE = 0x100000;
const OICI = 3;          // ContainerInherit | ObjectInherit: the entry reaches every file born inside

/** Where the node writes the token and the tray reads it, unless both are told otherwise. ProgramData on Windows, so
 *  the tray finds it without knowing where the node is installed; its own directory, which holds nothing else. */
export function tokenFileDefault(dir) {
  return process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "Enclave", "hosting", "hosting-admin.token")
    : path.join(dir, "hosting", "hosting-admin.token");
}

/** The token directory's DACL, exactly: SYSTEM, Administrators and this node's own account full; the tray's user
 *  read and traverse. Each is inherited by what is created inside. SIDs, never names, which are localised. */
export function expectedDacl({ selfSid = "", traySid = "" } = {}) {
  const want = [{ sid: SYSTEM, rights: FULL }, { sid: ADMINS, rights: FULL }];
  if (selfSid && !want.some((w) => w.sid === selfSid)) want.push({ sid: selfSid, rights: FULL });
  if (traySid && !want.some((w) => w.sid === traySid)) want.push({ sid: traySid, rights: READ_EXEC });
  return want;
}

const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const bits = (n) => (((Number(n) >>> 0) & ~SYNCHRONIZE) >>> 0);        // .NET adds SYNCHRONIZE to every allow entry
const hex = (n) => `0x${(Number(n) >>> 0).toString(16)}`;

/** Why an inspected path may not hold (or lead to) the token, as far as what it IS and who OWNS it; or null. */
function standingProblem(item, owners, { dir = true } = {}) {
  if (!item || item.exists !== true) return "it does not exist";
  if (item.reparse) return "it is a reparse point (a junction or a symbolic link)";
  if (dir ? !item.dir : item.dir) return dir ? "it is not a directory" : "it is a directory";
  if (!owners.includes(item.owner))
    return `it is owned by ${String(item.owner).slice(0, 80)}, not SYSTEM, Administrators or this node's account`;
  return null;
}

/**
 * daclProblem(item, want, owners, {file}) -> why this inspected directory (or the token file in it) is not exactly what
 * this node set, or null. The directory: protected, and EXACTLY the wanted entries, explicit, allow, inherited by what
 * is born inside. The file: exactly the same entries, every one inherited from that directory, nothing of its own.
 */
export function daclProblem(item, want, owners, { file = false } = {}) {
  const standing = standingProblem(item, owners, { dir: !file });
  if (standing) return standing;
  if (!file && item.protected !== true) return "its DACL is not protected: it still inherits from the folder above";
  const rules = list(item.rules);
  for (const r of rules) {
    const w = want.find((x) => x.sid === r.sid);
    if (!w) return `its DACL grants ${String(r.sid).slice(0, 80)}, which is not SYSTEM, Administrators, this node's account or the tray's user`;
    if (r.allow !== true) return `its DACL has a deny entry for ${r.sid}, which this node did not set`;
    if (bits(r.rights) !== bits(w.rights)) return `its DACL gives ${r.sid} ${hex(r.rights)}, not ${hex(w.rights)}`;
    if (file ? r.inherited !== true : r.inherited !== false || Number(r.flags) !== OICI)
      return file ? `its entry for ${r.sid} is its own, not inherited from the token directory`
                  : `its entry for ${r.sid} is ${r.inherited ? "inherited" : "not inherited by what is created inside"}`;
  }
  for (const w of want) if (!rules.some((r) => r.sid === w.sid)) return `its DACL does not grant ${w.sid}`;
  if (rules.length !== want.length) return `its DACL has ${rules.length} entries, not the ${want.length} this node set`;
  return null;
}

// The Windows half, in PowerShell because .NET is the in-box way to create a directory WITH a security descriptor and
// to read a DACL back as SIDs. Values travel in environment variables, never on a command line, and answers come back
// as JSON on stdout ({error} on failure).
const PS_INSPECT = String.raw`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $S = [Security.Principal.SecurityIdentifier]
  $self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $tray = $null
  if ($env:ENCLAVE_TRAY_USER) { $tray = (New-Object Security.Principal.NTAccount($env:ENCLAVE_TRAY_USER)).Translate($S).Value }
  $items = @()
  foreach ($p in ($env:ENCLAVE_PATHS -split '\|')) {
    $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($null -eq $i) { $items += [pscustomobject]@{ exists = $false }; continue }
    $a = Get-Acl -LiteralPath $p
    $rules = @($a.GetAccessRules($true, $true, $S) | ForEach-Object {
      [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = $_.FileSystemRights.value__;
                         allow = ($_.AccessControlType -eq 'Allow'); inherited = $_.IsInherited; flags = $_.InheritanceFlags.value__ } })
    $items += [pscustomobject]@{ exists = $true; dir = [bool]$i.PSIsContainer;
      reparse = [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); owner = $a.GetOwner($S).Value;
      protected = [bool]$a.AreAccessRulesProtected; rules = $rules }
  }
  [Console]::Out.Write(([pscustomobject]@{ selfSid = $self; traySid = $tray; items = $items } | ConvertTo-Json -Compress -Depth 6))
} catch { [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)); exit 3 }`;
const PS_PROTECT = String.raw`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($g in ($env:ENCLAVE_GRANTS -split ';')) {
    $sid, $rights = $g -split '='
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier($sid)), [Security.AccessControl.FileSystemRights][int]$rights,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)))
  }
  $d = $env:ENCLAVE_DIR
  if (Test-Path -LiteralPath $d) { [IO.Directory]::SetAccessControl($d, $sec); $act = 'applied' }
  else { [void][IO.Directory]::CreateDirectory($d, $sec); $act = 'created' }
  [Console]::Out.Write((@{ action = $act } | ConvertTo-Json -Compress))
} catch { [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)); exit 3 }`;

function powershell(script, env) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  return new Promise((resolve, reject) => {
    execFile(exe, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
      let o = null;
      try { o = JSON.parse(String(stdout).trim()); } catch {}
      if (o && o.error) return reject(new Error(String(o.error).slice(0, 300)));
      if (e || !o) return reject(new Error(`powershell: ${String(stderr || (e && e.message) || stdout).trim().split(/\r?\n/)[0].slice(0, 300)}`));
      resolve(o);
    });
  });
}

/** The two Windows steps mintToken takes; replaceable in tests. */
export const windowsOps = {
  // -> { selfSid, traySid, items: [{ exists, dir, reparse, owner, protected, rules: [{ sid, rights, allow, inherited, flags }] }] }
  inspect: (paths, trayUser) => powershell(PS_INSPECT, { ENCLAVE_PATHS: paths.join("|"), ENCLAVE_TRAY_USER: trayUser || "" }),
  // the directory created WITH exactly this protected DACL when missing, else its DACL replaced by exactly this one
  protect: (dir, want) => powershell(PS_PROTECT, { ENCLAVE_DIR: dir, ENCLAVE_GRANTS: want.map((w) => `${w.sid}=${w.rights}`).join(";") }),
};

/** The file-system steps mintToken takes, apart so a test can watch their order. */
export const fsOps = {
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  isLink: (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { if (e.code === "ENOENT") return false; throw e; } },
  realpath: (p) => fs.realpathSync.native(p),
  writeNew: (p, data) => {
    const fd = fs.openSync(p, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  rename: (a, b) => fs.renameSync(a, b),
  unlink: (p) => { try { fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; } },
};
const samePath = (a, b) => path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();

/**
 * A FRESH token, every start, in a file only SYSTEM, Administrators, this process's account and the tray's user can
 * read. Resolves to the token; rejects when that cannot be established, and the caller then serves no admin API.
 *
 * Fresh, never reused: whatever sits at the token's name - an earlier start's token, or something planted - is
 * replaced by a rename and never read. On Windows, in this order, each step refusing on anything unexpected:
 *   1. the folder above is not a link or junction (nor anything above it) and belongs to SYSTEM, Administrators or
 *      this node's account; the token directory, if there, likewise;
 *   2. the directory's DACL is set: protected, exactly expectedDacl() - at birth when the directory is new;
 *   3. it is read back and must be exactly that (daclProblem), and still not a link;
 *   4. only now a file: the token under a random name (create-new), renamed over the final name;
 *   5. the file as it landed must carry exactly the directory's entries, inherited, before its token is used.
 * Elsewhere: a 0700 directory and a 0600 file, by the same temporary name and rename.
 */
export async function mintToken(file, { trayUser = "", platform = process.platform, win = windowsOps, fsx = fsOps } = {}) {
  const dir = path.dirname(file), parent = path.dirname(dir);
  const token = crypto.randomBytes(32).toString("base64url");
  const tmp = path.join(dir, `.hosting-admin.${crypto.randomBytes(8).toString("hex")}.tmp`);
  if (platform !== "win32") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    try { fsx.writeNew(tmp, token + "\n"); fsx.rename(tmp, file); } catch (e) { fsx.unlink(tmp); throw e; }
    return token;
  }
  const refuse = (where, why) => { throw new Error(`${where}: ${why}`); };
  // 1.
  fsx.mkdirp(parent);
  for (const p of [parent, dir]) if (fsx.isLink(p)) refuse(p, "it is a symbolic link or a junction");
  const realParent = fsx.realpath(parent);
  if (!samePath(realParent, parent)) refuse(parent, `it resolves to ${realParent}: a folder on the way is a junction or a link`);
  let seen = await win.inspect([parent, dir], trayUser);
  const want = expectedDacl(seen);
  const owners = [SYSTEM, ADMINS, seen.selfSid].filter(Boolean);
  if (trayUser && !seen.traySid) refuse(trayUser, "the tray user did not resolve to a SID");
  let [p, d] = list(seen.items);
  const pw = standingProblem(p, owners); if (pw) refuse(parent, pw);
  if (d && d.exists) { const dw = standingProblem(d, owners); if (dw) refuse(dir, dw); }
  // 2.
  await win.protect(dir, want);
  // 3.
  seen = await win.inspect([parent, dir], trayUser);
  [p, d] = list(seen.items);
  const pw2 = standingProblem(p, owners); if (pw2) refuse(parent, pw2);
  const dw2 = daclProblem(d, want, owners); if (dw2) refuse(dir, `${dw2} (read back after it was set)`);
  if (fsx.isLink(dir)) refuse(dir, "it is a symbolic link or a junction");
  const realDir = fsx.realpath(dir);
  if (!samePath(realDir, dir)) refuse(dir, `it resolves to ${realDir}`);
  // 4. and 5.
  try {
    fsx.writeNew(tmp, token + "\n");
    fsx.rename(tmp, file);
    seen = await win.inspect([dir, file], trayUser);
    const [d3, f3] = list(seen.items);
    const dw3 = daclProblem(d3, want, owners); if (dw3) refuse(dir, `${dw3} (after the token was written)`);
    const fw = daclProblem(f3, want, owners, { file: true }); if (fw) refuse(file, fw);
    const realFile = fsx.realpath(file);
    if (!samePath(realFile, path.join(realDir, path.basename(file)))) refuse(file, `it resolves to ${realFile}`);
    return token;
  } catch (e) {
    fsx.unlink(tmp); fsx.unlink(file);           // a token that was never verified is never left to be read
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
