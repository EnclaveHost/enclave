// The "ssh" release target (work/site-automation-interface.txt §2): real OpenSSH to an operator's host, where the
// same tool runs as an agent over the host operator's OWN agent.json (its root, reload and probe). The client chooses
// nothing on the host but the release: it sends site.car on stdin and one fixed operation line.
//
// argv boundaries: ssh joins its remote argv with spaces for the remote shell, so every token sent is restricted to
// [A-Za-z0-9_@%+=:,./-]: what the remote shell receives is exactly the argv. Host keys are checked strictly against
// the operator's known_hosts (never accept-new); the operator's ssh config and agent are never consulted. A key or
// known_hosts given through the environment is written to a fresh 0700 directory and removed afterwards; it is never
// logged and never part of a release.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const MARKER = "site-release-agent-v1";
const TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const exact = (v, keys, need) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k)) && need.every((k) => k in v);

export function validateSshTarget(x) {
  const keys = ["name", "kind", "host", "port", "user", "keyFile", "keyEnv", "knownHostsFile", "knownHostsEnv", "agent", "activate", "timeoutMs"];
  if (!exact(x, keys, ["name", "kind", "host", "user", "agent"])) throw new Error(`target ${x?.name}: an ssh target takes ${keys.join(", ")} (host, user and agent required)`);
  if (typeof x.host !== "string" || !HOST.test(x.host) || x.host.startsWith("-")) throw new Error(`target ${x.name}: host must be a DNS name or a literal address`);
  if (typeof x.user !== "string" || !USER.test(x.user)) throw new Error(`target ${x.name}: user must be a plain account name`);
  if (x.port !== undefined && !(Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535)) throw new Error(`target ${x.name}: port is 1..65535`);
  if (("keyFile" in x) === ("keyEnv" in x)) throw new Error(`target ${x.name}: give exactly one of keyFile and keyEnv`);
  if (("knownHostsFile" in x) === ("knownHostsEnv" in x)) throw new Error(`target ${x.name}: give exactly one of knownHostsFile and knownHostsEnv (host keys are always checked)`);
  for (const k of ["keyFile", "knownHostsFile"]) if (k in x && !(typeof x[k] === "string" && path.isAbsolute(x[k]))) throw new Error(`target ${x.name}: ${k} is an absolute path`);
  for (const k of ["keyEnv", "knownHostsEnv"]) if (k in x && !(typeof x[k] === "string" && ENV.test(x[k]))) throw new Error(`target ${x.name}: ${k} names an environment variable`);
  if (!Array.isArray(x.agent) || !x.agent.length || x.agent.length > 16 || !x.agent.every((t) => typeof t === "string" && TOKEN.test(t)) || !path.isAbsolute(x.agent[0]))
    throw new Error(`target ${x.name}: agent is an argv of plain tokens whose program is an absolute path`);
  if (x.activate !== undefined && typeof x.activate !== "boolean") throw new Error(`target ${x.name}: activate is true or false`);
  if (x.timeoutMs !== undefined && !(Number.isInteger(x.timeoutMs) && x.timeoutMs >= 1000 && x.timeoutMs <= 3600000)) throw new Error(`target ${x.name}: timeoutMs is 1000..3600000`);
  return x;
}

/** Materialize the credentials for one call. -> {key, knownHosts, cleanup} */
function credentials(t, env) {
  let dir = null;
  const file = (name, content) => {
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "site-release-ssh-"));
    fs.chmodSync(dir, 0o700);
    const f = path.join(dir, name);
    fs.writeFileSync(f, content.endsWith("\n") ? content : content + "\n", { mode: 0o600, flag: "wx" });
    return f;
  };
  try {
    const fromEnv = (name, what) => { const v = env[name]; if (!v) throw new Error(`target ${t.name}: ${name} (the ${what}) is not set`); return v; };
    const key = t.keyFile ?? file("key", fromEnv(t.keyEnv, "ssh private key"));
    const knownHosts = t.knownHostsFile ?? file("known_hosts", fromEnv(t.knownHostsEnv, "known_hosts"));
    return { key, knownHosts, cleanup: () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
  } catch (e) { if (dir) fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

/** The exact ssh argv for one agent operation (exported for review and tests). */
export function sshArgv(t, { key, knownHosts }, op, args = []) {
  for (const a of [op, ...args]) if (!TOKEN.test(String(a))) throw new Error(`refusing an agent argument that is not a plain token: ${JSON.stringify(a)}`);
  return ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-i", key, "-p", String(t.port ?? 22), "-l", t.user, "--", t.host.replace(/^\[|\]$/g, ""), [...t.agent, MARKER, op, ...args].join(" ")];
}

/**
 * One agent operation. stdin: a file path whose bytes are streamed (the CAR) or null. -> the agent's JSON answer.
 * A transport failure, a refused host key or a non-JSON answer throws; the agent's own refusals come back as
 * {ok: false, error}.
 */
export function agentCall(t, op, args = [], { stdinFile = null, env = process.env, ssh = "ssh" } = {}) {
  const cred = credentials(t, env);
  let argv;
  try { argv = sshArgv(t, cred, op, args); } catch (e) { cred.cleanup(); throw e; }
  return new Promise((resolve, reject) => {
    // a minimal environment: nothing of the caller's (tokens, keys) reaches ssh but PATH and HOME
    const child = spawn(ssh, argv, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: env.PATH ?? process.env.PATH, HOME: env.HOME ?? os.homedir() } });
    let out = "", err = "", settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); cred.cleanup(); fn(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(reject, new Error(`target ${t.name}: ssh ${op} timed out`)); }, t.timeoutMs ?? 600000);
    child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 8192) err += d; });
    child.on("error", (e) => done(reject, new Error(`target ${t.name}: cannot run ssh (${e.message})`)));
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() || "";
      let answer = null; try { answer = JSON.parse(line); } catch {}
      if (answer && typeof answer === "object" && typeof answer.ok === "boolean") return done(resolve, answer);
      // no agent answer: the transport (host key, auth, connection) or the agent itself failed before answering
      done(reject, new Error(`target ${t.name}: ssh ${op} failed (exit ${code}): ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300) || "no answer from the agent"}`));
    });
    if (stdinFile) { const s = fs.createReadStream(stdinFile); s.on("error", (e) => child.kill() && done(reject, e)); s.pipe(child.stdin); child.stdin.on("error", () => {}); }
    else child.stdin.end();
  });
}
