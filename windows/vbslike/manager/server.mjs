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
import { runtimeId as runtimeId_ } from "../../../isolation/contract/runtime.mjs";
import crypto from "node:crypto";
import { derive, DERIVATION, DERIVATION_V2, DERIVATIONS } from "./derive.mjs";

/* What this backend can actually SERVE, as opposed to derive. /2 needs a command's own socket
   inside the partition; when that exists, it moves into this list and the gate follows. */
export const SERVES = [DERIVATION];
// consecutive failed answer checks that fail a running domain (a key change fails it at once)
export const ANSWER_STRIKES = 3;
import { HyperVPartitionBackend, BACKEND, SUPPORTS, PREREQUISITES } from "./backend.mjs";
import { parseNotes } from "./wmi-launcher.mjs";

/* ids: server-minted "hv" + 128 bits (63's P4: 32 bits collide, and a minted id was never checked against the
   records). A caller may still name one, but only in the shape the isolated route validator accepts
   (isolation/m4/guestd/supervisor-splice.mjs: /^[A-Za-z0-9-]{1,64}$/). */
export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const mintId = () => "hv" + crypto.randomBytes(16).toString("hex");

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
  /**
   * @param judgeReady  ({host, port, appId, launcherKey, expectRuntime, deadlineMs}) -> verdict.
   *                    Injected so a test drives it; defaults to ready.mjs's judgeRunning.
   * @param readyDeadlineMs  how long a domain has to become ready before it is failed.
   */
  constructor({ backend = new HyperVPartitionBackend(), fetchComponent = null, runtimeId = "",
                runtime = null, judgeReady = null, readyDeadlineMs = 120_000, answerCheck = null } = {}) {
    this.backend = backend;
    this.fetchComponent = fetchComponent;       // (cid) -> Buffer, CID-verified by the caller's fetcher
    // THE RUNTIME IDENTITY, not just its hash. judge-hv hands `expectRuntime` to the shared
    // checkRuntime as `want.runtime`, which DIFFS IT FIELD BY FIELD against the identity the
    // document states (name, version, execution, targetIsa, hostIsa, cpuFeatures, wx, cache). A
    // 64-hex RuntimeID has none of those fields, so passing one rejected every real document and
    // the manager could never say running - both halves right, the join passing the wrong thing
    // (enclave-99, defect 11, measured through the real join).
    //
    // So the identity is the input and the hash is DERIVED from it with the contract's own
    // runtimeId(), rather than being configured separately: two independently-supplied values that
    // must agree are two values that will eventually disagree.
    this.runtime = runtime;
    this.runtimeId = runtime ? Buffer.from(runtimeId_(runtime)).toString("hex") : runtimeId;
    // The code and the doc disagreed: the comment said this defaults to ready.mjs's judgeRunning
    // and it actually defaulted to null, which leaves every record `starting` forever WITH NO
    // REASON - a manager that looks healthy and never promotes anything (enclave-5d, whose harness
    // it caught for a run). main.mjs passes the real rule, so production was fine, which is
    // exactly why it could sit there. Null is now an explicit, stated refusal rather than silence.
    this.judgeReady = judgeReady;
    // ({host, port, appId, transportKeySha256}) -> {ok} | {ok:false, keyChanged, reason}; ready.mjs checkAnswer in main.mjs
    this.answerCheck = answerCheck;
    this.noReadinessRule = !judgeReady;
    this.readyDeadlineMs = readyDeadlineMs;
    this.domains = new Map();
    this.judging = new Map();                   // id -> the readiness promise, so tests can await it
    // THIS PROCESS's epoch (128 bits), stated on /health and every record so a client can tell that the
    // manager it is talking to is not the one that answered before. Ids survive a restart (they are in
    // the VMs' Notes); the epoch says a restart happened.
    this.epoch = crypto.randomBytes(16).toString("hex");
    // THE INVENTORY GATE (63's P1). A manager that can launch VMs cannot know what exists until it has
    // asked Hyper-V: until recover() has run, "not in my memory" is UNKNOWN, never "absent", and every
    // /vms answer is 503. A backend with no launcher can run nothing, so there is nothing to recover.
    this.inventory = backend && backend.canSurvey ? { state: "pending" } : { state: "not-applicable" };
    // Ids THIS process removed, each confirmed gone by the backend (the launcher removes by VM Id and checks the
    // VM is no longer there). For these, "absent" is KNOWN even while an unattributed VM exists; without it a node
    // could never confirm a retire on a box holding an orphan (the reviewer's follow-up finding 1).
    this.removedIds = new Set();
    // Called when a domain stops being ours to serve: the data plane closes its established
    // sessions. main.mjs wires it to dataPlaneFor(...).closeInstance. It was SET there and never
    // CALLED here (enclave-5d, by grepping the whole tree) - so a removed domain's sessions stayed
    // open and kept carrying traffic to something that no longer existed. A stop that does not stop
    // the traffic is not a stop.
    this.onReclaim = null;
  }

  /**
   * Judge one domain's readiness and write the result into its record.
   *
   * WHY THIS IS NOT PART OF spawn(). Readiness takes as long as the guest takes, and the supervisor
   * polls GET /vms/:id; blocking the spawn for two minutes would time out the caller and tell it
   * nothing it could not learn by asking. So spawn answers `starting` immediately and this runs
   * behind it, flipping the record to `running` only when the rule passes.
   *
   * WHAT IT WRITES, and why it matters: `transportKeySha256`, the key the document was verified on.
   * 5d's splice admits a route on exactly that, so a record without it cannot be routed - which is
   * what every record had until now. `running` and the key are written TOGETHER, from one verdict,
   * because a status that says running without the key it was reached on is a route nobody can
   * admit, and a key without a verdict is a key nobody checked.
   */
  async #judgeReadiness(rec, handle) {
    const judge = this.judgeReady;
    if (!judge) {
      rec.reason = "this manager was built with no readiness rule, so no domain can ever become "
                 + "running: it stays starting until something judges it";
      return;
    }
    if (!rec.relay || !rec.relay.port) {
      rec.reason = "the backend exposed no relay port, so readiness cannot be judged and nothing can be routed";
      return;
    }
    // THE PARTITION (enclave-d1, READINESS.md M1). judge-hv compares the report's partition.vmId with the partition the
    // launcher holding this key is bound to, as that launcher states it (wmiserve's launcher step; the lab's load answer).
    // Without it the only thing tying a report to THIS domain's VM is one launcher key per VM. A handle that carries a
    // launcher key and names no partition is refused, never judged without the check.
    if (!handle.launcherVmId) {
      rec.status = "failed"; rec.appReady = false;
      rec.reason = "the backend named no partition for its launcher key (launcherVmId), so a report from another partition could not be told apart";
      this.#reclaim(rec.id, "failed readiness");
      return;
    }
    try {
      // The launcher's statement and image, judged as a PAIR against the signed report (judge-hv): a record that
      // states one is never judged on its image alone. The HCS lab's records carry no statement and no image.
      const gi = rec.guestIdentity;
      const statement = gi ? { expectedStatement: { partition: gi.partition, guestImageKind: gi.guestImageKind },
                               expectedImageSha256: rec.image } : {};
      const v = await judge({ host: rec.relay.host, port: rec.relay.port, appId: rec.appId,
                              launcherKey: handle.launcherKey, expectedVmId: handle.launcherVmId, ...statement,
                              // the IDENTITY object, which is what checkRuntime compares; never the hash
                              expectRuntime: this.runtime ?? undefined,
                              deadlineMs: this.readyDeadlineMs });
      if (this.domains.get(rec.id) !== rec) return;         // removed, or replaced, while we were judging (63's P3: identity, not presence)
      rec.transportKeySha256 = v.transportKeySha256 ?? null;
      rec.verdict = v.checks?.document?.verdict ?? null;
      if (v.status === "running") { rec.status = "running"; rec.appReady = true; rec.reason = null; }
      else {
        rec.status = "failed"; rec.appReady = false; rec.reason = v.reason || "not ready";
        // a domain that failed readiness must not keep serving established sessions either
        this.#reclaim(rec.id, "failed readiness");
      }
      rec.readyChecks = v.checks ?? null;
    } catch (e) {
      if (this.domains.get(rec.id) !== rec) return;
      rec.status = "failed";
      rec.reason = `readiness could not be judged: ${e.message}`;
    }
  }

  /** Is the inventory known well enough to answer "absent"? */
  get inventoryReady() { return this.inventory.state === "ready" || this.inventory.state === "not-applicable"; }
  /** VMs that are ours but name no deployment: while any exists, an unknown id might be one of them. */
  unattributed() { return [...this.domains.values()].filter((r) => r.unattributed); }
  /**
   * May this manager say an id it does not hold is ABSENT? Only once it has surveyed Hyper-V AND holds no
   * unattributed VM. With an unattributed VM present the honest answer is "unknown": the id a caller asks
   * about may be exactly that VM, recorded under a previous manager (a reviewer's finding on the upgrade path,
   * where retire read 404 and "confirmed gone" over a running legacy-marked VM).
   */
  mayAnswerAbsent(id = null) {
    if (!this.inventoryReady) return false;
    if (id !== null && this.removedIds.has(id)) return true;      // removed and confirmed gone by this process
    return this.unattributed().length === 0;
  }

  /**
   * REBUILD THE INVENTORY FROM HYPER-V (63's P1/P1b). Every VM this manager owns carries its identity
   * in its Notes (wmi-launcher.mjs notesFor), so a restarted manager recovers each one as a record:
   * listed, blocking a second spawn for its deployment, and removable by its VM Id. It is NOT serving:
   * its relay and readiness belong to the previous process. Its status is `starting` (alive, not
   * serving) with `recovered: true`, and NEVER `failed`: to the node, failed means the domain ENDED and
   * its lease is free, which for a VM that is still running on this host is exactly the P1 lie (measured
   * by 63's restart regression, which freed the lease over a live VM when this said failed). Nor
   * `running`: nothing here verified it. A VM that is ours but names no deployment is UNATTRIBUTED, and
   * spawning is refused while one exists. A survey that fails leaves the gate shut: unknown is not absent.
   */
  async recover() {
    if (!this.backend || !this.backend.canSurvey) { this.inventory = { state: "not-applicable" }; return this.inventory; }
    let s;
    try { s = await this.backend.survey(); }
    catch (e) { this.inventory = { state: "failed", error: `the Hyper-V survey failed: ${e.message}` }; return this.inventory; }
    if (!s || !Array.isArray(s.vms)) { this.inventory = { state: "failed", error: "the Hyper-V survey returned no VM list" }; return this.inventory; }
    let recovered = 0, unattributed = 0;
    for (const vm of s.vms) {
      const { owned, identity } = parseNotes(vm.notes);
      const vmId = String(vm.vmId || "");
      if (!identity) {
        // Under our prefix without our identity, or marked ours without one: never guessed at.
        const id = "orphan-" + (vmId || String(vm.name || "unknown")).replace(/[^A-Za-z0-9-]/g, "").slice(0, 57);
        this.domains.set(id, { id, name: null, unattributed: true, recovered: true, owned, vmName: vm.name ?? null,
          status: "starting", appReady: false, hostExcluded: false, boundary: this.backend.boundary ?? null,
          reason: `a VM ${owned ? "marked as ours" : "under this manager's prefix"} (${vm.name}, ${vm.state}) carries no deployment identity: `
                + "spawning is refused until it is removed (DELETE this id)",
          handle: vmId ? { name: vm.name ?? null, vmId, recovered: true } : null });
        unattributed++; continue;
      }
      const rec = { id: identity.id, name: identity.name, instanceId: identity.instanceId, appId: identity.appId ?? null,
        recovered: true, status: "starting", appReady: false, hostExcluded: false, boundary: this.backend.boundary ?? null,
        vmName: vm.name ?? null, vmState: vm.state ?? null, relay: null, transportKeySha256: null, image: null,
        reason: `recovered after a manager restart: the VM (${vm.state}) is still on this host, but its relay and `
              + "readiness belonged to the previous manager, so it is not serving and will NOT become running under "
              + "this manager. It blocks a second spawn for this deployment; remove it (DELETE) to stop and delete the VM.",
        handle: { name: vm.name ?? null, vmId, recovered: true } };
      this.domains.set(rec.id, rec); recovered++;
    }
    this.inventory = { state: "ready", recovered, unattributed, at: new Date().toISOString() };
    return this.inventory;
  }

  health() {
    return {
      managerEpoch: this.epoch,
      inventory: this.inventory,
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
    if (!this.inventoryReady) throw unavailable(this.inventory);
    const orphans = [...this.domains.values()].filter((r) => r.unattributed);
    if (orphans.length) {
      const e = new Error(`${orphans.length} VM(s) on this host are ours but name no deployment (${orphans.map((r) => r.id).join(", ")}): `
        + "spawning is refused until they are removed, rather than guessing whether one of them is this deployment");
      e.status = 503; throw e;
    }
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
    // A RECOVERED record blocks too, whatever its status: its VM is still on this host.
    const live = [...this.domains.values()].find((r) => r.name === name && (r.recovered || (r.status !== "failed" && r.status !== "stopped")));
    if (live) { const e = new Error(`an instance for ${name} is already live`); e.status = 409; e.id = live.id; throw e; }
    if (body.id !== undefined && body.id !== null && body.id !== "" && !ID_RE.test(String(body.id)))
      throw badRequest(`an instance id must match ${ID_RE}`);
    if (body.id && this.domains.has(String(body.id))) {
      const e = new Error(`instance ${body.id} already exists`); e.status = 409; e.id = String(body.id); throw e;
    }
    // "hv" + 32 hex (128 bits), minted here and checked against what is held (63's P4).
    let id = body.id ? String(body.id) : mintId();
    while (!body.id && this.domains.has(id)) id = mintId();
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
      const h = await this.backend.start(mapping, { instanceId, identity: { id, name, instanceId, appId: mapping.appId } });
      // WHAT WAS ESTABLISHED, and no more. The launcher returns only when the VM is Running and the
      // guest produced output, which means something inside the partition executed. It does NOT
      // mean the component was delivered, compiled or served: there is no app-readiness handshake
      // on this backend, so there is no evidence for "running" and the record does not claim it.
      // "guest-booted" is a state a reader can act on; "running" would be a guess.
      rec.status = h && h.appReady === true ? "running" : "starting";
      rec.appReady = !!(h && h.appReady === true);
      rec.startedAt = Date.now(); rec.handle = h;
      // THE RELAY IS A CHILD PROCESS (wmiserve-run.mjs). If it exits while this record stands and no stop is under way,
      // the domain can no longer be reached and must not read as running (d1's review of 299ce3e9). The record fails,
      // its sessions are reclaimed, and the VM is LEFT for the node to retire: only a stop removes a VM.
      if (h && h.wmiserve && h.wmiserve.exited && typeof h.wmiserve.exited.then === "function") {
        h.wmiserve.exited.then((ex) => {
          if (this.domains.get(rec.id) !== rec || this.#stopping.has(rec)) return;
          if (rec.status !== "running" && rec.status !== "starting") return;     // already failed or stopped: its reason stands
          rec.status = "failed"; rec.appReady = false;
          rec.reason = `the relay process exited (code ${ex?.code ?? null}${ex?.signal ? `, ${ex.signal}` : ""}): this domain `
                     + "cannot be reached, and its VM is left for the node to retire";
          this.#reclaim(rec.id, "the relay process exited");
        });
      }
      if (h && h.guest) rec.guest = { booted: h.guest.booted === true, bytes: h.guest.bytes, head: h.guest.head };
      if (h && h.name) rec.vmName = h.name;
      // carried up verbatim rather than summarised away
      if (h && h.boundary) { rec.boundary = h.boundary; rec.tier = h.boundary.tier ?? null;
                             rec.hostExcluded = h.boundary.hostExcluded === true; }
      if (h && h.domainId != null) rec.domainId = h.domainId;
      if (h && h.guestPort != null) rec.guestPort = h.guestPort;
      if (h && h.image) rec.image = h.image;
      // The key this domain's reports are signed with, as the launcher stated it. wmiserve mints a NEW one per run, so a
      // verifier holding one fixed key cannot judge a relaunched domain. It is public (it verifies, it cannot sign),
      // and it is exactly what this manager's own readiness rule was given (handle.launcherKey). It is a HOST STATEMENT,
      // never a root: consistent with T0-hv, where the host launcher is trusted by definition and the host is not excluded.
      if (h && h.launcherKey) rec.launcherKey = h.launcherKey;
      // ...and the partition that key signs for, in the launcher's own words (the readiness rule's expectedVmId, from the
      // handle). Public beside the key, so a SECOND judge of this domain - the node's certificate relay (windows/node/
      // hvcert.mjs) - checks the report's partition exactly as this manager does. A host statement, like the key.
      if (h && h.launcherVmId) rec.launcherVmId = h.launcherVmId;
      // the launcher's (partition, guestImageKind) statement, which the image is only ever compared with
      if (h && h.guestIdentity) rec.guestIdentity = { partition: h.guestIdentity.partition, guestImageKind: h.guestIdentity.guestImageKind };
      if (h && h.tcpPort != null) rec.relay = { host: "127.0.0.1", port: h.tcpPort };
      else if (h && h.relay) rec.relay = h.relay;
      if (!rec.appReady)
        rec.reason = "the guest booted and produced console output; readiness has not been judged yet, so whether the app is serving is not established";
      // Judge readiness BEHIND the answer, and after the placeholder reason above, which would
      // otherwise overwrite whatever the verdict wrote. The caller gets `starting` now and asks
      // again; this flips the record to `running` with the key it was verified on, or fails it.
      if (!rec.appReady && rec.status !== "failed") {
        const pj = this.#judgeReadiness(rec, h).finally(() => this.judging.delete(rec.id));
        this.judging.set(rec.id, pj);
        pj.catch(() => {});
      }
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
    return { ...rest, managerEpoch: this.epoch };    // no attestation field: a domain that did not run has no evidence to show
  }
  list() { return [...this.domains.values()].map((r) => this.publicOf(r)); }
  get(id) { const r = this.domains.get(id); return r ? this.publicOf(r) : null; }
  /**
   * DEFECT 5: the first version swallowed the stop error and deleted the record regardless, so a
   * DELETE answered "ok" while the VM (WMI: stop_failed) or partition (HCS: launcher error) was
   * still running - an orphan the manager no longer listed and nobody could find. A stop that did
   * not succeed leaves the record in place, marked, and reports the failure.
   */
  /**
   * Tell the data plane a domain is no longer ours to serve, so its established sessions are
   * closed. Never throws into the caller: by the time this runs the domain is already gone, and a
   * data plane that is down must not turn a completed removal into a failure.
   */
  #reclaim(id, why) {
    try { this.onReclaim?.(id, why); } catch { /* the domain is gone either way */ }
  }

  // records a stop is under way for: their relay's exit is the stop's doing, not a failure
  #stopping = new WeakSet();

  /**
   * LIVENESS: a partition can stop BY ITSELF, and nothing else here would notice.
   *
   * Measured on nucbox-k11 (G4, run 082856, enclave-63's probe 72462737): when the guest's PID 1 dies, the kernel
   * panics and asks for an immediate reset. On a TYPE-1 partition Hyper-V answers "shut down for a reset initiated by
   * the guest" (Worker-Admin 18515, after 18590), and the VM goes OFF. It does not reboot. wmiserve does not exit when
   * its VM stops, so the relay-exit watch never fires, and the record would read `running` over a dead partition
   * forever.
   *
   * So a periodic sweep surveys Hyper-V and FAILS every started or recovered domain whose VM is not Running, or is
   * absent from a SUCCESSFUL survey. It stops that domain's relay, reclaims its sessions, and leaves the VM for the node
   * to retire (only a stop removes a VM). Unknown is not gone: a survey that fails changes nothing. A record mid-start
   * (no handle yet) or being stopped is left alone.
   */
  async sweepLiveness() {
    if (!this.inventoryReady || !this.backend.canSurvey) return { checked: 0, failed: 0, skipped: "no inventory or no survey" };
    let s;
    try { s = await this.backend.survey(); } catch (e) { return { checked: 0, failed: 0, error: e.message }; }
    if (!s || !Array.isArray(s.vms)) return { checked: 0, failed: 0, error: "the survey returned no list" };
    const byId = new Map(s.vms.map((v) => [String(v.vmId || "").toLowerCase(), v]));
    let checked = 0, failed = 0;
    for (const rec of this.domains.values()) {
      if (rec.status !== "running" && rec.status !== "starting") continue;
      const vmId = rec.handle && rec.handle.vmId;
      if (!vmId || this.#stopping.has(rec)) continue;
      checked++;
      const v = byId.get(String(vmId).toLowerCase());
      if (v && v.state === "Running") continue;
      rec.status = "failed"; rec.appReady = false;
      rec.reason = v
        ? `the partition is ${v.state}: it stopped by itself (on type 1 a guest reset turns the VM Off, measured in G4 run 082856); its VM is left for the node to retire`
        : "the partition is no longer on this host (absent from a successful survey)";
      const run = rec.handle && rec.handle.wmiserve;
      if (run && typeof run.stop === "function") run.stop().catch(() => {});      // its relay has nothing to carry
      this.#reclaim(rec.id, "the partition stopped");
      failed++;
    }
    return { checked, failed };
  }

  /**
   * ANSWERS: a partition can stay Running while its domain no longer answers (G4's outcome (c), a wedge; or a domain
   * answering on another key). sweepLiveness cannot see that, because it reads VM state. So every running domain with a
   * relay and a verified key is asked, on ONE TLS session (ready.mjs checkAnswer), whether its handshake still presents
   * the verified key and whether enclave-ready still answers for this app.
   *   - A different key fails it AT ONCE, naming both hashes: another boot or another domain is not a blip.
   *   - Any other failure, including a connect or TLS error, is a strike. ANSWER_STRIKES in a row fail it, and a single
   *     blip does not.
   *   - A good answer clears its strikes.
   * Failing does what sweepLiveness does: stop the relay, reclaim, and leave the VM for the node. Records mid-start,
   * being stopped, without a relay or without a verified key are skipped, and so is a record that changed while it was
   * asked. (enclave-5d, d1's constraints; ENCLAVE_ANSWER_CHECK_MS in main.mjs.)
   */
  #strikes = new WeakMap();
  async sweepAnswers() {
    if (typeof this.answerCheck !== "function") return { checked: 0, failed: 0, skipped: "no answer check" };
    let checked = 0, failed = 0;
    for (const rec of [...this.domains.values()]) {
      if (rec.status !== "running" || !rec.handle || this.#stopping.has(rec)) continue;
      if (!rec.relay || !rec.relay.port || !/^[0-9a-f]{64}$/.test(String(rec.transportKeySha256 || ""))) continue;
      checked++;
      let a;
      try { a = await this.answerCheck({ host: rec.relay.host, port: rec.relay.port, appId: rec.appId, transportKeySha256: rec.transportKeySha256 }); }
      catch (e) { a = { ok: false, keyChanged: false, reason: e.message }; }
      if (this.domains.get(rec.id) !== rec || this.#stopping.has(rec) || rec.status !== "running") continue;   // changed while asked
      if (a && a.ok === true) { this.#strikes.delete(rec); continue; }
      const why = (a && a.reason) || "no answer";
      const n = a && a.keyChanged === true ? ANSWER_STRIKES : (this.#strikes.get(rec) || 0) + 1;
      this.#strikes.set(rec, n);
      if (n < ANSWER_STRIKES) continue;
      rec.status = "failed"; rec.appReady = false;
      rec.reason = a && a.keyChanged === true
        ? `the domain no longer answers on its verified key: ${why}; its VM is left for the node to retire`
        : `the domain stopped answering (${n} checks in a row): ${why}; its VM is left for the node to retire`;
      const run = rec.handle && rec.handle.wmiserve;
      if (run && typeof run.stop === "function") run.stop().catch(() => {});      // its relay has nothing to carry
      this.#reclaim(rec.id, "the domain stopped answering");
      failed++;
    }
    return { checked, failed };
  }

  async remove(id) {
    const r = this.domains.get(id);
    // UNKNOWN IS NOT ABSENT (63's P1): only a manager that has surveyed Hyper-V may say an id is gone.
    if (!r) {
      if (!this.inventoryReady) throw unavailable(this.inventory);
      if (!this.mayAnswerAbsent(id)) throw unattributedUnknown(id, this.unattributed());
      return { removed: false, absent: true };
    }
    this.#stopping.add(r);
    try {
      await this.backend.stop(r.handle);
    } catch (e) {
      r.status = "failed";
      r.reason = `stop failed, so this domain may still be RUNNING and is deliberately still listed: ${e.message}`;
      const err = new Error(r.reason); err.status = 500; err.id = id; throw err;
    }
    r.status = "stopped";
    this.domains.delete(id);
    this.removedIds.add(id);
    // AFTER the stop is confirmed, never before: closing sessions for a domain that is still
    // running would cut live traffic to something that is still there.
    this.#reclaim(id, "removed");
    return { removed: true, absent: false };
  }
}

/**
 * THE STARTUP SEQUENCE, in one place so main.mjs and the restart regression (63's
 * test/windows-isolation-manager-restart.test.mjs) boot a manager identically: ask the host what it
 * can do, then rebuild the inventory from Hyper-V before any /vms answer means anything.
 */
export async function startManager(manager) {
  await manager.probe();
  return await manager.recover();
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function unattributedUnknown(id, orphans) {
  const e = new Error(`${id} is not a known instance, but ${orphans.length} VM(s) on this host are ours and name no deployment `
    + `(${orphans.map((r) => r.id).join(", ")}): this may be one of them, so its absence cannot be asserted`);
  e.status = 503; e.unattributed = orphans.map((r) => r.id); return e;
}
function unavailable(inv) {
  const e = new Error(inv && inv.state === "failed" ? `the inventory is unavailable: ${inv.error}`
                                                    : "the manager has not yet surveyed Hyper-V, so it cannot say what exists");
  e.status = 503; e.inventory = inv; return e;
}

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
      // Until the inventory is known every /vms answer is 503: "not listed" must never read as "absent".
      if (p.startsWith("/vms") && !manager.inventoryReady)
        return send(503, { error: "inventory_unavailable", inventory: manager.inventory, managerEpoch: manager.epoch });
      if (req.method === "GET" && p === "/vms") return send(200, { vms: manager.list(), managerEpoch: manager.epoch });
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
      if (m && req.method === "GET") {
        const r = manager.get(decodeURIComponent(m[1]));
        if (r) return send(200, r);
        // "not found" only when absence can be asserted; otherwise it is UNKNOWN (an unattributed VM exists)
        if (!manager.mayAnswerAbsent(decodeURIComponent(m[1])))
          return send(503, { error: "unknown_while_unattributed", unattributed: manager.unattributed().map((x) => x.id), managerEpoch: manager.epoch });
        return send(404, { error: "not_found" });
      }
      if (m && req.method === "DELETE") {
        const id = decodeURIComponent(m[1]);
        try {
          const r = await manager.remove(id);
          return r.absent ? send(404, { error: "not_found" }) : send(200, { ok: true });
        } catch (e) {
          if (e.status === 503) return send(503, { error: e.message, inventory: e.inventory ?? manager.inventory,
                                                   ...(e.unattributed ? { unattributed: e.unattributed } : {}), managerEpoch: manager.epoch });
          // a stop that failed is NOT a removal: say so with the domain still listed
          return send(e.status || 500, { error: e.message, id: e.id ?? id, stillListed: true });
        }
      }
      return send(404, { error: "not_found" });
    } catch (e) { return send(500, { error: e.message }); }
  });
}
