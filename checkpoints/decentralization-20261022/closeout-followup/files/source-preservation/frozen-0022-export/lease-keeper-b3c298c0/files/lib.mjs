// One bounded keeper CYCLE for metal0's two protected app leases, while metal0's control is not adopting them (root incident
// 2026-10-23 23:43Z). Pure decision + journal logic; every outside effect (chain reads, guestd, public availability, the
// renewal itself) is an injected dependency, so tests run THIS code with fakes. Production deps (deps.mjs) are root's
// renew-protected-2331.mjs logic, unchanged.
//
// Per cycle, refusing (never renewing) on anything unexpected:
//   - keeper.json (written once by --init) must carry exactly these pins; STOP file -> done; past the 4 h TTL -> done;
//   - ANY renewal intent without its result = an ambiguous earlier attempt -> STOP (exit 3), root reconciles; never re-signs;
//   - per app: verified active lease held by metal0's runner + operator; guestd (authenticated) shows the ORIGINAL guest running
//     under this deployment's name; else REFUSE (exit 4);
//   - if metal0's control has ADOPTED the original guest (public /availability: exactly one live row, the original guest,
//     running, owned): the keeper renews nothing (one signer per lease); a later lease extension it did not make, read by the
//     quorum-verified authority, is the control's NORMAL renewal -> recorded; both apps recorded -> done;
//   - otherwise renew only if the reserve's own policy says Ready (the client's renew window) and fewer than 8 keeper renewals
//     exist for the app; the signed lease is checked (renew, this id, <= the existing per-op ceiling) and made durable (0600,
//     O_EXCL, fsync) BEFORE the client sends it to any relay; the verified receipt becomes the result.
import fs from "node:fs";
import path from "node:path";

export const PINS = Object.freeze({
  apps: Object.freeze({ "0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9": "gd9d4a391d",     // image-generator
                        "0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c": "gdd0646f2c" }),  // EyesOff
  runner: "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be",
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",
  maxChargeWei: "31092172031561",      // the existing per-op ceiling (renew-protected-2331.mjs)
  ttlSec: 4 * 3600, maxRenewalsPerApp: 8,
});
export const EXIT = Object.freeze({ CONTINUE: 0, RECONCILE: 3, REFUSED: 4, TRANSIENT: 5, BUSY: 6, DONE: 10 });
const lc = (x) => String(x ?? "").toLowerCase();
const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2) + "\n";

export function writeOnce(file, obj) {          // durable, never overwritten: 0600, O_EXCL, fsync file + directory
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeSync(fd, json(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const d = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const appDir = (dir, id) => path.join(dir, id);
const pad = (n) => String(n).padStart(3, "0");
export function attempts(dir, id) {             // [{n, intent, result}] for this app
  const d = appDir(dir, id); if (!fs.existsSync(d)) return [];
  const ns = [...new Set(fs.readdirSync(d).map((f) => /^(\d{3})\.(intent|result)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])))].sort((a, b) => a - b);
  return ns.map((n) => ({ n, intent: fs.existsSync(path.join(d, `${pad(n)}.intent.json`)), result: fs.existsSync(path.join(d, `${pad(n)}.result.json`)) }));
}

export function init(dir, now) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOnce(path.join(dir, "keeper.json"), { v: 1, startedAt: now, ...PINS });
}
function pinsOk(k) {
  return k && k.v === 1 && Number.isInteger(k.startedAt) && JSON.stringify({ ...k, v: undefined, startedAt: undefined }) === JSON.stringify({ ...PINS, v: undefined, startedAt: undefined });
}

// held rows of /availability -> the control adopted exactly the original guest for this app?
export function adoption(held, id, guest) {
  if (!Array.isArray(held)) return { adopted: false, why: "no instanceSweep.held (control not adopting)" };
  const live = held.filter((r) => lc(r.id) === id && r.status !== "failed");
  if (live.length === 0) return { adopted: false, why: "not held" };
  if (live.length !== 1 || live[0].vm !== guest) return { adopted: false, replaced: true, why: `held ${live.map((r) => r.vm).join(",")} is not exactly ${guest}` };
  return { adopted: live[0].status === "running" && live[0].owned === true, why: `${guest} ${live[0].status} owned=${live[0].owned}` };
}

