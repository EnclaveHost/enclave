// Site delivery against REAL servers (work/site-automation-interface.txt §7): actual Caddy processes serving each
// release root (reloaded through their admin endpoints), an actual kubo daemon (temporary repo, offline, no swarm
// listeners) driven through its RPC API, and actual OpenSSH (a loopback sshd on a scratch port with scratch keys)
// running the release agent as a forced command. Everything listens on 127.0.0.1 and is torn down after the run.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareRelease, fetchRelease } from "../scripts/site-release/release.mjs";
import { loadTargets } from "../scripts/site-release/targets.mjs";
import { validateSshTarget, agentCall } from "../scripts/site-release/ssh.mjs";
import { readCar, extractCar } from "../scripts/site-release/car.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(REPO, "scripts/site-release/cli.mjs");
const CADDY = path.resolve(REPO, "../custody-caddy/caddy");
const HOTFIX = path.resolve(REPO, "../logo-site-hotfix/final");   // the production tree, CAR and manifest
const PROD_CID = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y";
const have = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const missing = [!fs.existsSync(CADDY) && "caddy (work/custody-caddy/caddy)", !have("ipfs", ["version"]) && "kubo", !fs.existsSync("/usr/sbin/sshd") && "sshd",
  !have("ssh", ["-V"]) && "ssh"].filter(Boolean);
const T = missing.length ? { skip: `needs ${missing.join(", ")}`, timeout: 240000 } : { timeout: 240000 };
const H = 3600e3, T0 = Date.now() - 2 * H;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const cspHash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const waitPort = async (port, what, proc) => {
  for (let i = 0; i < 200; i++) {
    if (proc && proc.exitCode !== null) throw new Error(`${what} exited: ${proc.log()}`);
    if (await new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); })) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what} did not listen on ${port}`);
};
let tmp; const procs = [];
function start(cmd, args, env, what) {
  // not detached: the servers stay in the test's own process group, so its resource guard counts (and can stop) them
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => { log = (log + d).slice(-8000); }); p.stderr.on("data", (d) => { log = (log + d).slice(-8000); });
  p.log = () => log; p.what = what; procs.push(p); return p;
}
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-delivery-")); });
after(() => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
function makeDist(name, { chunks, scripts }) {
  const d = dir(name);
  write(d, "index.html", `<html><head><script>${scripts[0]}</script></head><body>${name}<script type="module" src="js/boot.js"></script></body></html>`);
  write(d, "js/boot.js", `import("./chunks/${Object.keys(chunks)[0]}");`);
  for (const [n, body] of Object.entries(chunks)) write(d, `js/chunks/${n}`, body);
  write(d, "csp-script-src.txt", `script-src 'self' 'wasm-unsafe-eval' ${scripts.map(cspHash).join(" ")};\n`);
  write(d, ".well-known/security.txt", "Contact: mailto:security@example.invalid\n");
  return d;
}
const get = (port, p) => new Promise((ok, no) => http.get({ host: "127.0.0.1", port, path: p, headers: { "accept-encoding": "identity" } }, (res) => {
  const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
}).on("error", no));
const tool = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TOOL, ...args], { env: { PATH: process.env.PATH, HOME: tmp, ...env } });
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ code, out, err }));
});

// one actual Caddy per release root: it serves root/current/site and root/current/installers and imports
// root/headers.caddy, exactly the operator layout docs/site-release.md describes; reload goes through its admin API
async function caddyFront(name, root, { stale = null } = {}) {
  const port = await freePort(), admin = await freePort(), data = dir(`caddy-${name}-data`), cfg = path.join(tmp, `Caddyfile-${name}`);
  fs.writeFileSync(path.join(root, "headers.caddy"), "");   // the operator's one-time bootstrap: the import exists before any release
  const render = (siteRoot) => `{\n\tadmin 127.0.0.1:${admin}\n\tpersist_config off\n\tauto_https off\n\tstorage file_system ${data}\n}\n`
    + `http://127.0.0.1:${port} {\n\timport ${root}/headers.caddy\n\t@install path /install.sh /install.ps1\n\thandle @install {\n`
    + `\t\troot * ${root}/current/installers\n\t\theader Content-Type "text/plain; charset=utf-8"\n\t\tfile_server\n\t}\n`
    + `\thandle {\n\t\troot * ${siteRoot}\n\t\tfile_server\n\t}\n}\n`;
  fs.writeFileSync(cfg, render(`${root}/current/site`));
  const env = { PATH: process.env.PATH, HOME: data, XDG_DATA_HOME: data, XDG_CONFIG_HOME: data };
  const p = start(CADDY, ["run", "--config", cfg, "--adapter", "caddyfile"], env, `caddy ${name}`);
  await waitPort(port, `caddy ${name}`, p); await waitPort(admin, `caddy ${name} admin`, p);
  const reload = [CADDY, "reload", "--config", cfg, "--adapter", "caddyfile", "--address", `127.0.0.1:${admin}`];
  return { name, root, port, admin, cfg, reload, url: `http://127.0.0.1:${port}/`,
    render, misconfigure: (siteRoot) => fs.writeFileSync(cfg, render(siteRoot)), restore: () => fs.writeFileSync(cfg, render(`${root}/current/site`)) };
}

