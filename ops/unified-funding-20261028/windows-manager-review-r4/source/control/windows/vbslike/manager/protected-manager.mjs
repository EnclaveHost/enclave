/* ============================================================
   The installed Manager with continuing per-app enforcement composed in (permit r1, SOURCE ONLY).

   server.mjs is NOT edited: its Manager and createServer stay byte-identical to the installed seed, so every
   legacy request, record and test keeps its exact semantics. This subclass adds, and only adds:
     - refusal of enforcement-shaped fields and of the protected id namespace (pp + 32 hex) on the LEGACY spawn,
       so a request can neither opt in by asserting a flag nor create a look-alike that escapes enforcement;
     - protected records are never adopted: a recovered pp-id VM is not served (as every recovered record) and is
       removed at startup by PermitEnforcement.recoverAtStartup;
     - DELETE of a protected id is an explicit Stop: access is withdrawn FIRST, compute removal follows, and 200 is
       answered only after a backend survey confirms absence;
     - /health gains permitEnforcement { available, reasons } and supports.permitEnforcement, true only when the
       complete selected path is present (journal owned, authority reader, verified guard, data plane).
   createProtectedServer serves guestd-control/1 (control.mjs, the reviewed server) in front of the installed
   handler. Protected routes exist ONLY behind a verified request MAC and are answered with a response MAC; a
   loopback origin or forwarded header is never authentication. Unauthenticated requests reach the installed
   handler unchanged, except /protected/* (401) and /control/* (the handshake).
   r4: (1) DELETE of a protected id no longer reads the journal BEFORE withdrawing: a journal fault (root
   root-client-route #4, actual MAC/TCP) suppressed the data-plane/boundary/guard withdrawal. The exact withdrawal now
   starts first for any protected id known to the journal, the trusted in-memory mapping, the live domains or a raw
   spawn; the answer stays 500 until absence is confirmed and durably recorded. (2) GET
   /protected/deployments/<bytes32>/instances: the strict authenticated reconciliation route (exact deployment, every
   protected record incl. non-terminal and unknown, manager epoch, completeness), replacing the client's GET /vms.
   ============================================================ */
import http from "node:http";
import { Manager, createServer } from "./server.mjs";
import { PROTECTED_ID } from "./permit-journal.mjs";

const ENFORCEMENT_FIELDS = ["protected", "permit", "permitEnvelope", "attachment", "enforcement", "expiryEnforced", "proofVerified",
  "stagingDeadline", "stagingMs", "serveUntil", "validUntil", "guard", "launchEpoch"];
const MAX_BODY = 256 * 1024;
export const INVENTORY_SCHEMA = "enclave-protected-inventory/1";
const bad = (status, message) => Object.assign(new Error(message), { status });

