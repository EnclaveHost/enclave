// cli/independent-signer.mjs: durable intent writes, the cross-process signing reservation, and recovery after real
// crashes. Crashes are SIGKILLs of a separate process (helpers/signer-child.mjs) at exact points: before any wallet
// request, during the wallet's answer, after the signed bytes are journaled, after publication, between an intent's tmp
// write and its rename, and between an intent's decision and its reservation's release. The chain is a real anvil read
// through QuorumChain; wallets are fixtures in front of it or of a published dev key (127.0.0.1 only).
//   run: node --test --test-concurrency=1 test/cli-independent-signer-durability.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp } from "viem";
import { foundry } from "viem/chains";
import { QuorumChain } from "../cli/independent.mjs";
import { createExternalSigner, intentJournal, resolveIntent, rebroadcast, abandonIntent, confirmIntent, signerCommand } from "../cli/independent-signer.mjs";
import { A0, SINK, WAIT, HANG, tools, anvil, call, walletServer, forward, keyWallet, gatedChain, until, child, tmpRoot, cleanup } from "./helpers/signer-harness.mjs";

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = pathToFileURL(path.join(TREE, "cli/independent-signer.mjs")).href;
const T = tools ? { skip: tools } : { timeout: 120000 };
const POSIX = process.platform !== "win32";