let prodHost;
let r1, r2, installers, A, B, C, kubo, sshd, targetsFile, keyText, knownHosts, JOURNAL, faultFile, opLog;
const activateBlock = (front, extra = {}) => ({ reload: front.reload, probe: { url: front.url, paths: ["index.html", "js/boot.js"], headers: true }, ...extra });

test("setup: two releases, two Caddy fronts, a kubo RPC daemon and an sshd whose forced command is the release agent", T, async () => {
  installers = dir("cli");
  for (const n of ["install.sh", "install.ps1", "host.ps1"]) write(installers, n, `# ${n}\n`);
  r1 = prepareRelease({ dist: makeDist("dist1", { chunks: { "a-AAAA.js": "a1", "b-BBBB.js": "b1" }, scripts: ["one"] }), installers, out: dir("out"), noBase: true, now: T0 });
  r2 = prepareRelease({ dist: makeDist("dist2", { chunks: { "b-BBBB.js": "b1", "c-CCCC.js": "c2" }, scripts: ["two"] }), installers, out: dir("out"), base: r1.dir, now: T0 + H });
  A = await caddyFront("a", dir("root-a")); B = await caddyFront("b", dir("root-b"));
  // kubo: a temporary repo, offline, no swarm listeners, no bootstrap peers; RPC and gateway on loopback only
  const repo = dir("kubo"), kenv = { PATH: process.env.PATH, HOME: tmp, IPFS_PATH: repo };
  execFileSync("ipfs", ["init", "--empty-repo", "--profile=test"], { env: kenv, stdio: "ignore" });
  const api = await freePort(), gw = await freePort();
  for (const [k, v] of [["Addresses.API", `"/ip4/127.0.0.1/tcp/${api}"`], ["Addresses.Gateway", `"/ip4/127.0.0.1/tcp/${gw}"`], ["Addresses.Swarm", "[]"],
    ["Bootstrap", "[]"], ["Routing.Type", '"none"']]) execFileSync("ipfs", ["config", "--json", k, v], { env: kenv });
  const kp = start("ipfs", ["daemon", "--offline"], kenv, "kubo");
  await waitPort(api, "kubo API", kp); await waitPort(gw, "kubo gateway", kp);
  kubo = { api: `http://127.0.0.1:${api}`, gateway: `http://127.0.0.1:${gw}`, env: kenv };
  // the ssh host C: its own root, its own Caddy, its own agent.json; the client's key can only run the agent
  C = await caddyFront("c", dir("root-c"));
  const sd = dir("sshd"), agentJson = path.join(sd, "agent.json");
  fs.writeFileSync(agentJson, JSON.stringify({ name: "host-c", kind: "local-root", root: C.root, activate: activateBlock(C) }));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(sd, "host")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(sd, "client")]);
  // the forced command runs the REAL agent through a fault wrapper: when the fault file names the operation, the agent
  // runs to completion (it commits and journals) and then the ssh session is killed before its answer is written
  JOURNAL = dir("journal"); faultFile = path.join(sd, "fault"); opLog = path.join(sd, "ops.log");
  const wrapper = path.join(sd, "agent-cut.mjs");
  // faults (a JSON file, or a plain list meaning "cut"):
  //   cut:   the real agent runs and records its result; then the ssh session is killed before its answer
  //   drop:  the agent never runs (the host is unreachable for that operation)
  //   delay: a DETACHED copy of the real agent waits for <fault>.gate BEFORE it even starts (so before the root lock),
  //          while this session ends at once without an answer: the operation arrives late, after the client gave up
  fs.writeFileSync(wrapper, `import {spawn} from "node:child_process"; import fs from "node:fs";
const late = process.argv[2] === "--late", [node, cli, cfg, fault, log] = process.argv.slice(late ? 3 : 2);
const words = String(process.env.SSH_ORIGINAL_COMMAND || "").split(" "), op = words[words.indexOf("site-release-agent-v1") + 1];
const raw = fs.existsSync(fault) ? fs.readFileSync(fault, "utf8").trim() : "";
const faults = raw.startsWith("{") ? JSON.parse(raw) : { cut: raw ? raw.split(",") : [] }, has = (k) => (faults[k] || []).includes(op);
const agent = (done) => { const child = spawn(node, [cli, "agent", "--config", cfg], {stdio: [late ? "ignore" : "inherit", "pipe", "inherit"]});
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.on("close", (code) => done(out, code)); };
if (late) {
  const wait = () => fs.existsSync(fault + ".gate") ? agent((out) => fs.appendFileSync(log, JSON.stringify({op, late: true, answer: out.trim()}) + "\\n")) : setTimeout(wait, 25);
  wait();
} else if (has("delay")) {
  spawn(node, [process.argv[1], "--late", node, cli, cfg, fault, log], {detached: true, stdio: "ignore", env: process.env}).unref();
  fs.appendFileSync(log, JSON.stringify({op, delayed: true}) + "\\n");
  process.exit(255);
} else if (has("drop")) {
  fs.appendFileSync(log, JSON.stringify({op, dropped: true}) + "\\n");
  process.exit(255);
} else agent((out, code) => {
  fs.appendFileSync(log, JSON.stringify({op, cut: has("cut"), answer: out.trim()}) + "\\n");
  if (has("cut")) { process.kill(process.ppid, "SIGKILL"); setTimeout(() => process.exit(255), 2000); return; }
  process.stdout.write(out); process.exitCode = code;
});
`);
  const forced = (cfg) => `${process.execPath} ${wrapper} ${process.execPath} ${TOOL} ${cfg} ${faultFile} ${opLog}`;
  // a second key, bound to an ISOLATED root for the production payload (its own agent.json and Caddy)
  const P = await caddyFront("p", dir("root-p")), prodJson = path.join(sd, "agent-prod.json");
  fs.writeFileSync(prodJson, JSON.stringify({ name: "host-p", kind: "local-root", root: P.root, maxCarBytes: 64 * 1024 * 1024,
    activate: { reload: P.reload, probe: { url: P.url, paths: ["index.html", "js/boot.js", "dashboard.html"], headers: true } } }));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(sd, "client-prod")]);
  fs.writeFileSync(path.join(sd, "authorized_keys"), `restrict,command="${forced(agentJson)}" ${fs.readFileSync(path.join(sd, "client.pub"), "utf8")}`
    + `restrict,command="${process.execPath} ${TOOL} agent --config ${prodJson}" ${fs.readFileSync(path.join(sd, "client-prod.pub"), "utf8")}`, { mode: 0o600 });
  prodHost = { P, key: fs.readFileSync(path.join(sd, "client-prod"), "utf8") };
  const port = await freePort();
  fs.writeFileSync(path.join(sd, "sshd_config"), [`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${sd}/host`, `PidFile ${sd}/sshd.pid`,
    `AuthorizedKeysFile ${sd}/authorized_keys`, "UsePAM no", "StrictModes no", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
    "AllowTcpForwarding no", "X11Forwarding no", "PermitTTY no", "LogLevel ERROR", ""].join("\n"));
  const sp = start("/usr/sbin/sshd", ["-D", "-e", "-f", path.join(sd, "sshd_config")], { PATH: process.env.PATH }, "sshd");
  await waitPort(port, "sshd", sp);
  keyText = fs.readFileSync(path.join(sd, "client"), "utf8");
  knownHosts = `[127.0.0.1]:${port} ${fs.readFileSync(path.join(sd, "host.pub"), "utf8").split(" ").slice(0, 2).join(" ")}\n`;
  sshd = { port, user: os.userInfo().username, sd };
  targetsFile = path.join(tmp, "targets.json");
  // file order is activation order: a, then the ssh host c, then b (so a b failure must roll back an ssh host too)
  fs.writeFileSync(targetsFile, JSON.stringify({ version: 1, targets: [
    { name: "a", kind: "local-root", root: A.root, activate: activateBlock(A) },
    { name: "c", kind: "ssh", host: "127.0.0.1", port, user: sshd.user, keyEnv: "SITE_DELIVERY_SSH_KEY", knownHostsEnv: "SITE_DELIVERY_KNOWN_HOSTS",
      agent: [process.execPath, TOOL, "agent", "--config", agentJson], activate: true },
    { name: "b", kind: "local-root", root: B.root, activate: activateBlock(B) },
    { name: "k", kind: "kubo", api: kubo.api } ] }));
  assert.equal(loadTargets(targetsFile).length, 4);
});