export class ProtectedManager extends Manager {
  enforcement = null;
  /** The LEGACY spawn: unchanged, except that it can never create or imitate a protected instance. */
  async spawn(body = {}) {
    if (body && typeof body === "object") {
      const f = ENFORCEMENT_FIELDS.find((k) => k in body) || ENFORCEMENT_FIELDS.find((k) => body.derive && typeof body.derive === "object" && k in body.derive);
      if (f) throw bad(400, `request-supplied ${f} never opts in to enforcement; use the authenticated protected route`);
      if (body.id !== undefined && body.id !== null && /^pp/i.test(String(body.id))) throw bad(400, "the pp id namespace is reserved for authenticated protected instances");
    }
    return super.spawn(body);
  }
  /** Only PermitEnforcement calls this, after durable staging + guard registration. */
  spawnProtectedInternal(body) { return super.spawn(body); }
  /** The installed removal (stop, then delete the record), used by enforcement after it withdrew access. */
  removeRecord(id) { return super.remove(id); }
  async remove(id) {
    if (!PROTECTED_ID.test(String(id))) return super.remove(id);
    if (!this.enforcement) {
      // no enforcement composed: a recovered protected VM may still be STOPPED (more restrictive), never adopted
      return super.remove(id);
    }
    const e = this.enforcement;
    // r4: ownership is decided WITHOUT trusting a journal read to succeed; a fault is unknown (never absence)
    let known, journalFault = null;
    try { known = e.journal.instance(id); } catch (x) { journalFault = x.message; known = null; }
    const owned = !!known || !!journalFault || e.known?.has(id) || this.domains.has(id) || e.spawns?.has(id) || e.serving?.has(id);
    if (!owned) return super.remove(id);
    // the exact withdrawal starts first (synchronous part: ingress, boundaries, guard, gate) and is owned by enforcement
    const removal = e.withdraw(id, journalFault ? `explicit Stop (journal unreadable: ${journalFault})` : "explicit Stop");
    try { await removal; }
    catch (x) { const err = new Error(`stop not confirmed; the instance stays listed and fenced: ${x.message}`); err.status = 500; err.id = id; throw err; }
    if (journalFault) { const err = new Error(`stop withdrew access but the journal was unreadable (${journalFault}): removal not durably confirmed`); err.status = 500; err.id = id; throw err; }
    return { removed: true, absent: false };
  }
  publicOf(r) {
    const v = super.publicOf(r);
    if (PROTECTED_ID.test(String(r.id))) v.protected = this.enforcement ? this.enforcement.viewOf(r.id) : { state: "unknown", serving: false, reason: "enforcement not composed" };
    return v;
  }
  /** r4: every protected record of one deployment, live or not; throws (503) when that cannot be complete. */
  protectedInventory(deployment) {
    if (!this.enforcement) throw bad(503, "enforcement not composed");
    if (!this.inventoryReady) throw bad(503, "inventory_unavailable");
    let rows;
    try { rows = this.enforcement.journal.instances().filter((r) => r.deployment === deployment); }
    catch (x) { throw bad(503, `journal unreadable: inventory unknown (${x.message})`); }
    const ids = new Set(rows.map((r) => r.instanceId));
    for (const [id, k] of this.enforcement.known ?? []) if (k.deployment === deployment) ids.add(id);
    const instances = [];
    for (const id of ids) {
      const view = this.enforcement.viewOf(id);
      if (view.state === "unknown" && rows.some((r) => r.instanceId === id)) throw bad(503, "protected record unreadable: inventory unknown");
      const m = this.get(id);
      instances.push({ id, status: m?.status ?? "absent", recovered: m?.recovered === true, protected: { ...view, instanceId: id, deployment } });
    }
    // a protected VM present without any mapping for this deployment cannot be attributed: unknown, not absence
    for (const id of this.domains.keys()) if (PROTECTED_ID.test(id) && !ids.has(id) && !rows.length && this.domains.get(id)?.name === deployment)
      throw bad(503, `unattributed protected VM ${id} for this deployment: inventory unknown`);
    return { schema: INVENTORY_SCHEMA, deployment, complete: true, managerEpoch: this.epoch, instances };
  }
  health() {
    const h = super.health();
    const c = this.enforcement ? this.enforcement.capability() : { available: false, reasons: ["permit enforcement is not configured"] };
    return { ...h, permitEnforcement: c, supports: { ...h.supports, permitEnforcement: c.available === true } };
  }
}

function strictPath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.length > 512 || raw.includes("?") || raw.includes("#") || raw.includes("%"))
    throw bad(404, "unknown route");
  return raw;
}

/**
 * The authenticated route table (inside ControlServer.call, after the request MAC verified).
 * -> async ({method, path, body}) => { status, body }
 */