let chainRpc, pc, chain, tmp, n = 0;
const jdir = () => path.join(tmp, `journal-${++n}`);
const nonceOf = () => pc.getTransactionCount({ address: A0.address });
before(async () => {
  if (tools) return;
  ({ url: chainRpc, c: pc } = await anvil());
  await pc.request({ method: "anvil_setCode", params: [SINK, "0x00"] });
  const c = () => createPublicClient({ chain: foundry, transport: viemHttp(chainRpc) });
  chain = new QuorumChain({ clients: [{ origin: chainRpc + "/a", client: c() }, { origin: chainRpc + "/b", client: c() }], quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
  tmp = tmpRoot("signer-durability-");
});
after(() => cleanup(tmp));

const signer = (url, o = {}) => createExternalSigner({ url, from: A0.address, chainId: 31337, approvalTimeoutMs: 5000, probeTimeoutMs: 2000, ...o });
/** A broadcast-only wallet in front of the chain node (anvil's unlocked dev account): onSend(msg) decides each eth_sendTransaction. */
const sendOnly = (onSend = (m) => forward(chainRpc)(m)) => walletServer((m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } }
  : m.method === "eth_sendTransaction" ? onSend(m) : forward(chainRpc)(m));
const kid = (cfg) => child({ tree: TREE, chainRpc, from: A0.address, to: SINK, data: "0x5a", ...cfg });
async function crashed(k) { const x = await k.exited; assert.equal(x.signal, "SIGKILL", `the child was killed (exit ${JSON.stringify(x)}; ${k.stderr().slice(0, 300)})`); }
const text = async (sub, rest, journal) => { const lines = []; await signerCommand(sub, rest, { chain, journal, say: (l) => lines.push(l), jout: (o) => lines.push(o), json: false, waitOpts: WAIT }); return lines.join("\n"); };
const files = (dir) => fs.readdirSync(dir).sort();

// ---- durable writes -------------------------------------------------------------------------------------------------

/** Every fs call made while fn runs, with the path behind each descriptor. */
function spyFs(fn) {
  const names = ["openSync", "writeSync", "fsyncSync", "closeSync", "renameSync"], orig = Object.fromEntries(names.map((k) => [k, fs[k]]));
  const fds = new Map(), ev = [];
  fs.openSync = (p, flags, mode) => { const fd = orig.openSync(p, flags, mode); fds.set(fd, String(p)); ev.push({ op: "open", p: String(p), flags, mode }); return fd; };
  fs.writeSync = (fd, ...a) => { ev.push({ op: "write", p: fds.get(fd) }); return orig.writeSync(fd, ...a); };
  fs.fsyncSync = (fd) => { ev.push({ op: "fsync", p: fds.get(fd) }); return orig.fsyncSync(fd); };
  fs.closeSync = (fd) => { ev.push({ op: "close", p: fds.get(fd) }); return orig.closeSync(fd); };
  fs.renameSync = (a, b) => { ev.push({ op: "rename", p: String(b), from: String(a) }); return orig.renameSync(a, b); };
  try { fn(); } finally { Object.assign(fs, orig); }
  return ev;
}
const at = (ev, pred, from = 0, what = "event") => { const i = ev.findIndex((e, j) => j >= from && pred(e)); assert.ok(i >= 0, `${what} not found in ${JSON.stringify(ev.slice(from).map((e) => `${e.op} ${path.basename(e.p || "")}`))}`); return i; };
/** tmp opened exclusively 0600 -> written -> flushed -> closed -> renamed onto `file` -> the directory flushed. */
function assertReplaced(ev, file) {
  const r = at(ev, (e) => e.op === "rename" && e.p === file, 0, `rename onto ${path.basename(file)}`), tmpf = ev[r].from;
  const o = at(ev, (e) => e.op === "open" && e.p === tmpf, 0, "tmp open");
  assert.equal(ev[o].flags, "wx"); assert.equal(ev[o].mode, 0o600);
  const w = at(ev, (e) => e.op === "write" && e.p === tmpf, o, "tmp write"), s = at(ev, (e) => e.op === "fsync" && e.p === tmpf, w, "tmp fsync"), c = at(ev, (e) => e.op === "close" && e.p === tmpf, s, "tmp close");
  assert.ok(c < r, "flushed and closed before the rename");
  const d = at(ev, (e) => e.op === "open" && e.p === path.dirname(file), r, "directory open after the rename");
  at(ev, (e) => e.op === "fsync" && e.p === path.dirname(file), d, "directory fsync after the rename");
}
/** created exclusively 0600 -> written -> flushed -> closed -> the directory flushed. */
function assertCreated(ev, file) {
  const o = at(ev, (e) => e.op === "open" && e.p === file, 0, `create ${path.basename(file)}`);
  assert.equal(ev[o].flags, "wx"); assert.equal(ev[o].mode, 0o600);
  const s = at(ev, (e) => e.op === "fsync" && e.p === file, o, "fsync"), c = at(ev, (e) => e.op === "close" && e.p === file, s, "close");
  at(ev, (e) => e.op === "fsync" && e.p === path.dirname(file), c, "directory fsync after the create");
}

test("durable writes: intents are flushed before they are renamed into place and the directory after; reservations are created exclusively and flushed", { skip: !POSIX && "POSIX order" }, () => {
  const dir = jdir(), j = intentJournal(dir);
  let rec, slot;
  const ev = spyFs(() => {
    slot = j.reserve(A0.address, 31337);
    rec = j.create({ from: A0.address, chainId: 31337, nonce: 0, state: "handoff", slot: slot.key });
    j.update(rec.id, { state: "abandoned" });   // decided: releases the reservation
  });
  const f = path.join(dir, `${rec.id}.json`), slotf = path.join(dir, `slot-31337-${A0.address.toLowerCase()}.00000001.slot`);
  assertCreated(ev, slotf);
  assertReplaced(ev, f);
  assertReplaced(ev.slice(ev.findIndex((e) => e.op === "rename" && e.p === f) + 1), f);   // the update, too
  assertCreated(ev, slotf.replace(/\.slot$/, ".released"));
  assert.ok(ev.findIndex((e) => e.op === "open" && e.p.endsWith(".released")) > ev.findLastIndex((e) => e.op === "rename" && e.p === f), "released only after the decision is on disk");
  assert.deepEqual(files(dir).filter((x) => x.endsWith(".tmp")), [], "no tmp file left");
});

test("a filesystem that refuses directory fsync (EINVAL) still works; any other flush error fails the write before it is reported", { skip: !POSIX && "POSIX" }, () => {
  const dir = jdir(), j = intentJournal(dir), orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  const dirFds = new Set();
  const fail = (code) => {
    fs.openSync = (p, ...a) => { const fd = orig.openSync(p, ...a); if (String(p) === dir) dirFds.add(fd); else dirFds.delete(fd); return fd; };
    fs.fsyncSync = (fd) => { if (dirFds.has(fd)) throw Object.assign(new Error(code), { code }); return orig.fsyncSync(fd); };
  };
  fs.mkdirSync(dir, { recursive: true });
  try {
    fail("EINVAL");
    const r = j.create({ from: A0.address, chainId: 31337, nonce: 0, state: "handoff" });
    assert.equal(j.get(r.id).state, "handoff");
    fail("EIO");
    assert.throws(() => j.create({ from: A0.address, chainId: 31337, nonce: 1, state: "handoff" }), /EIO/);
  } finally { Object.assign(fs, orig); }
});

test("durable writes, Windows branch (process.platform win32 in a child): the renamed file is flushed again; no directory handle is opened", () => {
  const dir = jdir();
  const script = `Object.defineProperty(process, "platform", { value: "win32" });
    const fs = (await import("node:fs")).default; const ev = [], fds = new Map(), o = { ...fs };
    fs.openSync = (p, f, m) => { const fd = o.openSync(p, f, m); fds.set(fd, String(p)); ev.push(["open", String(p), f]); return fd; };
    fs.fsyncSync = (fd) => { ev.push(["fsync", fds.get(fd)]); return o.fsyncSync(fd); };
    fs.renameSync = (a, b) => { ev.push(["rename", String(b)]); return o.renameSync(a, b); };
    const S = await import(${JSON.stringify(MOD)}); const j = S.intentJournal(${JSON.stringify(dir)});
    const r = j.create({ from: "${A0.address}", chainId: 31337, nonce: 0, state: "handoff" });
    console.log(JSON.stringify({ ev, id: r.id }));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: TREE, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const { ev, id } = JSON.parse(out.stdout.trim().split("\n").at(-1));
  const f = path.join(dir, `${id}.json`), r = ev.findIndex((e) => e[0] === "rename" && e[1] === f);
  assert.ok(r > 0 && ev.slice(0, r).some((e) => e[0] === "fsync" && e[1] !== f), "the tmp file is flushed before the rename");
  assert.deepEqual(ev.slice(r + 1, r + 3), [["open", f, "r+"], ["fsync", f]]);
  assert.ok(!ev.some((e) => e[0] === "open" && e[1] === dir), "no directory handle (Node cannot flush one on Windows)");
});

test("private files: the journal directory is tightened to 0700, every intent and reservation file is 0600, signed bytes never printed", { ...T, skip: T.skip || (!POSIX && "POSIX modes") }, async () => {
  const dir = jdir();
  fs.mkdirSync(dir, { mode: 0o755 }); fs.chmodSync(dir, 0o755);
  const w = await walletServer(keyWallet());
  const s = signer(w.url, { mode: "sign", journalDir: dir });
  const r = await s.sendQuorumTx(chain, { to: SINK, data: "0x01", ...WAIT });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const f of files(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  assert.deepEqual(files(dir).filter((f) => !f.endsWith(".json")).map((f) => f.replace(/0x[0-9a-f]{40}/, "A")), ["slot-31337-A.00000001.released", "slot-31337-A.00000001.slot"]);
  const raw = s.journal.get(r.intent).raw;
  assert.match(raw, /^0x02/);
  const shown = (await text("list", [], s.journal)) + (await text("show", [r.intent], s.journal));
  assert.ok(!shown.includes(raw.slice(2, 40)), "list and show never print the signed bytes");
  for (const f of files(dir).filter((x) => !x.endsWith(".json"))) assert.ok(!fs.readFileSync(path.join(dir, f), "utf8").includes(raw.slice(2, 40)));
});

// ---- reservations ---------------------------------------------------------------------------------------------------

test("reservation lifecycle: held while the intent is open, released when it is decided by any command; generations are never reused", T, async () => {
  const dir = jdir(), handed = [];
  const h = createExternalSigner({ from: A0.address, chainId: 31337, mode: "handoff", journalDir: dir, onHandoff: (rec, params) => { handed.push({ rec, params }); return { handoff: rec.id }; } });
  await h.sendQuorumTx(chain, { to: SINK, data: "0x3a", ...WAIT });
  const key = `31337-${A0.address.toLowerCase()}/00000001`;
  assert.deepEqual(h.journal.reservations().map((x) => [x.key, x.intent]), [[key, handed[0].rec.id]]);
  const e = await h.sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, handed[0].rec.id);
  assert.throws(() => h.journal.releaseReservation(key), /holds .*abandon it instead/);
  abandonIntent(h.journal, handed[0].rec.id);
  assert.deepEqual(h.journal.reservations(), []);
  assert.throws(() => h.journal.releaseReservation(key), /already released/);
  await h.sendQuorumTx(chain, { to: SINK, data: "0x3b", ...WAIT });
  assert.equal(h.journal.get(handed[1].rec.id).slot, key.replace(/1$/, "2"), "the next send takes the NEXT generation");
  // a late or repeated release of generation 1 cannot touch generation 2
  assert.equal(h.journal.update(handed[0].rec.id, { note: "late write" }).state, "abandoned");
  assert.equal(h.journal.reservations()[0].key, key.replace(/1$/, "2"));
  // a sign-only refusal (nothing recorded) releases at once
  const deny = await walletServer((m) => m.method === "eth_signTransaction" ? { error: { code: 4001, message: "User rejected" } } : keyWallet()(m));
  const d = signer(deny.url, { journalDir: jdir() });
  assert.equal((await d.sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x)).code, "rejected");
  assert.deepEqual(d.journal.reservations(), []);
  // a stray release marker for a generation that does not exist is refused, never trusted
  const stray = intentJournal(jdir());
  fs.mkdirSync(stray.dir, { recursive: true });
  fs.writeFileSync(path.join(stray.dir, `slot-31337-${A0.address.toLowerCase()}.00000001.released`), "{}\n", { mode: 0o600 });
  assert.throws(() => stray.reserve(A0.address, 31337), /release marker for reservation .*00000001 but no such reservation/);
  assert.match(stray.reservations()[0].error, /no such reservation/);
});

test("a hand release racing a LIVE holder: the holder records its intent, sees the release, and stops; the wallet is asked once", T, async () => {
  const w = await sendOnly();
  const dir = jdir(), before = await nonceOf();
  let go, arrived = false;
  const gate = new Promise((r) => (go = r));
  const holder = signer(w.url, { mode: "wallet-send", journalDir: dir });
  const run = holder.sendQuorumTx(gatedChain(chain, async () => { arrived = true; await gate; }), { to: SINK, data: "0xa1", ...WAIT }).catch((x) => x);
  await until(() => arrived);
  const [held] = holder.journal.reservations();
  assert.equal(held.intent, null); assert.equal(held.pid, process.pid);
  holder.journal.releaseReservation(held.key);                         // the user's mistake: the holder is alive
  const other = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, data: "0xa2", ...WAIT });
  assert.equal(other.status, "success");
  go();
  const e = await run;
  assert.equal(e.code, "busy"); assert.match(e.message, /released by hand/);
  assert.equal(w.count("eth_sendTransaction"), 1, "only the later send asked the wallet");
  const stopped = holder.journal.list().find((r) => r.slot === held.key);
  assert.equal(stopped.state, "abandoned"); assert.match(stopped.note, /nothing of this intent was sent/);
  assert.equal(await nonceOf(), before + 1);
});

const marker = (dir, key) => path.join(dir, `slot-${key.replace("/", ".")}.released`);

test("hand release vs a holder in ANOTHER process paused before its nonce read: the holder records its intent, sees the release, stops", T, async () => {
  const w = await sendOnly(), dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir, gate: true });
  await k.wait("READY"); k.send("START"); await k.wait("ARRIVED");
  const j = intentJournal(dir), [held] = j.reservations();
  assert.equal(held.pid, k.p.pid);
  j.releaseReservation(held.key);
  assert.equal((await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT })).status, "success");
  k.send("GO");
  await k.wait("RESULT", 30000);
  assert.equal(k.result().code, "busy"); assert.match(k.result().message, /released by hand/);
  assert.equal(w.count("eth_sendTransaction"), 1, "only the later send asked the wallet");
  assert.equal(j.list().find((r) => r.slot === held.key).state, "abandoned");
  assert.equal(await nonceOf(), before + 1);
});

test("a release written AFTER a holder in another process recorded its intent (a stale hand release) lets no second send through", T, async () => {
  let asked = false, answer;
  const w = await sendOnly(async (m) => { asked = true; await new Promise((r) => (answer = r)); return forward(chainRpc)(m); });
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir });
  await k.wait("READY"); k.send("START");
  await until(() => asked);                                     // the holder is inside eth_sendTransaction
  const j = intentJournal(dir), [rec] = j.list();
  assert.equal(rec.state, "requested");
  assert.throws(() => j.releaseReservation(rec.slot), /abandon it instead/);
  fs.writeFileSync(marker(dir, rec.slot), "{}\n", { mode: 0o600 });   // what a release that checked BEFORE the intent existed would write
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, rec.id);
  answer();
  await k.wait("RESULT", 30000);
  assert.equal(k.result().ok, true, JSON.stringify(k.result()));
  assert.equal(w.count("eth_sendTransaction"), 1, "the second send never reached the wallet");
  assert.equal(await nonceOf(), before + 1);
});

test("a holder killed between its intent write and its release check, then released anyway: still refused until the intent is settled", T, async () => {
  const w = await sendOnly(), dir = jdir();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir, crashAt: "after-intent" });
  await k.wait("READY"); k.send("START");
  await crashed(k);
  assert.equal(w.count("eth_sendTransaction"), 0);
  const j = intentJournal(dir), [rec] = j.list();
  assert.equal(rec.state, "requested");
  assert.throws(() => j.releaseReservation(rec.slot), /abandon it instead/);
  fs.writeFileSync(marker(dir, rec.slot), "{}\n", { mode: 0o600 });
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, rec.id);
  assert.equal(w.count("eth_sendTransaction"), 0);
  abandonIntent(j, rec.id);
  const r = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(Number((await pc.getTransaction({ hash: r.transactionHash })).nonce), rec.nonce, "the abandoned nonce, used once");
  assert.equal(w.count("eth_sendTransaction"), 1);
});

test("an intent recorded between a send's first check and its reservation (another process, an older CLI) is caught by the recheck", T, async () => {
  const w = await sendOnly(), dir = jdir(), other = intentJournal(dir), orig = fs.openSync;
  let planted = null;
  fs.openSync = (p, ...a) => {   // exactly when this send creates its reservation file, another writer records an open intent
    if (!planted && String(p).endsWith(".00000001.slot")) planted = other.create({ from: A0.address, chainId: 31337, nonce: 0, to: SINK, state: "requested", mode: "wallet-send" });
    return orig(p, ...a);
  };
  let e;
  try { e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x); }
  finally { fs.openSync = orig; }
  assert.ok(planted);
  assert.equal(e.code, "busy"); assert.equal(e.intent, planted.id);
  assert.equal(w.calls.length, 0, "the wallet is not contacted");
  assert.deepEqual(other.reservations(), [], "its own reservation, which recorded nothing, is released");
});

// ---- crashes (SIGKILL of a separate process) ---------------------------------------------------------------------------

async function recoverByRelease(dir, w, pid) {
  const j = intentJournal(dir);
  const [held] = j.reservations();
  assert.equal(held.intent, null); assert.equal(held.pid, pid, "the dead holder is named");
  assert.match(await text("list", [], j), /held with no intent recorded .*signer release/);
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.reservation, held.key); assert.match(e.message, /signer release/);
  assert.match(await text("release", [held.key], j), /released/);
  const before = await nonceOf();
  const r = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(r.status, "success"); assert.equal(await nonceOf(), before + 1);
}

test("crash after the reservation, before any wallet request: nothing was asked; the next send is refused until an explicit release", T, async () => {
  const w = await sendOnly(), dir = jdir();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir, gate: true });
  await k.wait("READY"); k.send("START"); await k.wait("ARRIVED");
  await k.kill(); await crashed(k);
  assert.equal(w.calls.length, 0, "the wallet was never contacted");
  assert.deepEqual(intentJournal(dir).list(), []);
  await recoverByRelease(dir, w, k.p.pid);
});

test("crash between an intent's flushed tmp file and its rename: no intent, and no wallet request was ever made", T, async () => {
  const w = await sendOnly(), dir = jdir();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir, crashAt: "intent-rename" });
  await k.wait("READY"); k.send("START");
  await crashed(k);
  assert.equal(w.count("eth_sendTransaction"), 0, "the request is only made once its intent is on disk");
  const j = intentJournal(dir);
  assert.deepEqual(j.list(), []); assert.deepEqual(j.problems(), [], "a leftover tmp file is not an intent");
  const left = files(dir).filter((f) => f.endsWith(".tmp"));
  assert.equal(left.length, 1);
  if (POSIX) assert.equal(fs.statSync(path.join(dir, left[0])).mode & 0o777, 0o600);
  await recoverByRelease(dir, w, k.p.pid);
});

test("crash during eth_sendTransaction after the wallet broadcast: the intent is on disk; busy, release refused, resolve confirms and releases", T, async () => {
  let asked = false;
  const w = await sendOnly(async (m) => { await forward(chainRpc)(m); asked = true; return HANG; });
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir });
  await k.wait("READY"); k.send("START");
  await until(() => asked); await k.kill(); await crashed(k);
  const j = intentJournal(dir);
  const [rec] = j.list();
  assert.equal(rec.state, "requested"); assert.equal(rec.hash, null); assert.equal(rec.nonce, before);
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, rec.id);
  assert.throws(() => j.releaseReservation(rec.slot), /abandon it instead/);
  assert.equal((await resolveIntent(chain, j, rec.id)).state, "confirmed");
  assert.deepEqual(j.reservations(), [], "decided by resolve: released");
  const ok = await sendOnly();
  const r = await signer(ok.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(r.status, "success"); assert.equal(await nonceOf(), before + 2);
});

test("crash during eth_sendTransaction that the wallet never broadcast: resolve keeps it open; abandon releases; the nonce is reused once", T, async () => {
  let asked = false;
  const w = await sendOnly(() => { asked = true; return HANG; });
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "wallet-send", journalDir: dir });
  await k.wait("READY"); k.send("START");
  await until(() => asked); await k.kill(); await crashed(k);
  const j = intentJournal(dir), [rec] = j.list();
  const r = await resolveIntent(chain, j, rec.id);
  assert.equal(r.state, "requested"); assert.ok(r.open);
  assert.match(await text("abandon", [rec.id], j), /at most one/);
  assert.deepEqual(j.reservations(), []);
  const ok = await sendOnly();
  const r2 = await signer(ok.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(Number((await pc.getTransaction({ hash: r2.transactionHash })).nonce), before);
});

test("crash during the signature request: nothing was journaled or broadcast; explicit release, then the next send", T, async () => {
  let asked = false;
  const w = await walletServer(async (m) => { if (m.method !== "eth_signTransaction") return keyWallet()(m); asked = true; return HANG; });
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "sign", journalDir: dir });
  await k.wait("READY"); k.send("START");
  await until(() => asked); await k.kill(); await crashed(k);
  assert.deepEqual(intentJournal(dir).list(), []);
  assert.equal(await nonceOf(), before);
  const ok = await sendOnly();
  await recoverByRelease(dir, ok, k.p.pid);
});

test("crash after the signed bytes are journaled, before publication: resolve keeps it open; rebroadcast sends the same bytes; one signature", T, async () => {
  const w = await walletServer(keyWallet());
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "sign", journalDir: dir, publish: "hang-before" });
  await k.wait("READY"); k.send("START"); await k.wait("BROADCASTING");
  await k.kill(); await crashed(k);
  const j = intentJournal(dir), [rec] = j.list();
  assert.equal(rec.state, "signed"); assert.match(rec.raw, /^0x02/);
  if (POSIX) assert.equal(fs.statSync(path.join(dir, `${rec.id}.json`)).mode & 0o777, 0o600);
  assert.equal(await nonceOf(), before, "nothing published");
  const e = await signer(w.url, { mode: "sign", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, rec.id);
  assert.ok((await resolveIntent(chain, j, rec.id)).open);
  const rb = await rebroadcast(chain, j, rec.id, WAIT);
  assert.equal(rb.transactionHash, rec.hash);
  assert.equal(w.count("eth_signTransaction"), 1, "never re-signed");
  assert.deepEqual(j.reservations(), []);
  assert.equal(await nonceOf(), before + 1);
});

test("crash after publication: resolve confirms the journaled hash and releases; the next send takes the next nonce", T, async () => {
  const w = await walletServer(keyWallet());
  const dir = jdir(), before = await nonceOf();
  const k = kid({ url: w.url, mode: "sign", journalDir: dir, publish: "hang-after" });
  await k.wait("READY"); k.send("START"); await k.wait("PUBLISHED");
  await k.kill(); await crashed(k);
  const j = intentJournal(dir), [rec] = j.list();
  assert.equal(rec.state, "signed");
  assert.equal((await resolveIntent(chain, j, rec.id)).state, "confirmed");
  assert.deepEqual(j.reservations(), []);
  const r = await signer(w.url, { mode: "sign", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(Number((await pc.getTransaction({ hash: r.transactionHash })).nonce), before + 1);
});

test("crash after the intent is decided, before its reservation is released: the next send completes the release itself", T, async () => {
  const w = await walletServer(keyWallet());
  const dir = jdir();
  const k = kid({ url: w.url, mode: "sign", journalDir: dir, crashAt: "release-marker" });
  await k.wait("READY"); k.send("START");
  await crashed(k);
  const j = intentJournal(dir), [rec] = j.list();
  assert.equal(rec.state, "confirmed");
  const [held] = j.reservations();
  assert.equal(held.decided, rec.id);
  assert.match(await text("list", [], j), /is decided; the next send completes the release/);
  const r = await signer(w.url, { mode: "sign", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  assert.equal(r.status, "success");
  assert.equal(j.get(r.intent).slot, held.key.replace(/1$/, "2"));
});

// ---- unreadable or unknown journal entries ------------------------------------------------------------------------------

test("an unreadable intent file is never dropped silently: every send is refused (wallet untouched) until it is reviewed and set aside", T, async () => {
  const w = await sendOnly(), dir = jdir();
  const ok = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT });
  const SECRETISH = "0x02f8" + "ab".repeat(60);
  const bad = path.join(dir, "tx-corrupt1-deadbeef.json");
  fs.writeFileSync(bad, `{"format":"enclave-signer-intent/v1","raw":"${SECRETISH}","state":"sig`, { mode: 0o600 });   // torn
  const j = intentJournal(dir);
  assert.deepEqual(j.list().map((r) => r.id), [ok.intent]);
  assert.deepEqual(j.problems().map((p) => p.id), ["tx-corrupt1-deadbeef"]);
  const listed = await text("list", [], j);
  assert.match(listed, /UNREADABLE tx-corrupt1-deadbeef\.json .*quarantine tx-corrupt1-deadbeef/);
  const calls = w.calls.length, slotsBefore = files(dir).filter((f) => f.startsWith("slot-")).length;
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "state"); assert.match(e.message, /cannot be read .*quarantine/);
  assert.equal(w.calls.length, calls, "the wallet is not contacted");
  assert.equal(files(dir).filter((f) => f.startsWith("slot-")).length, slotsBefore, "no reservation is taken");
  const shown = await text("show", ["tx-corrupt1-deadbeef"], j).catch((x) => x.message);
  for (const m of [listed, e.message, shown]) assert.ok(!m.includes("abababab"), "the file's content is never echoed");
  assert.throws(() => j.quarantine(ok.intent), /is readable/);
  const q = await text("quarantine", ["tx-corrupt1-deadbeef"], j);
  assert.match(q, /set aside/);
  const kept = files(dir).find((f) => f.startsWith("tx-corrupt1-deadbeef.json.quarantined-"));
  assert.ok(kept, "kept for review, not deleted");
  if (POSIX) assert.equal(fs.statSync(path.join(dir, kept)).mode & 0o777, 0o600);
  assert.equal((await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT })).status, "success");
});

