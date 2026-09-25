// isolation-client.mjs - the Windows node's client for a per-app isolation manager.
//
// WHY THIS FILE EXISTS. enclave-99 found by reading the deployed bytes that nothing on this node
// calls the manager at all: neither windows/node/deployed/*.mjs at ef1b2077 nor host.mjs contains
// any /vms, VMMGR or guestd-control client. supervisor.js - the consumer the manager was written
// against - runs on the Linux node CVM, not here. So the manager could boot a domain and no
// deployment would ever cause one to. This closes that gap from the node's side.
//
// THE CONTRACT IS GUESTD'S, NOT A NEW ONE. isolation/m4/guestd/server.go is the deployed contract
// and this speaks it unchanged: POST /vms answers 201 with the record, or 409 {error, id} when an
// instance for that name is already live; the record carries `status` (not `state`) in
// starting | running | failed | stopped, `name` = the deploymentId the node sent, plus appId,
// runtimeId and recordSha256. Ids are whatever the manager gave - guestd's are "gd"+8 hex and the
// Hyper-V manager's are "hv"+8 hex, and this client does NOT pattern-match them. A client that
// insisted on one backend's id shape is exactly the coupling that made the supervisor refuse the
// other's 409, so adoption here matches on NAME, which both backends carry.
//
// WHAT IT REFUSES TO CONCLUDE. `running` is the manager's word under its own readiness rule, and
// this client never upgrades anything on its own: console output, a started partition and a 200
// from the app are each insufficient. Above all it never reads a boundary as host-excluding. A
// T0-hv Hyper-V child partition does NOT exclude the host - the guest says so itself
// (host_excluded=no) - so `attestedCapacity()` is false for it whatever else the record says, and
// nothing here may make this box advertise verified or host-excluded capacity.

const OK_STATUS = new Set(["starting", "running", "failed", "stopped"]);

export class IsolationError extends Error {
  // kind: "refused" | "unavailable" | "protocol" | "timeout" | "transport" | "conflict"
  //   refused      a 4xx: the manager ANSWERED no. The only kind that says something did not happen.
  //   unavailable  a 5xx: the manager could not answer (inventory not surveyed, the survey failed, an unknown id while
  //                an unattributed VM exists). Nothing is known, so a caller holds.
  constructor(kind, message, detail = null) { super(message); this.kind = kind; this.detail = detail; }
}