const creds = () => ({ SITE_DELIVERY_SSH_KEY: keyText, SITE_DELIVERY_KNOWN_HOSTS: knownHosts });
const tempKeyDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("site-release-ssh-"));

test("deliver r1: every target (two Caddy roots, an ssh host, a kubo node) holds and serves the same verified CID", T, async () => {
  const before = tempKeyDirs();
  const d = await tool(["deliver", "--release", r1.dir, "--targets", targetsFile, "--approve", r1.cid, "--journal", JOURNAL], creds());
  assert.equal(d.code, 0, d.err + d.out);
  assert.doesNotMatch(d.out + d.err, /PRIVATE KEY|ssh-ed25519 AAAA/, "no credential is ever printed");
  assert.deepEqual(tempKeyDirs(), before, "the materialized ssh credentials were removed");
  for (const f of [A, B, C]) {
    assert.equal(fs.readlinkSync(path.join(f.root, "current")), r1.cid);
    const page = await get(f.port, "/index.html");
    assert.equal(page.status, 200); assert.equal(sha(page.body), r1.manifest.files.find((x) => x.path === "index.html").sha256);
    assert.equal(page.headers["content-security-policy"], r1.manifest.headers["Content-Security-Policy"], `${f.name}: the CSP actual Caddy serves`);
    assert.equal(page.headers["cross-origin-opener-policy"], "same-origin-allow-popups");
    const inst = await get(f.port, "/install.sh");
    assert.deepEqual([inst.status, inst.body.toString()], [200, "# install.sh\n"]);
  }
  // the kubo node pinned it through its RPC, and its own trustless gateway returns a CAR verifying to the CID
  const pins = execFileSync("ipfs", ["pin", "ls", "--type=recursive", r1.cid], { env: kubo.env }).toString();
  assert.match(pins, new RegExp(`${r1.cid} recursive`));
  const back = await fetchRelease({ cid: r1.cid, gateways: [kubo.gateway], out: dir("from-kubo") });
  assert.equal(sha(fs.readFileSync(path.join(back.dir, "release.json"))), sha(fs.readFileSync(path.join(r1.dir, "release.json"))), "byte-identical via kubo");
  // the ssh host's agent re-derived the release from the CAR alone: the same release.json bytes
  assert.ok(fs.readFileSync(path.join(C.root, r1.cid, "release.json")).equals(fs.readFileSync(path.join(r1.dir, "release.json"))));
});

