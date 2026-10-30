// The host side of an "ssh" target (work/site-automation-interface.txt §2, work/site-delivery-hardening-interface.txt):
// the same tool, bound to ONE local root the host operator defines in its own agent.json (root, activate.reload,
// activate.probe, keepHours, maxCarBytes). The caller picks the operation and the release, never a path or a command.
//
// Recommended authorized_keys entry (least privilege; the key can do nothing else):
//   restrict,command="/usr/bin/node /opt/site-release/scripts/site-release/cli.mjs agent --config /etc/site-release/agent.json" ssh-ed25519 AAAA…
// With a forced command, OpenSSH passes the client's line in SSH_ORIGINAL_COMMAND; only the tokens after the marker
// are read, against a fixed grammar. Every answer is one JSON line on stdout, with the agent's own peak RSS.
//
// Operations (every change is fenced and journalled by root-state.mjs):
//   receive <CID> <release.json sha256>      stdin = the CAR, streamed to disk under maxCarBytes
//   activate <CID> <opId> <expectGeneration> <rootId>   compare-and-swap; a replayed opId returns its recorded result
//   undo <opId> <attempt 1..9> <rootId>                  only while that activation is still the root's latest change
//   cancel <opId|undo-opId-N> <rootId>                    its result if it ran, else a durable tombstone: it never runs
//   result <opId|undo-opId-N> <rootId>                    the recorded outcome (reporting; settlement uses cancel)
//   status                                               {rootId, generation, current, pending}
// Every operation but status/receive names the root's id: a different root (even under the same target name) refuses.
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { validateTarget, receiveCar, incomingDir } from "./targets.mjs";
import { rootStatus, rootActivate, rootUndo, rootCancel, rootResult, LockedError, WrongRootError } from "./root-state.mjs";
import { MARKER } from "./ssh.mjs";

const CID = /^b[a-z2-7]{58}$/, SHA = /^[0-9a-f]{64}$/, OPID = /^[0-9a-f]{32}$/, GEN = /^(0|[1-9][0-9]{0,15})$/, ROOTID = /^[0-9a-f]{32}$/;
const ANYOP = /^([0-9a-f]{32}|undo-[0-9a-f]{32}-[1-9])$/;
export const DEFAULT_MAX_CAR = 128 * 1024 * 1024;

export function agentOperation(tokens) {
  const at = tokens.lastIndexOf(MARKER);
  if (at < 0) throw new Error(`no ${MARKER} operation`);
  const [op, ...args] = tokens.slice(at + 1);
  const ok = (op === "receive" && args.length === 2 && CID.test(args[0]) && SHA.test(args[1]))
    || (op === "activate" && args.length === 4 && CID.test(args[0]) && OPID.test(args[1]) && GEN.test(args[2]) && ROOTID.test(args[3]))
    || (op === "undo" && args.length === 3 && OPID.test(args[0]) && /^[1-9]$/.test(args[1]) && ROOTID.test(args[2]))
    || ((op === "cancel" || op === "result") && args.length === 2 && ANYOP.test(args[0]) && ROOTID.test(args[1]))
    || (op === "status" && args.length === 0);
  if (!ok) throw new Error("unsupported agent operation");
  return { op, args };
}

// agent.json and the root belong to the host: owned by the agent's own user and writable by nobody else
function hostOwned(p, what) {
  const st = fs.statSync(p);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${what} ${p} is not owned by the agent's user`);
  if (st.mode & 0o022) throw new Error(`${what} ${p} is writable by group or others`);
}

async function streamToFile(stdin, file, max) {
  let n = 0;
  const limit = new Transform({ transform(chunk, _e, cb) { n += chunk.length; if (n > max) cb(new Error(`the CAR is larger than this host accepts (maxCarBytes ${max})`)); else cb(null, chunk); } });
  await pipeline(stdin, limit, fs.createWriteStream(file, { flags: "wx", mode: 0o600 }));
  return n;
}

/** -> the answer object (printed by the CLI as one JSON line). */
export async function runAgent({ configFile, argv = [], env = process.env, stdin = process.stdin }) {
  const rss = () => Math.round(process.resourceUsage().maxRSS / 1024);
  let target;
  try {
    hostOwned(configFile, "agent config");
    target = validateTarget(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (target.kind !== "local-root") throw new Error("an agent serves exactly one local-root target");
    hostOwned(target.root, "release root");
  } catch (e) { return { ok: false, definite: true, error: `agent config: ${e.message}`, maxRssMiB: rss() }; }
  // `definite`: the operation did not run at all (bad grammar, the root's lock held). Any other failure may have
  // happened mid-change, so it is reported without that claim and the orchestrator asks for the recorded result.
  let parsed;
  try { parsed = agentOperation(env.SSH_ORIGINAL_COMMAND ? env.SSH_ORIGINAL_COMMAND.trim().split(/ +/) : argv); }
  catch (e) { return { ok: false, definite: true, error: e.message, maxRssMiB: rss() }; }
  if (!target.activate && !["status", "receive"].includes(parsed.op))
    return { ok: false, definite: true, error: "this host's agent.json has no `activate` block", maxRssMiB: rss() };
  try {
    const { op, args } = parsed;
    let r;
    if (op === "status") r = await rootStatus(target);
    else if (op === "receive") {
      const incoming = incomingDir(target.root, args[0]);
      fs.mkdirSync(incoming, { mode: 0o700 });
      try {
        const carFile = path.join(incoming, "upload.car");
        const bytes = await streamToFile(stdin, carFile, target.maxCarBytes ?? DEFAULT_MAX_CAR);
        r = { ...(await receiveCar(target, { incoming, carFile }, { cid: args[0], releaseSha256: args[1] })), bytes };
      } finally { fs.rmSync(incoming, { recursive: true, force: true }); }
    } else if (op === "activate") r = await rootActivate(target, { cid: args[0], opId: args[1], expectGeneration: Number(args[2]), rootId: args[3] });
    else if (op === "undo") r = await rootUndo(target, { opId: args[0], attempt: Number(args[1]), rootId: args[2] });
    else if (op === "cancel") r = await rootCancel(target, { opId: args[0], rootId: args[1] });
    else r = await rootResult(target, { opId: args[0], rootId: args[1] });
    return { ok: true, ...r, maxRssMiB: rss() };
  } catch (e) {
    // definite: the operation did not run (the lock was held, or this is another root)
    return { ok: false, definite: e instanceof LockedError || e instanceof WrongRootError, ...(e instanceof WrongRootError ? { code: "wrong-root" } : {}),
      error: String(e.message).slice(0, 400), maxRssMiB: rss() };
  }
}