export class IsolationManagerClient {
  /**
   * @param base        the manager's origin, e.g. http://127.0.0.1:8091
   * @param fetchImpl   injected; nothing here reaches the network by itself, so this is testable
   * @param timeoutMs   a hard bound on every exchange
   */
  constructor({ base, fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxBytes = 1 << 20 } = {}) {
    if (!base) throw new Error("an isolation manager base URL is required");
    this.base = String(base).replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  async #req(method, path, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) throw new IsolationError("timeout", `${method} ${path}: no answer within ${this.timeoutMs} ms`);
      throw new IsolationError("transport", `${method} ${path}: ${(e && e.message) || e}`);
    } finally { clearTimeout(timer); }
    const text = await res.text();
    if (text.length > this.maxBytes) throw new IsolationError("protocol", `${method} ${path}: answer over the ${this.maxBytes}-byte cap`);
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {
      throw new IsolationError("protocol", `${method} ${path}: answer is not JSON: ${text.slice(0, 160)}`);
    }
    return { status: res.status, body: json };
  }

  /** A non-success answer as an error: a 5xx is UNAVAILABLE (nothing is known), anything else is a REFUSAL. */
  static #answerError(what, r) {
    // the VMs that make an id unknown (d1's 6b1137ee answers them), named so an operator can see which to remove
    const orphans = Array.isArray(r.body && r.body.unattributed) && r.body.unattributed.length
      ? ` (VMs naming no deployment: ${r.body.unattributed.join(", ")})` : "";
    const why = `${what}: ${(r.body && r.body.error) || r.status}${orphans}`;
    return new IsolationError(r.status >= 500 ? "unavailable" : "refused", why, r.body);
  }

  /**
   * The spawn body is EXACTLY what supervisor.js sends, because a manager that refuses the real
   * body while a test's invented body passes is the defect this whole lane started from: the
   * manager refused every spawn for want of isPublic/hasSecrets, which the supervisor never sends,
   * and 77 tests passed over a contract that could not execute.
   */
  static spawnBody({ id, image, name, cpuShare = 0, gpuShare = 0, appPort, ports = [], config = "",
                     configCid = "", egress = "", derive, hosts, isPublic, hasSecrets }) {
    if (!name) throw new Error("a deployment id (name) is required");
    if (!image) throw new Error("an image reference is required");
    if (!derive) throw new Error("a derivation record is required: a CID without one is refused");
    // The manager refuses a spawn that does not STATE these, and it is right to: "no secrets" has
    // to be known, not assumed, and a private deployment's owner gate needs plaintext that exists
    // only inside the domain. supervisor.js never sent them, so every real spawn 400'd - and the
    // manager's own test invented them, which is why 77 tests passed over a contract that could
    // not execute. The fix belongs HERE, in the caller that actually knows both facts from the
    // ledger, rather than in a manager that would have to assume them.
    if (isPublic !== true && isPublic !== false)
      throw new Error("isPublic must be stated from the ledger: the manager refuses to assume it");
    if (hasSecrets !== true && hasSecrets !== false)
      throw new Error("hasSecrets must be stated: absent secrets must be KNOWN absent, not assumed");
    const b = { image, name, cpuShare, gpuShare, appPort, ports, config, configCid, egress, derive,
                isPublic, hasSecrets };
    if (id) b.id = id;
    if (hosts) b.hosts = hosts;
    return b;
  }

  /** Start one domain. Returns { adopted, view }: a 409 is an ADOPTION, not a failure. */
  async spawn(body) {
    const r = await this.#req("POST", "/vms", body);
    if (r.status === 201 || r.status === 200) return { adopted: false, view: this.#view(r.body) };
    if (r.status === 409) {
      const id = r.body && r.body.id;
      if (!id) throw new IsolationError("conflict", `the manager refused ${body.name} as already live but named no instance to adopt`);
      // ANY failure to read the domain a 409 named is a conflict, never a refusal: the manager has just said one IS live
      // (enclave-d1's re-review, finding 4: a 4xx other than 404 on this read used to free the lease)
      let cur;
      try { cur = await this.get(id); }
      catch (e) { throw new IsolationError("conflict", `the manager named ${id} as live for ${body.name} and then could not be asked about it: ${e.message}`, e.detail); }
      if (!cur) throw new IsolationError("conflict", `the manager named ${id} to adopt and then did not have it`);
      return { adopted: true, view: cur };
    }
    throw IsolationManagerClient.#answerError(`the manager did not launch ${body.name}`, r);
  }

  async get(id) {
    const r = await this.#req("GET", `/vms/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw IsolationManagerClient.#answerError(`GET /vms/${id}`, r);
    return this.#view(r.body);
  }

  async list() {
    const r = await this.#req("GET", "/vms");
    if (r.status !== 200) throw IsolationManagerClient.#answerError("GET /vms", r);
    const rows = Array.isArray(r.body) ? r.body : (r.body && r.body.vms) || [];
    return rows.map((v) => this.#view(v));
  }

  /**
   * Stop and forget one domain. A manager that answers ok while the domain is still live is a
   * defect on its side (enclave-99's defect 5), and this reports what it was told rather than
   * assuming: a caller that must know it is gone re-reads it.
   */
  async remove(id) {
    const r = await this.#req("DELETE", `/vms/${encodeURIComponent(id)}`);
    if (r.status === 404) return { removed: false, absent: true };
    if (r.status !== 200) throw IsolationManagerClient.#answerError(`DELETE /vms/${id}`, r);
    return { removed: true, absent: false, body: r.body };
  }

  async health() {
    const r = await this.#req("GET", "/health");
    if (r.status !== 200) throw IsolationManagerClient.#answerError("GET /health", r);
    return r.body;
  }

  /**
   * Adoption after a node restart matches on NAME, which every backend carries; never on id shape.
   *
   * "Not found" is only an answer when every listed domain HAS a name. A VM the manager recovered without a deployment
   * identity (an older manager's bare marker after an upgrade: `unattributed`, name null) could be this deployment's,
   * so while one is listed, a miss is UNKNOWN, never absent: absent would let retire() confirm a running VM gone and
   * reconcile() start a second one.
   */
  async findByName(name) {
    const all = await this.list();
    const hit = all.find((v) => v.name === name);
    if (hit) return hit;
    const nameless = all.filter((v) => v.unattributed || (v.recovered && !v.name));
    if (nameless.length) {
      throw new IsolationError("unavailable", `no domain is named ${name}, but ${nameless.length} VM(s) on this host name no `
        + `deployment (${nameless.map((v) => v.id).join(", ")}); one of them may be this one, so whether it exists is unknown`);
    }
    return null;
  }

  #view(v) {
    const o = v && typeof v === "object" ? v : {};
    const status = String(o.status || "");
    if (o.status !== undefined && !OK_STATUS.has(status)) {
      throw new IsolationError("protocol", `the manager reported status ${JSON.stringify(o.status)}, `
        + `which is not one of ${[...OK_STATUS].join(" | ")}`);
    }
    return {
      id: o.id ?? null,
      name: o.name ?? null,
      status: status || null,
      appId: o.appId ?? null,
      runtimeId: o.runtimeId ?? null,
      recordSha256: o.recordSha256 ?? null,
      image: o.image ?? null,
      transportKeySha256: o.transportKeySha256 ?? null,
      // carried through verbatim, never summarised away: the backend's own word about what its
      // boundary is and is not
      boundary: o.boundary ?? null,
      tier: o.tier ?? null,
      hostExcluded: o.hostExcluded === true,
      verdict: o.verdict ?? null,
      relay: o.relay ?? (o.tcpPort ? { host: "127.0.0.1", port: o.tcpPort } : null),
      error: o.error ?? null,
      // a domain a RESTARTED manager rebuilt from Hyper-V: alive, and never to serve under that manager
      // (its relay and readiness belonged to the old process). The lifecycle holds it; see reconcile.
      recovered: o.recovered === true,
      // a recovered VM that names no deployment: see findByName
      unattributed: o.unattributed === true,
      reason: o.reason ?? null,
    };
  }
}

/** Alive for lifecycle purposes: it exists and is not finished. NOT a statement that it serves. */
export function instanceAlive(view) {
  return !!view && (view.status === "running" || view.status === "starting");
}

/** Serving: the manager's own readiness verdict, and only that. A recovered domain never serves under the manager
 *  that recovered it, whatever status it shows. */
export function instanceServing(view) {
  return !!view && view.status === "running" && !view.recovered;
}

/**
 * May this instance count as VERIFIED, HOST-EXCLUDED tenant capacity?
 *
 * Only when the backend itself says the host is excluded AND it reached that by a chain-verified
 * route. A T0-hv Hyper-V child partition reports host_excluded=no and is a development vehicle, so
 * this is false for it however healthy it looks. Nothing in this file may make the box advertise
 * capacity it does not have; "attested" means chain-verified, and nothing here verifies a chain.
 */
export function attestedCapacity(view) {
  if (!view || view.hostExcluded !== true) return false;
  return view.verdict === "chain-verified";
}
