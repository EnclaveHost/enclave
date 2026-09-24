/* ============================================================
   The Windows app manager: the supervisor's /vms contract, backed by a Hyper-V partition per app.

   The supervisor reaches this over guestd-control/1 and asks it three kinds of question: what are
   you (GET /health), run this (POST /vms), and what is running (GET/DELETE /vms). None of that
   depends on a partition actually starting, which is why it is finished and tested while the
   launch seam is not: see backend.mjs for exactly why it cannot start one yet, and for the
   prerequisite it names instead of guessing.

   Two rules this file exists to keep:

     Fail closed on anything it cannot honour. `supports` is all false, so the supervisor's claim
     gate refuses a deployment with a GPU share, secrets, config, ports, volumes, a private owner
     gate or protection rules before it ever reaches here - and this file refuses them AGAIN rather
     than trusting that it was asked nicely. Two gates, because one of them is in another process.

     Never invent evidence. A domain that did not start has no attestation, and `attestation` is
     absent rather than null-shaped or "pending". Nothing here produces a report.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import { derive, DERIVATION, DERIVATION_V2, DERIVATIONS } from "./derive.mjs";

/* What this backend can actually SERVE, as opposed to derive. /2 needs a command's own socket
   inside the partition; when that exists, it moves into this list and the gate follows. */
export const SERVES = [DERIVATION];
import { HyperVPartitionBackend, BACKEND, SUPPORTS, PREREQUISITES } from "./backend.mjs";

export const POLICY_RULE = "enclave-isolation-policy/1";

/** The pinned share a domain gets, from the version's on-chain memMb. Nothing here has a default. */
export function policyFor({ memMb }) {
  const m = Number(memMb);
  if (!Number.isFinite(m)) throw new Error("the version declares no memMb, so no policy can be pinned");
  return { vcpus: 1, memMiB: Math.max(128, Math.floor(m)), cpuPercent: 100 };
}

/** What a spawn may NOT ask for here, checked again on this side of the wire. */
export function refuseUnsupported(req = {}) {
  const s = SUPPORTS;
  if (Number(req.gpuMilli) > 0 && !s.gpu) return "a GPU share: a per-app partition has no GPU path";
  if ((req.config || req.appConfigCid) && !s.config) return "app config: it is not delivered into a per-app partition";
  if (req.hasSecrets !== false && !s.secrets)
    return req.hasSecrets === true ? "staged secrets: they would cross this host in plaintext"
                                   : "unverified secret state: it must be known to be absent, not assumed";
  if ((req.firewall || []).length && !s.ports) return `declared ports (${req.firewall.join(", ")}): only the attested TLS endpoint is served`;
  if ((req.volumes || []).length) return "model volumes: they are not mounted into a per-app partition";
  if (req.isPublic !== true) return "a private deployment: its owner gate needs plaintext, which exists only inside the domain";
  if (req.waf && Object.keys(req.waf).length) return "protection rules (waf): they need plaintext, which exists only inside the domain";
  return null;
}

export class Manager {
  constructor({ backend = new HyperVPartitionBackend(), fetchComponent = null, runtimeId = "" } = {}) {
    this.backend = backend;
    this.fetchComponent = fetchComponent;       // (cid) -> Buffer, CID-verified by the caller's fetcher
    this.runtimeId = runtimeId;
    this.domains = new Map();
  }

  health() {
    return {
      backend: this.backend.backend,
      supports: { ...this.backend.supports },
      // DEFECT 4: /health had no boundary at all, so a reader could learn everything about this
      // manager EXCEPT what its isolation actually is. It is carried verbatim from the backend,
      // including hostExcluded:false, because that is the word that must never be lost.
      boundary: this.backend.boundary ?? null,
      // `derivations` IS THE GATE. The supervisor reads it as "this manager can derive AND run",
      // and acts on it: a listed derivation means the claim gate passes and the node takes the
      // lease ON CHAIN before this process ever sees the spawn. So a rule we can compute but not
      // serve must NOT appear - refusing at spawn is too late, and costs a claim, a failure and a
      // release, with the deployment possibly sitting Queued while a Linux box that CAN serve it is
      // free. Silence in this list is the refusal the gate understands. (enclave-5d, who owns the
      // consumer, asked for exactly this, and they are right.)
      catalog: {
        derivations: SERVES,                    // what it can serve: the gate reads this
        derives: DERIVATIONS,                   // what it can COMPUTE, byte-exactly: information only
        runtimeId: this.runtimeId || null,
      },
      runtime: { v2SocketServer: false,
                 note: "enclave-catalog-bundle/2 is derived byte-for-byte here but not served: serving a command on its own socket needs wasi:sockets inside the partition and an in-guest TLS front" },
      policyRule: POLICY_RULE,
      // canStart is the HOST's answer, refreshed by probe(), not "a launcher object exists". A
      // launcher wired to a box with no Hyper-V role is still a launcher, and reporting ready on
      // that basis is exactly the kind of claim this manager is not allowed to make.
      canStart: this._preflight ? this._preflight.ok === true : false,
      ...(this._preflight ? { preflight: this._preflight } : {}),
      ...(this._preflight && this._preflight.ok ? {} : { cannotStart: PREREQUISITES }),
    };
  }