test("deliver r2: headers go live before content; a tab cached on r1 keeps its chunk and its inline script under actual Caddy", T, async () => {
  // observe the server at reload time on a: the reload command records what Caddy serves right after it reloads
  const seen = path.join(tmp, "seen.jsonl"), wrapper = path.join(tmp, "reload-and-look.mjs");
  fs.writeFileSync(wrapper, `import {execFileSync} from "node:child_process";import http from "node:http";import fs from "node:fs";import {createHash} from "node:crypto";
execFileSync(process.argv[2], process.argv.slice(3), {stdio: "ignore"});
http.get({host: "127.0.0.1", port: ${A.port}, path: "/index.html"}, (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => {
  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({csp: res.headers["content-security-policy"], body: createHash("sha256").update(Buffer.concat(c)).digest("hex")}) + "\\n"); }); });`);
  const t = JSON.parse(fs.readFileSync(targetsFile, "utf8"));
  t.targets[0].activate.reload = [process.execPath, wrapper, ...A.reload];
  const observed = path.join(tmp, "targets-observed.json"); fs.writeFileSync(observed, JSON.stringify(t));
  const d = await tool(["deliver", "--release", r2.dir, "--targets", observed, "--approve", r2.cid, "--journal", JOURNAL], creds());
  assert.equal(d.code, 0, d.err + d.out);
  const at = JSON.parse(fs.readFileSync(seen, "utf8").trim().split("\n")[0]);
  assert.equal(at.body, r1.manifest.files.find((x) => x.path === "index.html").sha256, "at reload the content is still r1");
  assert.ok(at.csp.includes(cspHash("two")) && at.csp.includes(cspHash("one")), "while the headers are already r2's superset");
  for (const f of [A, B, C]) {
    assert.equal(fs.readlinkSync(path.join(f.root, "current")), r2.cid);
    const cached = await get(f.port, "/js/chunks/a-AAAA.js");          // only r1 built it; r2 retains it
    assert.deepEqual([cached.status, cached.body.toString()], [200, "a1"]);
    assert.ok(cached.headers["content-security-policy"].includes(cspHash("one")), `${f.name}: r1's inline script still allowed`);
  }
});

test("a front that serves stale content fails its probe: a, the ssh host and b all roll back to the release they served", T, async () => {
  const r3 = prepareRelease({ dist: makeDist("dist3", { chunks: { "d-DDDD.js": "d3" }, scripts: ["three"] }), installers, out: dir("out"), base: r2.dir, now: T0 + 2 * H });
  B.misconfigure(`${B.root}/${r2.cid}/site`);   // an operator mistake on b: its Caddy is pinned to an old tree
  try {
    const d = await tool(["deliver", "--release", r3.dir, "--targets", targetsFile, "--approve", r3.cid, "--journal", JOURNAL], creds());
    assert.equal(d.code, 1, d.out);
    assert.match(d.err, /failed and was reverted: .*\(a: undone, c: undone, b: rolled-back\)/);
  } finally { B.restore(); execFileSync(B.reload[0], B.reload.slice(1), { stdio: "ignore" }); }
  for (const f of [A, B, C]) {
    assert.equal(fs.readlinkSync(path.join(f.root, "current")), r2.cid, `${f.name} is back on r2`);
    const page = await get(f.port, "/index.html");
    assert.equal(sha(page.body), r2.manifest.files.find((x) => x.path === "index.html").sha256);
    assert.equal(page.headers["content-security-policy"], r2.manifest.headers["Content-Security-Policy"], `${f.name}: r2's headers are restored`);
    assert.ok(fs.existsSync(path.join(f.root, r3.cid)), "the mirrored r3 stays (only prune removes releases)");
  }
  // full rollout rollback, explicitly: every target, ssh included, back to r1
  const rb = await tool(["rollback", "--targets", targetsFile, "--to", r1.cid, "--approve", r1.cid, "--journal", JOURNAL], creds());
  assert.equal(rb.code, 0, rb.err);
  for (const f of [A, B, C]) assert.equal(fs.readlinkSync(path.join(f.root, "current")), r1.cid);
});

