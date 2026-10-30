/* ============================================================
   Shared allocation r1: the bounded, authenticated LOCAL request path between the ONE allocation owner and the
   manager clients (SOURCE ONLY - authored, not run).

   It is guestd-control/1, unchanged: the server side is control.mjs ControlServer and the client side is the
   supervisor's GuestdControl (isolation/m4/guestd/control-client.mjs). One ControlServer per configured role, each with
   its OWN pairing key, so the role is bound by the key that authenticated the request, never by a body field. The
   listener binds loopback only, caps request bytes, concurrent connections and time; the client caps answer bytes and
   time. A 401/MAC/timeout outcome on a state-changing call is "unknown" (GuestdControl never repeats it): the manager
   then refuses the launch, and an unentered reservation is released only by the owner's own never-entered rule.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import { ControlServer } from "./control.mjs";
import { GuestdControl } from "../../../isolation/m4/guestd/control-client.mjs";

export const MAX_REQUEST_BYTES = 64 * 1024, MAX_RESPONSE_BYTES = 64 * 1024, MAX_CONNECTIONS = 16;
const OPS = ["register", "acquire", "enter", "observe", "status"];
const ROLE_PATH = /^\/alloc\/(general|native)(\/.*)$/;

/** owner op dispatch for one authenticated role */
export function allocationRoutes(owner, role) {
  return async ({ method, path, body }) => {
    const m = /^\/allocation\/([a-z]+)$/.exec(path);
    if (!m || !OPS.includes(m[1])) return { status: 404, body: { error: "not_found" } };
    if (m[1] === "status") return method === "GET" ? { status: 200, body: owner.status() } : { status: 405, body: { error: "GET only" } };
    if (method !== "POST") return { status: 405, body: { error: "POST only" } };
    let j;
    try { j = JSON.parse(String(body || "")); } catch { return { status: 400, body: { error: "body is not JSON" } }; }
    if (!j || typeof j !== "object" || Array.isArray(j)) return { status: 400, body: { error: "body must be an object" } };
    if ("role" in j && j.role !== role) return { status: 403, body: { error: "the authenticated key belongs to another role" } };
    try { return { status: 200, body: await owner[m[1]](role, j) }; }
    catch (e) { return { status: e.status || 409, body: { error: e.message, ...(e.terms ? { terms: e.terms } : {}) } }; }
  };
}

/** keys: { general?: Buffer(32), native?: Buffer(32) } - distinct; each role's ControlServer holds only its own key */
export function createAllocationService(owner, { keys, now } = {}) {
  const entries = Object.entries(keys || {});
  if (!entries.length || entries.some(([r, k]) => !["general", "native"].includes(r) || !Buffer.isBuffer(k) || k.length !== 32)) throw Error("allocation service needs a 32-byte key per role");
  if (entries.length === 2 && entries[0][1].equals(entries[1][1])) throw Error("each role needs its own pairing key");
  const controls = new Map(entries.map(([role, key]) => [role, new ControlServer({ key, handle: allocationRoutes(owner, role), ...(now ? { now } : {}) })]));
  const server = http.createServer(async (req, res) => {
    const send = (code, obj, headers = {}) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { "content-type": "application/json", "content-length": b.length, ...headers }); res.end(b);
    };
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const rm = ROLE_PATH.exec(u.pathname);
      const control = rm && controls.get(rm[1]);
      if (!control) { req.resume(); return send(404, { error: "not_found" }); }
      const declared = Number(req.headers["content-length"]);
      const tooBig = () => { res.on("finish", () => req.socket?.destroy()); send(413, { error: "request exceeds its byte bound" }, { connection: "close" }); };
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return tooBig();
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > MAX_REQUEST_BYTES) return tooBig(); chunks.push(c); }
      const body = Buffer.concat(chunks).toString("utf8");
      const sub = rm[2];
      if (req.method === "GET" && sub === "/control/hello") { const r = control.hello(); return send(r.status, r.body); }
      if (req.method === "POST" && sub === "/control/session") {
        let j; try { j = JSON.parse(body || "{}"); } catch { return send(400, { error: "body is not JSON" }); }
        const r = control.session(j); return send(r.status, r.body);
      }
      const r = await control.call({ method: req.method, path: sub, headers: req.headers, body });
      return send(r.status, r.body, r.headers || {});
    } catch (e) { if (!res.headersSent) send(500, { error: e.message }); }
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}

/** The manager side: one per manager process and role. managerIncarnation is fresh per process. */
export class AllocationClient {
  constructor({ url, role, key, requestTimeoutMs = 10_000 }) {
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(String(url))) throw Error("allocation owner URL must be http://127.0.0.1:<port> (loopback only)");
    if (!["general", "native"].includes(role)) throw Error("allocation client role must be general or native");
    this.role = role;
    this.managerIncarnation = crypto.randomBytes(16).toString("hex");
    this.ownerIncarnation = null;
    this.control = new GuestdControl(`${url}/alloc/${role}`, key, { requestTimeoutMs, handshakeTimeoutMs: 5_000, maxResponseBytes: MAX_RESPONSE_BYTES, maxHandshakeBytes: 16 << 10 });
  }
  async #call(op, body, method = "POST") {
    let r;
    try { r = await this.control.request(method, `/allocation/${op}`, method === "GET" ? undefined : body, { idempotent: method === "GET" }); }
    catch (e) { throw Object.assign(Error(`allocation owner ${op}: ${e.message}`), { status: 503, mayHaveExecuted: e.mayHaveExecuted === true }); }
    if (r.status !== 200) throw Object.assign(Error(r.body?.error || `allocation ${op} refused (${r.status})`), { status: r.status === 507 ? 507 : r.status === 400 ? 400 : 503, refusedBy: "owner", terms: r.body?.terms });
    return r.body;
  }
  #ids() { return { managerIncarnation: this.managerIncarnation, ownerIncarnation: this.ownerIncarnation }; }
  async register({ epoch, baseline }) {
    const r = await this.#call("register", { managerIncarnation: this.managerIncarnation, epoch, baseline });
    this.ownerIncarnation = r.ownerIncarnation;
    return r;
  }
  acquire(b) { return this.#call("acquire", { ...b, ...this.#ids() }); }
  enter(b) { return this.#call("enter", { ...b, ...this.#ids() }); }
  observe(b) { return this.#call("observe", { ...b, ...this.#ids() }); }
  status() { return this.#call("status", undefined, "GET"); }
}