  /** Ask the host what it has, and remember it. /health reports this rather than guessing. */
  async probe() {
    try { this._preflight = (await this.backend.preflight()) || { ok: false, checks: [{ name: "no launcher configured", ok: false }] }; }
    catch (e) { this._preflight = { ok: false, checks: [{ name: "preflight", ok: false, detail: e.message }] }; }
    return this._preflight;
  }

  async spawn(body = {}) {
    const d = body.derive || {};
    if (!DERIVATIONS.includes(d.derivation)) throw badRequest(`unknown derivation ${JSON.stringify(d.derivation ?? null)}`);
    // Refuse rather than approximate. The identity is right either way - derive() proves that -
    // but a /2 app is a command with its own socket, and serving one needs a runtime this backend
    // does not have. Taking it and running something else would be the worst of both.
    if (d.derivation === "enclave-catalog-bundle/2")
      throw badRequest("this backend derives enclave-catalog-bundle/2 but cannot serve it yet: "
        + "a command serving its own socket needs wasi:sockets inside the partition and an in-guest TLS front");
    if (this.runtimeId && d.runtimeId !== this.runtimeId)
      throw badRequest(`the mapping is pinned to runtime ${d.runtimeId}, and this host runs ${this.runtimeId}`);
    const refusal = refuseUnsupported(body);
    if (refusal) throw badRequest(`this backend does not honour ${refusal}`);
    if (!this.fetchComponent) throw badRequest("no component fetcher configured");

    const component = await this.fetchComponent(d.cid);
    const mapping = derive({ record: d, component });     // throws on anything the rule refuses

    // DEFECT 6: a second spawn for a live deployment is an ADOPTION, not a silent overwrite. The
    // first version replaced the record and forgot the first handle, orphaning a running partition
    // that the manager no longer listed. guestd answers 409 {error, id}; so do we.
    const name = String(body.name || "");
    if (!name) throw badRequest("a deployment id (name) is required");
    const live = [...this.domains.values()].find((r) => r.name === name && r.status !== "failed" && r.status !== "stopped");
    if (live) { const e = new Error(`an instance for ${name} is already live`); e.status = 409; e.id = live.id; throw e; }
    if (body.id && this.domains.has(String(body.id))) {
      const e = new Error(`instance ${body.id} already exists`); e.status = 409; e.id = String(body.id); throw e;
    }
    // "hv" + 8 hex, the shape 5d's supervisor and datapath expect; guestd uses "gd" + 8.
    const id = body.id || ("hv" + crypto.randomBytes(4).toString("hex"));
    // The domain's own name, unique per DEPLOYMENT rather than per app: two deployments of the
    // same app derive the same AppID, and naming a VM after the AppID alone made the second one
    // collide with the first. Short, stable, and safe in a VM name.
    const instanceId = (String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || crypto.randomBytes(8).toString("hex"))
                     + "-" + String(mapping.appId).slice(0, 8);
    // `status`, not `state`: guestd's vocabulary, which the supervisor reads (starting | running |
    // failed | stopped). The old "guest-booted" was a fifth word no consumer knew, so a booted
    // domain read as dead every tick and was respawned.
    const rec = { id, name, instanceId, appId: mapping.appId, recordSha256: mapping.recordSha256,
                  componentSha256: mapping.componentSha256, policy: mapping.record.policy,
                  catalog: mapping.record.catalog, cid: mapping.record.cid,
                  runtimeId: mapping.record.runtimeId, status: "starting", startedAt: null, reason: null,
                  // DEFECT 4: what the data plane needs to route, and what the boundary IS. 5d's
                  // splice admits on `image` + `transportKeySha256` and refuses without them, and
                  // the boundary is the word this backend's own header says must never be lost.
                  boundary: this.backend.boundary ?? null, tier: null, hostExcluded: false,
                  verdict: null, image: null, transportKeySha256: null, relay: null,
                  domainId: null, guestPort: null };
    this.domains.set(id, rec);
    try {
      const h = await this.backend.start(mapping, { instanceId });
      // WHAT WAS ESTABLISHED, and no more. The launcher returns only when the VM is Running and the
      // guest produced output, which means something inside the partition executed. It does NOT
      // mean the component was delivered, compiled or served: there is no app-readiness handshake
      // on this backend, so there is no evidence for "running" and the record does not claim it.
      // "guest-booted" is a state a reader can act on; "running" would be a guess.
      rec.status = h && h.appReady === true ? "running" : "starting";
      rec.appReady = !!(h && h.appReady === true);
      rec.startedAt = Date.now(); rec.handle = h;
      if (h && h.guest) rec.guest = { booted: h.guest.booted === true, bytes: h.guest.bytes, head: h.guest.head };
      if (h && h.name) rec.vmName = h.name;
      // carried up verbatim rather than summarised away
      if (h && h.boundary) { rec.boundary = h.boundary; rec.tier = h.boundary.tier ?? null;
                             rec.hostExcluded = h.boundary.hostExcluded === true; }
      if (h && h.domainId != null) rec.domainId = h.domainId;
      if (h && h.guestPort != null) rec.guestPort = h.guestPort;
      if (h && h.image) rec.image = h.image;
      if (h && h.tcpPort != null) rec.relay = { host: "127.0.0.1", port: h.tcpPort };
      else if (h && h.relay) rec.relay = h.relay;
      if (!rec.appReady)
        rec.reason = "the guest booted and produced console output; this backend has no app-readiness handshake, so whether the app is serving is not established";
    } catch (e) {
      // The identity is still real and worth keeping: it is what was asked for and what would run.
      rec.status = "failed";
      rec.reason = e.message;
      if (e.prerequisites) rec.prerequisites = e.prerequisites;
    }
    return this.publicOf(rec);
  }