test("ssh: a wrong host key, an unsafe token and a forged operation change nothing", T, async () => {
  const st = JSON.parse(execFileSync("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${writeTmp("kh", knownHosts)}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-i", writeTmp("k", keyText, 0o600), "-p", String(sshd.port),
    "-l", sshd.user, "--", "127.0.0.1", "x site-release-agent-v1 status"]).toString().trim());
  assert.equal(st.ok, true); assert.equal(st.current, r1.cid);
  // the server enforces its grammar whatever the client sends: a path, a shell fragment, an unknown operation
  for (const evil of ["site-release-agent-v1 activate ../../etc", "site-release-agent-v1 rollback $(id)", "site-release-agent-v1 receive x y; rm -rf /", "site-release-agent-v1 shell"]) {
    const r = spawnSync("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${writeTmp("kh", knownHosts)}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-i", writeTmp("k", keyText, 0o600), "-p", String(sshd.port),
      "-l", sshd.user, "--", "127.0.0.1", evil]);
    assert.match(r.stdout.toString(), /"ok":false.*unsupported agent operation/, evil);
  }
  // a host key the operator did not list: the transport refuses, and the run activates nothing
  const otherKey = path.join(tmp, "other-host"); execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKey]);
  const wrongKh = `[127.0.0.1]:${sshd.port} ${fs.readFileSync(otherKey + ".pub", "utf8").split(" ").slice(0, 2).join(" ")}\n`;
  const d = await tool(["deliver", "--release", r2.dir, "--targets", targetsFile, "--approve", r2.cid, "--journal", JOURNAL], { ...creds(), SITE_DELIVERY_KNOWN_HOSTS: wrongKh });
  assert.equal(d.code, 1);
  assert.match(d.out, /"name": "c"[^}]*"state": "failed"[^}]*Host key verification failed/s);
  assert.match(d.err, /nothing was activated/);
  for (const f of [A, B, C]) assert.equal(fs.readlinkSync(path.join(f.root, "current")), r1.cid);
  // unsafe tokens are refused before ssh is ever run
  assert.throws(() => validateSshTarget({ name: "x", kind: "ssh", host: "127.0.0.1", user: "u", keyFile: "/k", knownHostsFile: "/kh", agent: ["/usr/bin/node", "cli.mjs; rm -rf /"] }), /plain tokens/);
  assert.throws(() => validateSshTarget({ name: "x", kind: "ssh", host: "-oProxyCommand=evil", user: "u", keyFile: "/k", knownHostsFile: "/kh", agent: ["/usr/bin/node"] }), /DNS name/);
  assert.throws(() => validateSshTarget({ name: "x", kind: "ssh", host: "h", user: "u", keyFile: "/k", agent: ["/usr/bin/node"] }), /exactly one of knownHostsFile and knownHostsEnv/);
});
function writeTmp(n, text, mode = 0o644) { const f = path.join(tmp, `${n}-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, text, { mode }); return f; }

const ops = () => (fs.existsSync(opLog) ? fs.readFileSync(opLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
// the tool prints one JSON object per step; scan them out of stdout (strings and escapes respected)
function objects(out) {
  const found = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && --depth === 0) found.push(JSON.parse(out.slice(start, i + 1)));
  }
  return found;
}
const journalOf = (out) => objects(out).find((o) => o.step === "activate");

test("a lost ssh answer AFTER the host committed: `cancel` returns the commit (never a re-send) and the rollout completes", T, async () => {
  const r4 = prepareRelease({ dist: makeDist("dist4", { chunks: { "e-EEEE.js": "e4" }, scripts: ["four"] }), installers, out: dir("out"), base: r1.dir, now: T0 + 3 * H });
  fs.writeFileSync(faultFile, "activate");   // the agent activates and journals; then the session is killed before the answer
  const before = ops().length;
  const d = await tool(["deliver", "--release", r4.dir, "--targets", targetsFile, "--approve", r4.cid, "--journal", JOURNAL], creds());
  fs.rmSync(faultFile);
  assert.equal(d.code, 0, d.err + d.out);
  const mine = ops().slice(before), acts = mine.filter((o) => o.op === "activate");
  assert.equal(acts.length, 1, "the activation was sent exactly once"); assert.equal(acts[0].cut, true);
  assert.match(acts[0].answer, /"outcome":"committed"/, "the host had committed when the answer was cut");
  assert.ok(mine.some((o) => o.op === "cancel" && !o.cut && /"outcome":"committed"/.test(o.answer)), "the lost activation was settled by cancel, which returned its commit");
  const j = journalOf(d.out);
  assert.deepEqual(j.targets.map((x) => [x.name, x.state]), [["a", "committed"], ["c", "committed"], ["b", "committed"]]);
  for (const f of [A, B, C]) assert.equal(fs.readlinkSync(path.join(f.root, "current")), r4.cid);
});

test("a lost answer that stays unknown: PENDING (exit 5) with the journal and resolve command; a new process resolves it after the fault clears", T, async () => {
  const r5 = prepareRelease({ dist: makeDist("dist5", { chunks: { "f-FFFF.js": "f5" }, scripts: ["five"] }), installers, out: dir("out"), base: r1.dir, now: T0 + 4 * H });
  const prev = fs.readlinkSync(path.join(A.root, "current"));
  fs.writeFileSync(faultFile, "activate,cancel");   // c commits, and nothing about it gets back while the fault lasts
  const d = await tool(["deliver", "--release", r5.dir, "--targets", targetsFile, "--approve", r5.cid, "--journal", JOURNAL], creds());
  assert.equal(d.code, 5, d.err + d.out);
  assert.match(d.err, /is PENDING: .*hosts may serve different releases[^]*journal: [^]*run: site-release resolve --journal \S+ --rollout [0-9a-f]{32} --targets /);
  assert.doesNotMatch(d.err + d.out, /unchanged/);
  const j = journalOf(d.out);
  assert.deepEqual(j.targets.map((x) => [x.name, x.state]), [["a", "undone"], ["c", "unknown"], ["b", "skipped"]]);
  // the truth on the hosts: a was undone, b never touched, c DOES serve r5 (a real mixed state, reported as such)
  assert.deepEqual([A, C, B].map((f) => fs.readlinkSync(path.join(f.root, "current"))), [prev, r5.cid, prev]);
  // resolve while the host is still unreachable for results: still pending, and it sends nothing that could conflict
  const before = ops().length;
  const stuck = await tool(["resolve", "--targets", targetsFile, "--journal", JOURNAL, "--rollout", j.rolloutId], creds());
  assert.equal(stuck.code, 5, stuck.err); assert.deepEqual(ops().slice(before).map((o) => o.op), ["cancel"]);
  // the fault clears; a NEW process resolves from the journal: c had committed, the rollout had failed, so c is undone (fenced)
  fs.rmSync(faultFile);
  const ok = await tool(["resolve", "--targets", targetsFile, "--journal", JOURNAL, "--rollout", j.rolloutId], creds());
  assert.equal(ok.code, 1, ok.err + ok.out);
  assert.deepEqual(JSON.parse(ok.out).targets.map((x) => [x.name, x.state]), [["a", "undone"], ["c", "undone"], ["b", "skipped"]]);
  for (const f of [A, B, C]) assert.equal(fs.readlinkSync(path.join(f.root, "current")), prev);
  assert.equal(ops().filter((o) => o.op === "activate").length, ops().filter((o) => o.op === "activate").length);
  assert.equal(ops().slice(before).filter((o) => o.op === "activate").length, 0, "no activation was ever re-sent");
});

const late = () => ops().filter((o) => o.late);
const reloadNow = (f) => execFileSync(f.reload[0], f.reload.slice(1), { stdio: "ignore" });
async function waitLate(n) { for (let i = 0; i < 400 && late().length < n; i++) await new Promise((r) => setTimeout(r, 25)); return late()[n - 1]; }

test("an activation DELAYED BEFORE the root lock, cancel first: the tombstone wins, and the late arrival does not run", T, async () => {
  const r9 = prepareRelease({ dist: makeDist("dist9", { chunks: { "g-GGGG.js": "g9" }, scripts: ["nine"] }), installers, out: dir("out"), base: r1.dir, now: T0 + 5 * H });
  const prev = fs.readlinkSync(path.join(C.root, "current")), gen = JSON.parse(fs.readFileSync(path.join(C.root, "state.json"), "utf8")).generation;
  fs.writeFileSync(faultFile, JSON.stringify({ delay: ["activate"] }));
  const d = await tool(["deliver", "--release", r9.dir, "--targets", targetsFile, "--approve", r9.cid, "--journal", JOURNAL], creds());
  assert.equal(d.code, 1, d.err + d.out);
  assert.deepEqual(journalOf(d.out).targets.map((x) => [x.name, x.state]), [["a", "undone"], ["c", "cancelled"], ["b", "skipped"]]);
  // the delayed activation now reaches the host, long after the client gave up: it finds its tombstone and does not run
  const n = late().length;
  fs.writeFileSync(faultFile + ".gate", "");
  const arrived = await waitLate(n + 1);
  fs.rmSync(faultFile); fs.rmSync(faultFile + ".gate");
  assert.match(arrived.answer, /"outcome":"cancelled".*"replay":true/);
  assert.equal(fs.readlinkSync(path.join(C.root, "current")), prev);
  assert.equal(JSON.parse(fs.readFileSync(path.join(C.root, "state.json"), "utf8")).generation, gen, "c's generation never moved");
});

test("an activation DELAYED BEFORE the root lock that WINS (cancel unreachable): pending, then resolve finds the commit and undoes it, fenced", T, async () => {
  const r10 = prepareRelease({ dist: makeDist("dist10", { chunks: { "h-HHHH.js": "h10" }, scripts: ["ten"] }), installers, out: dir("out"), base: r1.dir, now: T0 + 6 * H });
  const prev = fs.readlinkSync(path.join(C.root, "current"));
  fs.writeFileSync(faultFile, JSON.stringify({ delay: ["activate"], drop: ["cancel"] }));
  const d = await tool(["deliver", "--release", r10.dir, "--targets", targetsFile, "--approve", r10.cid, "--journal", JOURNAL], creds());
  assert.equal(d.code, 5, d.err + d.out);
  const j = journalOf(d.out);
  assert.deepEqual(j.targets.map((x) => [x.name, x.state]), [["a", "undone"], ["c", "unknown"], ["b", "skipped"]]);
  const n = late().length;
  fs.writeFileSync(faultFile + ".gate", "");
  const arrived = await waitLate(n + 1);
  assert.match(arrived.answer, /"outcome":"committed"/, "the late activation won the race");
  assert.equal(fs.readlinkSync(path.join(C.root, "current")), r10.cid, "the real, mixed state: c serves r10, which the run reported as pending");
  fs.rmSync(faultFile); fs.rmSync(faultFile + ".gate");
  const ok = await tool(["resolve", "--targets", targetsFile, "--journal", JOURNAL, "--rollout", j.rolloutId], creds());
  assert.equal(ok.code, 1, ok.err + ok.out);
  assert.deepEqual(JSON.parse(ok.out).targets.map((x) => [x.name, x.state]), [["a", "undone"], ["c", "undone"], ["b", "skipped"]]);
  assert.equal(fs.readlinkSync(path.join(C.root, "current")), prev);
});

test("undo-failed is retryable: a REAL failed undo probe (Caddy pinned to the new tree) stays pending; once fixed, resolve's next attempt completes", T, async () => {
  const r8 = prepareRelease({ dist: makeDist("dist8", { chunks: { "i-IIII.js": "i8" }, scripts: ["eight"] }), installers, out: dir("out"), base: r1.dir, now: T0 + 7 * H });
  const prev = fs.readlinkSync(path.join(A.root, "current"));
  // b's reload: when the flag exists, first pin a's Caddy to r8's tree (so a's undo cannot be confirmed), then reload b
  const flag = path.join(tmp, "pin-a"), pinned = path.join(tmp, "Caddyfile-a-pinned"), pinner = path.join(tmp, "pinner.mjs");
  fs.writeFileSync(pinned, A.render(`${A.root}/${r8.cid}/site`));
  fs.writeFileSync(pinner, `import fs from "node:fs"; import {execFileSync} from "node:child_process";
if (fs.existsSync(${JSON.stringify(flag)})) { fs.copyFileSync(${JSON.stringify(pinned)}, ${JSON.stringify(A.cfg)}); execFileSync(${JSON.stringify(A.reload[0])}, ${JSON.stringify(A.reload.slice(1))}, {stdio: "ignore"}); }
execFileSync(${JSON.stringify(B.reload[0])}, ${JSON.stringify(B.reload.slice(1))}, {stdio: "ignore"});`);
  B.misconfigure(`${B.root}/${prev}/site`); reloadNow(B);   // b keeps serving prev: its activation fails, its rollback confirms
  fs.writeFileSync(flag, "");
  const tf = path.join(tmp, "targets-undo-retry.json");
  fs.writeFileSync(tf, JSON.stringify({ version: 1, targets: [
    { name: "a", kind: "local-root", root: A.root, activate: activateBlock(A) },
    { name: "b", kind: "local-root", root: B.root, activate: { ...activateBlock(B), reload: [process.execPath, pinner] } }] }));
  try {
    const d = await tool(["deliver", "--release", r8.dir, "--targets", tf, "--approve", r8.cid, "--journal", JOURNAL], creds());
    assert.equal(d.code, 5, d.err + d.out);
    const j = journalOf(d.out);
    assert.deepEqual(j.targets.map((x) => [x.name, x.state, x.undoAttempt ?? 0]), [["a", "undo-failed", 1], ["b", "rolled-back", 0]]);
    assert.match(j.targets[0].detail, /the undo could not be confirmed.*still serving/);
    assert.equal(fs.readlinkSync(path.join(A.root, "current")), r8.cid, "a still serves its activation (definite, reported)");
    // the operator fixes a's server; resolve (a new process) makes a NEW, fenced undo attempt and completes
    fs.rmSync(flag); A.restore(); reloadNow(A); B.restore(); reloadNow(B);
    const ok = await tool(["resolve", "--targets", tf, "--journal", JOURNAL, "--rollout", j.rolloutId], creds());
    assert.equal(ok.code, 1, ok.err + ok.out);
    assert.deepEqual(JSON.parse(ok.out).targets.map((x) => [x.name, x.state, x.undoAttempt ?? 0]), [["a", "undone", 2], ["b", "rolled-back", 0]]);
    assert.equal(fs.readlinkSync(path.join(A.root, "current")), prev);
    const opId = j.targets[0].opId, hist = (k) => JSON.parse(fs.readFileSync(path.join(A.root, "ops", `undo-${opId}-${k}.json`), "utf8")).outcome;
    assert.deepEqual([hist(1), hist(2)], ["failed", "committed"]);
    const again = await tool(["resolve", "--targets", tf, "--journal", JOURNAL, "--rollout", j.rolloutId], creds());
    assert.equal(again.code, 1); assert.equal(fs.readlinkSync(path.join(A.root, "current")), prev, "resolve is idempotent");
  } finally { fs.rmSync(flag, { force: true }); A.restore(); reloadNow(A); B.restore(); reloadNow(B); }
});

test("the PRODUCTION payload (its 39 MiB CAR) through real ssh into an isolated root: received, verified, activated under 384 MiB", T, async (t) => {
  if (!fs.existsSync(path.join(HOTFIX, "site.car"))) return t.skip("the production hotfix CAR is not beside this checkout");
  // the earlier fronts and the kubo daemon are done: stop them so this run's memory is the production payload's
  for (const p of procs) if (["caddy a", "caddy b", "caddy c", "kubo"].includes(p.what)) { try { p.kill("SIGKILL"); } catch {} }
  // the production CAR itself is the build input: verified to its CID and extracted (no browser build of the working
  // tree), then prepared as a release, in a child process so this test's own memory stays small
  const tree = path.join(tmp, "prod-tree"), outProd = dir("out-prod");
  const prep = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { readCar, extractCar } from ${JSON.stringify(path.join(REPO, "scripts/site-release/car.mjs"))};
    extractCar(readCar(fs.readFileSync(${JSON.stringify(path.join(HOTFIX, "site.car"))}), { expectRoot: ${JSON.stringify(PROD_CID)} }), ${JSON.stringify(tree)});`]);
  assert.equal(prep.status, 0, String(prep.stderr));
  const made = spawnSync(process.execPath, [TOOL, "prepare", "--dist", tree, "--installers", installers, "--out", outProd, "--base", HOTFIX,
    "--base-built-at", "2026-10-20T02:14:19.960Z"]);
  assert.equal(made.status, 0, String(made.stderr));
  const relCid = /^site release (b[a-z2-7]{58})$/m.exec(String(made.stdout))[1];
  const rel = { cid: relCid, dir: path.join(outProd, relCid) };
  const carBytes = fs.statSync(path.join(rel.dir, "site.car")).size;
  assert.ok(carBytes > 39e6, `a production-size CAR (${carBytes} bytes; production's own is 39856744)`);
  const target = { name: "p", kind: "ssh", host: "127.0.0.1", port: sshd.port, user: sshd.user, keyEnv: "PROD_KEY", knownHostsEnv: "SITE_DELIVERY_KNOWN_HOSTS",
    agent: [process.execPath, TOOL, "agent", "--config", path.join(sshd.sd, "agent-prod.json")], activate: true };
  const tf = path.join(tmp, "targets-prod.json"); fs.writeFileSync(tf, JSON.stringify({ version: 1, targets: [target] }));
  const env = { ...creds(), PROD_KEY: prodHost.key };
  // a CAR that is not the claimed release, and a CID never received: refused, nothing left behind, nothing activated
  const wrong = await agentCall(target, "receive", [rel.cid, "0".repeat(64)], { stdinFile: path.join(r1.dir, "site.car"), env: { ...process.env, ...env } });
  assert.equal(wrong.ok, false); assert.match(wrong.error, /root is .* not /);
  assert.deepEqual(fs.readdirSync(prodHost.P.root).filter((n) => !["headers.caddy", ".site-release.lock"].includes(n)), [], "nothing left behind");
  const st = await agentCall(target, "status", [], { env: { ...process.env, ...env } });
  const never = await agentCall(target, "activate", [r2.cid, "1".repeat(32), String(st.generation), st.rootId], { env: { ...process.env, ...env } });
  assert.equal(never.outcome, "refused"); assert.match(never.reason, /not present and verified/);
  const d = await tool(["deliver", "--release", rel.dir, "--targets", tf, "--approve", rel.cid, "--journal", JOURNAL], env);
  assert.equal(d.code, 0, d.err + d.out);
  const mirrorOut = objects(d.out).find((o) => o.step === "mirror");
  const recv = mirrorOut.results[0], act = journalOf(d.out).targets[0];
  t.diagnostic(`production payload: CAR ${recv.bytes} bytes; agent peak RSS receive ${recv.agentMaxRssMiB} MiB, activate ${act.agentMaxRssMiB} MiB`);
  assert.equal(recv.bytes, carBytes);
  assert.ok(recv.agentMaxRssMiB <= 384 && act.agentMaxRssMiB <= 384, "the agent stays within 384 MiB");
  assert.equal(act.state, "committed");
  const page = await get(prodHost.P.port, "/dashboard.html");
  assert.equal(sha(page.body), JSON.parse(fs.readFileSync(path.join(HOTFIX, "manifest.json"), "utf8")).fileManifest.find((f) => f.path === "dashboard.html").sha256);
  for (const h of fs.readFileSync(path.join(HOTFIX, "site/csp-script-src.txt"), "utf8").match(/'sha256-[^']+'/g))
    assert.ok(page.headers["content-security-policy"].includes(h), "every production inline-script hash is served");
  // a CAR over the host's maxCarBytes is refused while streaming, before it is parsed
  const big = path.join(tmp, "big.car"); fs.writeFileSync(big, Buffer.alloc(65 * 1024 * 1024));
  const over = await agentCall(target, "receive", [r2.cid, "0".repeat(64)], { stdinFile: big, env: { ...process.env, ...env } }).catch((e) => ({ ok: false, error: e.message }));
  assert.equal(over.ok, false); assert.match(over.error, /larger than this host accepts|failed/);
});