test("an intent in a state this version does not know blocks sends like an unresolved one, and can be abandoned explicitly", T, async () => {
  const w = await sendOnly(), dir = jdir(), j = intentJournal(dir);
  const odd = j.create({ from: A0.address, chainId: 31337, nonce: 0, to: SINK, state: "a-future-state", mode: "sign" });
  const e = await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT }).catch((x) => x);
  assert.equal(e.code, "busy"); assert.equal(e.intent, odd.id);
  abandonIntent(j, odd.id);
  assert.equal((await signer(w.url, { mode: "wallet-send", journalDir: dir }).sendQuorumTx(chain, { to: SINK, ...WAIT })).status, "success");
});

// ---- decisions made by another command -----------------------------------------------------------------------------------

test("a decided intent never reopens, and a send waiting on it stops when another command decides it", T, async () => {
  const ghost = await sendOnly(() => ({ result: "0x" + "77".repeat(32) }));   // a hash that never appears
  const dir = jdir(), s = signer(ghost.url, { mode: "wallet-send", journalDir: dir });
  const run = s.sendQuorumTx(chain, { to: SINK, ...WAIT, timeoutMs: 60000 }).catch((x) => x);
  await until(() => s.journal.list()[0]?.state === "submitted");
  const t0 = Date.now();
  abandonIntent(intentJournal(dir), s.journal.list()[0].id);          // "another command"
  const e = await run;
  assert.equal(e.code, "state"); assert.match(e.message, /abandoned meanwhile/);
  assert.ok(Date.now() - t0 < 10000, "not left waiting for the timeout");
  const id = s.journal.list()[0].id;
  assert.equal(s.journal.update(id, { state: "submitted", hash: "0x" + "88".repeat(32) }).state, "abandoned");
  // confirmed by another command while this one waited: the receipt, not undefined
  const real = await call(chainRpc, "eth_sendTransaction", [{ from: A0.address, to: SINK, data: "0xc0" }]);
  await pc.waitForTransactionReceipt({ hash: real.result });
  const tx = await pc.getTransaction({ hash: real.result });
  const j = intentJournal(jdir());
  const rec = j.create({ from: A0.address, chainId: 31337, to: SINK, data: "0xc0", value: 0n, nonce: Number(tx.nonce), gas: tx.gas, maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas, startBlock: 0n, mode: "wallet-send", state: "submitted", hash: real.result });
  assert.equal((await resolveIntent(chain, j, rec.id)).state, "confirmed");
  const receipt = await confirmIntent(chain, j, rec.id, WAIT);
  assert.equal(receipt.transactionHash, real.result); assert.equal(receipt.status, "success");
});