export function protectedRoutes(manager, enforcement) {
  return async ({ method, path, body }) => {
    let p; try { p = strictPath(path); } catch (e) { return { status: 404, body: { error: e.message } }; }
    let json = null;
    if (body) { try { json = JSON.parse(body); } catch { return { status: 400, body: { error: "body is not JSON" } }; } }
    const answer = async (fn, ok = 200) => {
      try { return { status: ok, body: await fn() }; }
      catch (e) { return { status: e.status || 500, body: { error: e.message, ...(e.id ? { id: e.id } : {}) } }; }
    };
    if (method === "GET" && p === "/health" && !body) return { status: 200, body: manager.health() };
    if (method === "GET" && p === "/vms" && !body) {
      if (!manager.inventoryReady) return { status: 503, body: { error: "inventory_unavailable", managerEpoch: manager.epoch } };
      return { status: 200, body: { vms: manager.list(), managerEpoch: manager.epoch } };
    }
    let d = /^\/protected\/deployments\/(0x[0-9a-f]{64})\/instances$/.exec(p);
    if (d && method === "GET" && !body) return answer(() => manager.protectedInventory(d[1]));
    if (method === "POST" && p === "/protected/vms") {
      if (!manager.inventoryReady) return { status: 503, body: { error: "inventory_unavailable", managerEpoch: manager.epoch } };
      return answer(() => enforcement.stage(json), 202);
    }
    let m = /^\/protected\/vms\/(pp[0-9a-f]{32})\/(permit|hold)$/.exec(p);
    if (m && method === "POST") return m[2] === "permit" ? answer(() => enforcement.permit(m[1], json)) : answer(() => enforcement.hold(m[1], "authenticated controller hold"));
    m = /^\/vms\/([A-Za-z0-9-]{1,64})$/.exec(p);
    if (m && method === "GET" && !body) {
      const r = manager.get(m[1]);
      if (r) return { status: 200, body: r };
      return manager.mayAnswerAbsent(m[1]) ? { status: 404, body: { error: "not_found" } } : { status: 503, body: { error: "unknown", managerEpoch: manager.epoch } };
    }
    if (m && method === "DELETE" && !body) return answer(async () => { const r = await manager.remove(m[1]); if (r.absent) throw bad(404, "not_found"); return { ok: true }; });
    return { status: 404, body: { error: "not_found" } };
  };
}

/** HTTP: /control/* handshake, MAC'd requests to the protected table, everything else to the INSTALLED handler. */
export function createProtectedServer(manager, { control }) {
  const legacy = createServer(manager).listeners("request")[0];
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      const b = Buffer.from(JSON.stringify(body ?? {}));
      res.writeHead(status, { "content-type": "application/json", "content-length": b.length, ...headers }); res.end(b);
    };
    const read = async () => {
      if (req.headers["transfer-encoding"]) throw bad(411, "explicit content-length required");
      const declared = Number(req.headers["content-length"] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY) throw bad(413, "request body too large");
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > MAX_BODY) throw bad(413, "request body too large"); chunks.push(c); }
      if (n !== declared) throw bad(400, "body length differs from content-length");
      return Buffer.concat(chunks);
    };
    try {
      const url = String(req.url || "");
      if (url === "/control/hello" && req.method === "GET") { const o = control.hello(); return send(o.status, o.body); }
      if (url === "/control/session" && req.method === "POST") {
        let b; try { b = JSON.parse((await read()).toString("utf8")); } catch (e) { return send(e.status || 400, { error: e.status ? e.message : "body is not JSON" }); }
        const o = control.session(b); return send(o.status, o.body);
      }
      if (req.headers["x-guestd-session"] !== undefined || req.headers["x-guestd-mac"] !== undefined) {
        const raw = await read();
        const o = await control.call({ method: req.method, path: url, headers: req.headers, body: raw.toString("utf8") });
        return send(o.status, o.body, o.headers || {});
      }
      if (url.startsWith("/protected") || url.startsWith("/control")) return send(401, { error: "guestd-control/1 authentication required" });
      return legacy(req, res);
    } catch (e) { return send(e.status || 500, { error: e.message }); }
  });
}