/** One cycle. deps: lease(id), guest(id, vm), availability(), policy(id, lease), renew(id, onSigned). now(): unix seconds. */
export async function cycle({ dir, deps, now, log = () => {} }) {
  const kf = path.join(dir, "keeper.json");
  if (!fs.existsSync(kf)) return { code: EXIT.REFUSED, why: "not initialized (keeper.json): root runs --init" };
  const k = read(kf);
  if (!pinsOk(k)) return { code: EXIT.REFUSED, why: "keeper.json pins are not this keeper's" };
  if (fs.existsSync(path.join(dir, "STOP"))) return { code: EXIT.DONE, why: "root STOP" };
  if (now() >= k.startedAt + PINS.ttlSec) return { code: EXIT.DONE, why: "4 h TTL reached: leases are root's again" };
  for (const id of Object.keys(PINS.apps))
    for (const a of attempts(dir, id)) if (a.intent && !a.result) return { code: EXIT.RECONCILE, why: `${id.slice(0, 10)} attempt ${a.n}: signed intent without a verified result - reconcile, never re-sign` };

  let held = null;
  try { held = await deps.availability(); } catch (e) { log(`availability unreadable: ${String(e.message).slice(0, 120)}`); }
  let transient = false; const out = { code: EXIT.CONTINUE, apps: {} };
  for (const [id, guest] of Object.entries(PINS.apps)) {
    const d = appDir(dir, id); fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = out.apps[id] = {};
    let lease;
    try { lease = await deps.lease(id); } catch (e) { transient = true; st.why = `lease unreadable: ${String(e.message).slice(0, 120)}`; continue; }
    if (lease.active !== true || lc(lease.runner) !== PINS.runner || lc(lease.runnerOperator) !== PINS.operator)
      return { code: EXIT.REFUSED, why: `${id.slice(0, 10)}: not metal0's active lease (runner/operator/active)` };
    st.leaseUntil = Number(lease.leaseUntil);
    let g;
    try { g = await deps.guest(id, guest); } catch (e) { transient = true; st.why = `guestd unreadable: ${String(e.message).slice(0, 120)}`; continue; }
    if (g.status !== "running" || g.name !== id || g.vm !== guest) return { code: EXIT.REFUSED, why: `${id.slice(0, 10)}: guestd does not show the original ${guest} running under this deployment` };
    const ad = adoption(held, id, guest);
    if (ad.replaced) return { code: EXIT.REFUSED, why: `${id.slice(0, 10)}: ${ad.why}` };
    const results = attempts(dir, id).filter((a) => a.result).length;
    if (ad.adopted) {
      const af = path.join(d, "adopted.json");
      if (!fs.existsSync(af)) writeOnce(af, { at: now(), leaseUntil: st.leaseUntil, keeperResults: results });
      const base = read(af);
      const nf = path.join(d, "normal.json");
      if (!fs.existsSync(nf) && results === base.keeperResults && st.leaseUntil > base.leaseUntil)
        writeOnce(nf, { at: now(), leaseUntilBefore: base.leaseUntil, leaseUntilAfter: st.leaseUntil, by: "the adopted control (not this keeper)" });
      st.adopted = true; st.normal = fs.existsSync(nf); st.why = "control adopted the original guest: keeper does not renew";
      continue;
    }
    if (results >= PINS.maxRenewalsPerApp) { st.why = `keeper renewal cap ${PINS.maxRenewalsPerApp} reached`; continue; }
    let pol;
    try { pol = await deps.policy(id, lease); } catch (e) { transient = true; st.why = `policy unreadable: ${String(e.message).slice(0, 120)}`; continue; }
    if (pol.status !== "Ready") { st.why = `policy ${pol.status}`; continue; }
    const n = (attempts(dir, id).at(-1)?.n || 0) + 1, intentFile = path.join(d, `${pad(n)}.intent.json`);
    const onSigned = async (r) => {      // the client calls this BEFORE any relay sees the signed lease
      if (r.kind !== "renew" || lc(r.lease?.id) !== id || BigInt(r.lease.maxChargeWei) > BigInt(PINS.maxChargeWei)) throw new Error("intent exceeds this keeper's scope (kind/id/ceiling)");
      writeOnce(intentFile, r);
    };
    try {
      const r = await deps.renew(id, onSigned);
      let after = null; try { after = Number((await deps.lease(id)).leaseUntil); } catch {}
      writeOnce(path.join(d, `${pad(n)}.result.json`), { at: now(), id, guest, hash: r.hash, chargedWei: r.chargedWei, receiptVerified: true, operatorEthSpent: false, leaseUntilBefore: st.leaseUntil, leaseUntilAfter: after });
      st.renewed = r.hash; if (after) st.leaseUntil = after;
    } catch (e) {
      if (fs.existsSync(intentFile)) return { code: EXIT.RECONCILE, why: `${id.slice(0, 10)} attempt ${n}: signed, outcome unknown (${String(e.code || "error")}) - reconcile, never re-sign` };
      transient = true; st.why = `renew refused before signing: ${String(e.code || e.message).slice(0, 120)}`;
    }
  }
  const exp = Object.values(out.apps).map((a) => a.leaseUntil).filter(Number.isFinite);
  fs.writeFileSync(path.join(dir, "last.json"), json({ at: now(), minLeaseUntil: exp.length ? Math.min(...exp) : null, apps: out.apps }), { mode: 0o600 });
  if (Object.keys(PINS.apps).every((id) => fs.existsSync(path.join(appDir(dir, id), "normal.json")))) return { ...out, code: EXIT.DONE, why: "control adopted both original guests and renewed both normally" };
  return { ...out, code: transient ? EXIT.TRANSIENT : EXIT.CONTINUE };
}

/** Per-cycle lock: O_EXCL with this pid; a lock whose pid is gone is stale (the journal, not the lock, guards ambiguity). */
export function lock(dir, pid = process.pid, alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } }) {
  const f = path.join(dir, "cycle.lock");
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(f, "wx", 0o600); fs.writeSync(fd, String(pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(f); } catch {} }; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const other = Number(fs.readFileSync(f, "utf8")) || 0;
      if (other && alive(other)) return null;
      fs.unlinkSync(f);
    }
  }
  return null;
}
