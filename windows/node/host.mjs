// windows/node/host.mjs -- the Windows consumer node's host half: it holds a lease on the ledger
// and runs that deployment's app, and it answers the platform's host surface over the tunnel.
//
// Scope, deliberately narrow (see chain.mjs claimPolicy for the reasons, they are hard ones):
// OWNER-ONLY and PUBLIC-ONLY. It claims a deployment only when the ledger says its owner is the
// wallet this box declares as its payout wallet, it is public, it asks for no GPU share, and it
// carries no option (WAF, secrets, a CID-borne envelope) this box does not enforce. It never
// advertises claimEnabled, so it stays out of the relay's serving set and cannot collapse a
// fleet-AND capability flag or the fleet's minimum-spec numbers for everybody else.
//
// The app runs in VTL0 under wasmtime, NOT in the enclave (apprun.mjs says why). The enclave keeps
// the model; an app's inference goes to it over loopback, so the untrusted card still only ever
// sees masked activations.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import * as chain from "./chain.mjs";
import { App, fetchArtifact, wasmLayer, appEnv } from "./apprun.mjs";

const HEARTBEAT_MS = 10 * 60_000;
const TICK_MS = 30_000;
const PROOF_MS = 5 * 60_000;         // the contract's window is 15 min; the platform proves every 5
const RENEW_LEAD_MS = 5 * 60_000;    // renew this long before the lease ends