  publicOf(r) {
    const { handle, ...rest } = r;
    return rest;    // no attestation field: a domain that did not run has no evidence to show
  }
  list() { return [...this.domains.values()].map((r) => this.publicOf(r)); }
  get(id) { const r = this.domains.get(id); return r ? this.publicOf(r) : null; }
  /**
   * DEFECT 5: the first version swallowed the stop error and deleted the record regardless, so a
   * DELETE answered "ok" while the VM (WMI: stop_failed) or partition (HCS: launcher error) was
   * still running - an orphan the manager no longer listed and nobody could find. A stop that did
   * not succeed leaves the record in place, marked, and reports the failure.
   */
  async remove(id) {
    const r = this.domains.get(id);
    if (!r) return { removed: false, absent: true };
    try {
      await this.backend.stop(r.handle);
    } catch (e) {
      r.status = "failed";
      r.reason = `stop failed, so this domain may still be RUNNING and is deliberately still listed: ${e.message}`;
      const err = new Error(r.reason); err.status = 500; err.id = id; throw err;
    }
    r.status = "stopped";
    this.domains.delete(id);
    return { removed: true, absent: false };
  }
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

/** The HTTP surface. Bound to loopback: the supervisor reaches it over guestd-control/1. */
export function createServer(manager) {
  return http.createServer(async (req, res) => {
    const send = (code, body) => {
      const b = Buffer.from(JSON.stringify(body));
      res.writeHead(code, { "content-type": "application/json", "content-length": b.length });
      res.end(b);
    };
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const p = u.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "GET" && p === "/health") return send(200, manager.health());
      if (req.method === "GET" && p === "/vms") return send(200, { vms: manager.list() });
      if (req.method === "POST" && p === "/vms") {
        const chunks = []; for await (const c of req) chunks.push(c);
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { return send(400, { error: "body is not JSON" }); }
        // 201, which is what guestd answers and what the supervisor checks for
        try { return send(201, await manager.spawn(body)); }
        // `id` MUST cross the wire on a 409 or adoption cannot happen: the client is told a name is
        // live and has nothing to adopt. Manager.spawn sets it and the client reads it; this catch
        // dropped it, so both halves were written for an adoption that could never occur over HTTP
        // (enclave-99, measured over real HTTP - which is why calling Manager.spawn directly in a
        // test never showed it).
        catch (e) { return send(e.status || 500, { error: e.message,
                                                   ...(e.id ? { id: e.id } : {}),
                                                   ...(e.prerequisites ? { prerequisites: e.prerequisites } : {}) }); }
      }
      const m = p.match(/^\/vms\/([^/]+)$/);
      if (m && req.method === "GET") { const r = manager.get(decodeURIComponent(m[1])); return r ? send(200, r) : send(404, { error: "not_found" }); }
      if (m && req.method === "DELETE") {
        const id = decodeURIComponent(m[1]);
        try {
          const r = await manager.remove(id);
          return r.absent ? send(404, { error: "not_found" }) : send(200, { ok: true });
        } catch (e) {
          // a stop that failed is NOT a removal: say so with the domain still listed
          return send(e.status || 500, { error: e.message, id: e.id ?? id, stillListed: true });
        }
      }
      return send(404, { error: "not_found" });
    } catch (e) { return send(500, { error: e.message }); }
  });
}