export class Host {
  constructor(cfg) {
    this.cfg = cfg;                                  // { dir, endpoint, name, appsEnabled, ownerWallet, cpuPricePerSec6, vcpus, ramGb, wasmtime, python, gateway, portBase, inferenceUrl, log }
    this.log = cfg.log || (() => {});
    this.apps = new Map();                           // id -> App
    this.records = new Map();                        // id -> { id, status, reason, appRef, cid, version, leaseUntil, claimedAt, provenAt }
    this.enclaveId = chain.enclaveIdOf(cfg.endpoint);
    this.registered = null;                          // the registry entry as last read
    this.chainReady = false; this.lastError = "";
    this.statePath = path.join(cfg.dir, "host-state.json");
    this.tracked = new Set(this.#loadTracked());
  }
  #loadTracked() {
    try { return JSON.parse(fs.readFileSync(this.statePath, "utf8")).tracked || []; } catch { return []; }
  }
  #saveTracked() {
    try { fs.writeFileSync(this.statePath, JSON.stringify({ tracked: [...this.tracked] }, null, 1)); } catch {}
  }

  async init() {
    try {
      await chain.resolveAddresses();
      chain.loadOperator(path.join(this.cfg.dir, "operator.key"));
      chain.loadProofKey(path.join(this.cfg.dir, "proof.key"));
      this.chainReady = true;
      const op = chain.operatorAddress();
      this.log(`chain: registry ${chain.addresses.registry} · deployments ${chain.addresses.deployments}`);
      if (op) {
        const wei = await chain.operatorBalance();
        this.log(`operator ${op} holds ${(Number(wei) / 1e18).toFixed(6)} ETH; enclave id ${this.enclaveId}`);
        if (wei === 0n) this.log("operator has no gas: it can read the ledger but cannot register, claim, renew or prove");
      } else this.log("no operator key on this box: it can run an app it is told about, but cannot hold a lease");
      await this.refreshRegistration();
      await this.ensureRegistered();
    } catch (e) { this.lastError = e.message; this.log(`chain unavailable: ${e.message}`); }
    setInterval(() => this.tick().catch((e) => this.log(`tick: ${e.message}`)), TICK_MS);
    setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_MS);
    setInterval(() => this.proveAll().catch((e) => this.log(`proof: ${e.message}`)), PROOF_MS);
    this.tick().catch(() => {});
  }
  async refreshRegistration() {
    try {
      const e = await chain.readEnclave(this.enclaveId);
      this.registered = e && e.endpoint ? e : null;
      if (this.registered) this.log(`registry: listed as ${e.endpoint} price ${e.cpuPricePerSec6}/sec, payout ${e.payoutWallet}`);
    } catch (e) { this.lastError = e.message; }
  }
  /** The wallet whose deployments this box will run: the on-chain declaration, else the config. */
  ownerAllow() {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const declared = this.registered && this.registered.payoutWallet && this.registered.payoutWallet !== ZERO ? this.registered.payoutWallet : null;
    return declared || this.cfg.ownerWallet || null;
  }
  /**
   * Put this box on the registry, or keep its entry current. The entry is what gives the box an
   * id (keccak of the endpoint) for a lease to name, and claim() refuses an entry with no price or
   * no proof key. The measurement published here is the VBS enclave's own identity key, so anyone
   * can compare the row against what the relay verified at attach.
   */
  async ensureRegistered() {
    if (!this.chainReady || !this.cfg.appsEnabled || !chain.operatorAddress()) return;
    const proofKey = chain.proofAddress() || "0x0000000000000000000000000000000000000000";
    const priced = this.registered && Number(this.registered.cpuPricePerSec6) > 0;
    const current = priced && this.registered.active
      && String(this.registered.proofKey).toLowerCase() === proofKey.toLowerCase()
      && String(this.registered.operator).toLowerCase() === String(chain.operatorAddress()).toLowerCase();
    if (current) return;
    if (this.registered && String(this.registered.operator).toLowerCase() !== String(chain.operatorAddress()).toLowerCase()
        && String(this.registered.operator) !== "0x0000000000000000000000000000000000000000") {
      this.log(`registry: ${this.cfg.endpoint} belongs to operator ${this.registered.operator}, not this box's key; refusing to re-register`);
      return;
    }
    const wei = await chain.operatorBalance();
    if (wei === 0n) { if (!this._gasNagged) { this._gasNagged = true; this.log(`registry: ${chain.operatorAddress()} has no gas; send it a little Base ETH and this box registers itself`); } return; }
    try {
      const { id, hash } = await chain.registerBox({ endpoint: this.cfg.endpoint, repo: this.cfg.repo || "EnclaveHost/enclave",
        measurement: this.cfg.measurement || "0x0000000000000000000000000000000000000000000000000000000000000000",
        cpuPricePerSec6: this.cfg.cpuPricePerSec6, proofKey });
      this.log(`registry: registered ${this.cfg.endpoint} id=${id} price=${this.cfg.cpuPricePerSec6}/sec proofKey=${proofKey} tx=${hash}`);
      await this.refreshRegistration();
    } catch (e) { this.log(`registry: register failed: ${e.shortMessage || e.message}`); }
  }
  async heartbeat() {
    if (!this.chainReady || !chain.operatorAddress() || !this.registered) return;
    try { await chain.heartbeatBox(this.enclaveId); } catch (e) { this.log(`heartbeat failed: ${e.shortMessage || e.message}`); }
    await this.warnLowGas();
  }
  /**
   * Gas runs the lease. A renewal costs about 60k gas (measured: 0.00000036 ETH on Base), a
   * heartbeat and a claim more, so an empty tank does not fail loudly, it just stops renewing and
   * the app quietly goes away at the end of the quantum. Warn while there is still time to top up.
   */
  async warnLowGas() {
    const wei = await chain.operatorBalance().catch(() => null);
    if (wei === null) return;
    const renews = wei / 400000000000n;                  // ~1 renewal's gas, rounded up
    const low = renews < 200n;                           // roughly four days of renewals
    if (low && Date.now() - (this._gasWarnedAt || 0) > 3600_000) {
      this._gasWarnedAt = Date.now();
      this.log(`operator gas is low: ${(Number(wei) / 1e18).toFixed(6)} ETH, about ${renews} renewals left. Top up ${chain.operatorAddress()}`);
    }
    this.gasRenewals = Number(renews);
  }

  /** Consider a deployment: the policy first, then the chain, then the app. */
  async consider(id, { force = false } = {}) {
    id = String(id).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };
    if (!this.chainReady) return { accepted: false, reason: `chain unavailable: ${this.lastError}` };
    let d; try { d = await chain.readDeployment(id); } catch (e) { return { accepted: false, reason: `ledger read failed: ${e.shortMessage || e.message}` }; }
    const refuse = chain.claimPolicy(d, { ownerAllow: this.ownerAllow(), enclaveId: this.enclaveId, appsEnabled: this.cfg.appsEnabled });
    if (refuse) { this.#record(id, { status: "refused", reason: refuse, appRef: d?.appRef || "" }); return { accepted: false, reason: refuse }; }
    this.tracked.add(id); this.#saveTracked();
    const ours = String(d.runner || "").toLowerCase() === this.enclaveId.toLowerCase();
    const live = Number(d.leaseUntil) * 1000 > Date.now();
    if (!(ours && live)) {
      if (!chain.operatorAddress()) { this.#record(id, { status: "queued", reason: "no operator key on this box: cannot claim", appRef: d.appRef }); return { accepted: false, reason: "no operator key on this box" }; }
      if (!this.registered) { this.#record(id, { status: "queued", reason: "this box is not registered on the ledger yet", appRef: d.appRef }); return { accepted: false, reason: "not registered" }; }
      try {
        this.#record(id, { status: "claiming", appRef: d.appRef });
        const hash = await chain.claimDeployment(id, this.enclaveId);
        this.#record(id, { claimedAt: Date.now(), claimTx: hash });
        this.log(`claimed ${id.slice(0, 10)} (tx ${hash})`);
        d = await chain.readDeployment(id);
      } catch (e) {
        const reason = `claim failed: ${e.shortMessage || e.message}`;
        this.#record(id, { status: "failed", reason, appRef: d.appRef }); return { accepted: false, reason };
      }
    }
    await this.ensureApp(id, d, { force });
    return { accepted: true, status: this.records.get(id)?.status || "unknown" };
  }

  /** Fetch + verify + run the deployment's app, and keep the record honest about which stage failed. */
  async ensureApp(id, d, { force = false } = {}) {
    const rec = this.#record(id, { appRef: d.appRef, leaseUntil: Number(d.leaseUntil), cpuShare: Number(d.cpuMilli) / 1000 });
    let v;
    try { v = await chain.resolveAppRef(d.appRef); } catch (e) { return this.#record(id, { status: "failed", reason: `catalog: ${e.message}` }); }
    if (v.yanked) return this.#record(id, { status: "failed", reason: "the catalog version is yanked" });
    this.#record(id, { cid: v.cid, version: v.version, memMb: Number(v.memMb) || 512 });
    let art;
    try { art = await fetchArtifact({ cid: v.cid, dir: path.join(this.cfg.dir, "apps"), python: this.cfg.python, gateway: this.cfg.gateway, log: (m) => this.log(m) }); }
    catch (e) { return this.#record(id, { status: "failed", reason: `artifact: ${e.message}` }); }
    try {
      const layer = wasmLayer(art.path);
      if (layer !== 1) return this.#record(id, { status: "failed", reason: `the artifact is a core wasm module (layer ${layer}), not a wasi:http component` });
    } catch (e) { return this.#record(id, { status: "failed", reason: `artifact: ${e.message}` }); }
    let app = this.apps.get(id);
    if (app && force) { await app.stop(); this.apps.delete(id); app = null; }
    if (!app) {
      const port = this.cfg.portBase + (this.apps.size % 64);
      const memMb = Number(v.memMb) || 512;
      app = new App({ id, wasmtime: this.cfg.wasmtime, wasmPath: art.path, port, memMb,
                      allowHttp: true, dir: this.cfg.dir, log: (m) => this.log(m),
                      env: appEnv({ config: this.appConfig(d, v), memMb, inferenceUrl: this.cfg.inferenceUrl }) });
      this.apps.set(id, app);
    }
    if (app.state !== "running") {
      this.#record(id, { status: "provisioning" });
      try { await app.start(); } catch (e) { return this.#record(id, { status: "failed", reason: `app: ${e.message}` }); }
    }
    return this.#record(id, { status: "running", reason: null, port: app.port });
  }

  /** The app's config: the catalog version's, replaced by the deployment's override when it has one. */
  appConfig(d, v) {
    const env = String(d?.configCid || "").trim();
    if (env.startsWith("{")) {
      try { const o = JSON.parse(env); if (o && o.config !== undefined) return JSON.stringify(o.config); } catch {}
    }
    return String(v?.config || "");
  }
  #record(id, patch) {
    const cur = this.records.get(id) || { id, status: "unknown", reason: null };
    const rec = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, rec);
    return rec;
  }

  /** Find the owner's deployments on the ledger and take the ones this box may run. */
  async scanLedger() {
    const owner = this.ownerAllow();
    if (!this.cfg.appsEnabled || !owner || !this.registered || !chain.operatorAddress()) return;
    let rows; try { rows = await chain.allDeployments(); } catch (e) { this.log(`ledger scan failed: ${e.shortMessage || e.message}`); return; }
    const mine = rows.filter((d) => String(d.owner).toLowerCase() === String(owner).toLowerCase() && d.active);
    if (mine.length && !this._sawLedger) { this.log(`ledger: ${mine.length} deployment(s) owned by ${owner}`); this._sawLedger = true; }
    for (const d of mine) {
      const id = String(d.id).toLowerCase();
      const rec = this.records.get(id);
      if (rec && ["running", "provisioning", "claiming"].includes(rec.status)) continue;
      const ours = String(d.runner || "").toLowerCase() === this.enclaveId.toLowerCase();
      const live = Number(d.leaseUntil) * 1000 > Date.now();
      if (!ours && live && !/^0x0+$/.test(String(d.runner || ""))) continue;   // somebody else is running it
      const refuse = chain.claimPolicy(d, { ownerAllow: owner, enclaveId: this.enclaveId, appsEnabled: true });
      if (refuse) { if (!rec || rec.reason !== refuse) this.#record(id, { status: "refused", reason: refuse, appRef: d.appRef }); continue; }
      this.log(`ledger: taking ${id.slice(0, 10)} (${d.appRef})`);
      await this.consider(id).catch((e) => this.log(`consider ${id.slice(0, 10)}: ${e.message}`));
    }
  }
  async tick() {
    if (!this.chainReady) return;
    if (!this.registered) await this.refreshRegistration();
    await this.ensureRegistered().catch((e) => this.log(`register: ${e.message}`));
    await this.scanLedger().catch(() => {});
    for (const id of [...this.tracked]) {
      let d; try { d = await chain.readDeployment(id); } catch { continue; }
      const rec = this.records.get(id) || this.#record(id, {});
      const runner = String(d.runner || "").toLowerCase();
      const unclaimed = /^0x0+$/.test(runner);
      const ours = runner === this.enclaveId.toLowerCase();
      const untilMs = Number(d.leaseUntil) * 1000;
      const leaseLive = untilMs > Date.now();
      if (!d.active) { await this.#stopApp(id, "the deployment was stopped on the ledger"); continue; }
      // Somebody else really does hold it: stand down. Only a LIVE lease held by a DIFFERENT,
      // non-zero runner counts, because the other two readings are not that.
      if (!ours && !unclaimed && leaseLive) { await this.#stopApp(id, `another enclave holds the lease (${runner.slice(0, 10)})`); continue; }
      // Not ours and nobody's: claim it (or re-claim a lapsed one) rather than tearing the app
      // down. A public RPC can be a block or two behind our own claim receipt, and reading that
      // as "another enclave holds the lease" stopped a freshly started app within a second of
      // claiming it. The receipt is the truth; give the reads two minutes to catch up.
      if (!ours) {
        if (rec.claimedAt && Date.now() - rec.claimedAt < 120_000) continue;
        await this.consider(id).catch((e) => this.log(`re-claim ${id.slice(0, 10)}: ${e.message}`));
        continue;
      }
      if (untilMs - Date.now() < RENEW_LEAD_MS) {
        try { await chain.renewDeployment(id); this.log(`renewed ${id.slice(0, 10)}`); d = await chain.readDeployment(id); }
        catch (e) {
          const msg = e.shortMessage || e.message;
          this.#record(id, { reason: `renew failed: ${msg}` });
          if (untilMs < Date.now()) { await this.#stopApp(id, `the lease expired and renew failed: ${msg}`); continue; }
        }
      }
      this.#record(id, { leaseUntil: Number(d.leaseUntil), rate6: String(d.rate), balance6: String(d.balance6), cpuShare: Number(d.cpuMilli) / 1000 });
      const app = this.apps.get(id);
      if (!app || app.state !== "running") await this.ensureApp(id, d);
    }
  }
  async #stopApp(id, why) {
    const app = this.apps.get(id);
    if (app) { await app.stop(); this.apps.delete(id); }
    this.#record(id, { status: "stopped", reason: why });
    this.tracked.delete(id); this.#saveTracked();
    this.log(`stopped ${id.slice(0, 10)}: ${why}`);
  }
  /** A checkpoint per live lease whose app answers right now. */
  async proveAll() {
    if (!this.chainReady || !chain.proofAddress() || !this.registered) return;
    for (const [id, app] of this.apps) {
      const rec = this.records.get(id);
      if (!rec || rec.status !== "running" || !rec.leaseUntil) continue;
      // A checkpoint earns the runner its lease seconds. At rate 0 (a free self-hosted lease:
      // _hostRate returns 0 when the box's payout wallet owns the deployment) there is nothing to
      // earn and nothing to meter, so proving it would spend this box's gas, every five minutes,
      // to move a number that is multiplied by zero. It is skipped and said, not silently dropped.
      if (rec.rate6 !== undefined && BigInt(rec.rate6 || 0) === 0n) {
        if (!this._freeProofSaid) { this._freeProofSaid = true; this.log(`no checkpoints for ${id.slice(0, 10)}: a free lease (rate 0) has nothing to credit`); }
        continue;
      }
      if (!(await app.alive())) { this.log(`no checkpoint for ${id.slice(0, 10)}: the app did not answer`); continue; }
      const upto = Math.min(Math.floor(Date.now() / 1000), Number(rec.leaseUntil));
      try { await chain.checkpoint({ id, enclaveId: this.enclaveId, upto }); this.#record(id, { provenAt: upto }); }
      catch (e) { this.log(`checkpoint ${id.slice(0, 10)} failed: ${e.shortMessage || e.message}`); }
    }
  }

  // ---- the surface the relay and the console call, over the tunnel -------------------------
  deployments() { return [...this.records.values()].map((r) => ({ ...r })); }
  /** The node pool this box has left, as a fraction: what the relay's placement reads. */
  cpuShareFree() {
    if (!this.cfg.appsEnabled) return 0;
    const used = [...this.records.values()].filter((r) => r.status === "running").reduce((a, r) => a + (r.cpuShare || 0), 0);
    return Math.max(0, Math.min(1, 1 - used - (this.cfg.reservedShare ?? 0.25)));   // a quarter stays for the enclave, the worker and the owner
  }
  /** What this box adds to /availability. It never claims claimEnabled (see the header). */
  availability() {
    const running = [...this.apps.values()].filter((a) => a.state === "running").length;
    return {
      apps: {
        // Where a hosted app runs, in the one word that matters. The relay's teeCpu describes the
        // enclave that holds the MODEL; an app is a wasm component under wasmtime in VTL0 and the
        // owner of this PC can read its memory. Never report this as a TEE.
        isolation: "host-process", inTee: false, runtime: "wasmtime", world: "wasi:http",
        scope: "owner-only", public: true, running, capacity: this.cfg.appSlots ?? 4,
        note: "apps run on the Windows host, not inside the VBS enclave; the enclave holds the model and the pads",
      },
      claimScope: "owner-only",                 // deliberately NOT claimEnabled: this box takes no work from the market
      askCpuPricePerSec6: this.cfg.cpuPricePerSec6,
      enclaveId: this.enclaveId,
      registered: !!this.registered,
      operator: chain.operatorAddress() || null,
      gasRenewalsLeft: this.gasRenewals ?? null,   // an operator key out of gas stops renewing, and the app goes at the end of its quantum

      proofKey: chain.proofAddress() || null,
      ownerWallet: this.ownerAllow(),
    };
  }
  /**
   * Run an app by catalog reference or CID with NO lease behind it. This is a bring-up and proof
   * path for the box's owner, reachable only on the loopback surface (agent.mjs never routes it
   * from the tunnel), and every record it makes says `leased: false` so nothing here can be
   * mistaken for a deployment the ledger knows about.
   */
  async runUnleased({ appRef, cid, id }) {
    if (!this.cfg.appsEnabled) throw new Error("apps are not enabled on this node (APPS=1)");
    let v = null;
    if (appRef) { v = await chain.resolveAppRef(appRef); cid = v.cid; }
    if (!cid) throw new Error("give appRef (catalog://<appId>/<index>) or cid");
    const key = String(id || `local-${cid.slice(-12)}`).toLowerCase();
    const art = await fetchArtifact({ cid, dir: path.join(this.cfg.dir, "apps"), python: this.cfg.python, gateway: this.cfg.gateway, log: (m) => this.log(m) });
    const layer = wasmLayer(art.path);
    if (layer !== 1) throw new Error(`the artifact is a core wasm module (layer ${layer}), not a wasi:http component`);
    let app = this.apps.get(key);
    if (app) { await app.stop(); this.apps.delete(key); }
    const memMb = Number(v?.memMb) || 512;
    const port = this.cfg.portBase + 32 + (this.apps.size % 16);
    app = new App({ id: key, wasmtime: this.cfg.wasmtime, wasmPath: art.path, port, memMb, allowHttp: true,
                    dir: this.cfg.dir, log: (m) => this.log(m),
                    env: appEnv({ config: String(v?.config || ""), memMb, inferenceUrl: this.cfg.inferenceUrl }) });
    this.apps.set(key, app);
    this.#record(key, { status: "provisioning", leased: false, appRef: appRef || null, cid, version: v?.version || null, memMb });
    await app.start();
    return this.#record(key, { status: "running", reason: null, port: app.port, leased: false });
  }

  /** Proxy an /x/:id/... request to that deployment's app. */
  async proxy(id, { method, pathRest, headers, body }) {
    const app = this.apps.get(String(id).toLowerCase());
    if (!app || app.state !== "running") return { status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not_running", id, state: app?.state || "unknown", reason: this.records.get(String(id).toLowerCase())?.reason || null }) };
    const hdrs = {};
    for (const [k, v] of Object.entries(headers || {})) if (!/^host$|^connection$|^x-metal-|^x-enclave-/i.test(k)) hdrs[k] = v;
    return await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: app.port, method: method || "GET", path: pathRest || "/", headers: { ...hdrs, host: `127.0.0.1:${app.port}` } }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode || 502, headers: r.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(120_000, () => { req.destroy(new Error("app timed out")); });
      req.on("error", (e) => resolve({ status: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "app_unreachable", message: e.message }) }));
      if (body && body.length) req.write(body);
      req.end();
    });
  }
}
