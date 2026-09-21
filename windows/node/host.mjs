// windows/node/host.mjs -- the Windows consumer node's host half: it holds a lease on the ledger
// and runs that deployment's app, and it answers the platform's host surface over the tunnel.
//
// Scope (see chain.mjs claimPolicy for each refusal and its reason): PUBLIC deployments, on CORES,
// whose options this box actually enforces, that FIT in what it has left to sell. In the default
// "market" scope that means any wallet's, which is what being a listed enclave means; CLAIM_SCOPE=
// owner-only narrows it back to the box owner's own for bring-up.
//
// It advertises `claimEnabled: true` (it takes work) with `fullService: false` (it sells a subset
// of the platform's features). The relay keeps a partial box out of the fleet-AND capability flags,
// the minimum-spec numbers and the default price, so being listed here cannot take a feature away
// from another customer or make this box the platform's price - see fullServiceEnclaves() in
// relay/api-relay.js and test/fleet-partial-capability.test.mjs.
//
// The app runs in VTL0 under wasmtime, NOT in the enclave (apprun.mjs says why). The enclave keeps
// the model; an app's inference goes to it over loopback, so the untrusted card still only ever
// sees masked activations.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import * as chain from "./chain.mjs";
import { App, fetchArtifact, wasmLayer, appEnv, missingHostInterfaces } from "./apprun.mjs";

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
    const st = this.#loadState();
    this.tracked = new Set(st.tracked || []);
    // Work this box GAVE BACK, and why. It survives a restart on purpose: a claim costs gas and a
    // lease takes a deployment off the market, so a box that has already found out it cannot run
    // an app must not rediscover that every 30 seconds for as long as the row is on the ledger.
    // An operator or the console can clear an entry by forcing the claim (/v1/claim-hint force).
    this.blocked = new Map(Object.entries(st.blocked || {}));
  }
  #loadState() {
    try { return JSON.parse(fs.readFileSync(this.statePath, "utf8")) || {}; } catch { return {}; }
  }
  #saveTracked() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify({ tracked: [...this.tracked],
        blocked: Object.fromEntries(this.blocked) }, null, 1));
    } catch {}
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

  /** When this box's registry entry was created: the date its disclosure became visible. */
  listedAt() { return Number(this.registered?.registeredAt || 0); }

  /**
   * Consider a deployment: the policy first, then the chain, then the app.
   * `invited` is the deploy console's target pick arriving as a claim hint that names this box -
   * the buyer choosing it, which is the consent the policy looks for on an older deployment.
   */
  async consider(id, { force = false, invited = false } = {}) {
    id = String(id).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };
    if (!this.chainReady) return { accepted: false, reason: `chain unavailable: ${this.lastError}` };
    if (this.blocked.has(id)) {
      if (!force) {
        const reason = this.blocked.get(id);
        this.#record(id, { status: "failed", reason });
        return { accepted: false, reason };
      }
      // Forced: the operator is saying try again (a new version, a fixed runtime, a wiped cache).
      this.blocked.delete(id); this.#saveTracked();
      this.log(`unblocking ${id.slice(0, 10)}: a forced claim overrides "${this.records.get(id)?.reason || "an earlier failure"}"`);
    }
    let d; try { d = await chain.readDeployment(id); } catch (e) { return { accepted: false, reason: `ledger read failed: ${e.shortMessage || e.message}` }; }
    // The catalog version is read BEFORE the policy, not after: two of the policy's answers live
    // in the version config and nowhere else - the publisher's `gpuOptional` (may a card-dialled
    // app run on cores) and their `cpuFallback` (how much node RAM it needs when it does). A
    // catalog read that fails leaves them undeclared, which fails closed in both cases.
    let v = null;
    try { v = await chain.resolveAppRef(d.appRef); } catch (e) { this.#record(id, { reason: `catalog: ${e.message}` }); }
    const refuse = chain.claimPolicy(d, { ownerAllow: this.ownerAllow(), enclaveId: this.enclaveId,
                                          appsEnabled: this.cfg.appsEnabled, scope: this.scope(),
                                          version: v, capacity: this.capacity(),
                                          listedAt: this.listedAt(), invited: invited || force });
    if (refuse) { this.#record(id, { status: "refused", reason: refuse, appRef: d?.appRef || "" }); return { accepted: false, reason: refuse }; }
    this.tracked.add(id); this.#saveTracked();
    const ours = String(d.runner || "").toLowerCase() === this.enclaveId.toLowerCase();
    const live = Number(d.leaseUntil) * 1000 > Date.now();
    if (!(ours && live)) {
      if (!chain.operatorAddress()) { this.#record(id, { status: "queued", reason: "no operator key on this box: cannot claim", appRef: d.appRef }); return { accepted: false, reason: "no operator key on this box" }; }
      if (!this.registered) { this.#record(id, { status: "queued", reason: "this box is not registered on the ledger yet", appRef: d.appRef }); return { accepted: false, reason: "not registered" }; }
      // Ask the ledger whether IT would let this box claim, before spending gas finding out. It is
      // the authority on the two things this box cannot see in a record: whether the deployment's
      // rate cap covers what this box's registry entry charges, and whether the balance covers a
      // quantum at that rate. A reverted claim costs nothing but says nothing either, and a tenant
      // reading "Queued" deserves the reason.
      try {
        const ok = await chain.claimableBy(id, this.enclaveId);
        if (!ok) {
          const reason = "the ledger will not let this box claim it: its rate cap, its funded balance or a live lease says no"
            + ` (this box charges ${this.cfg.cpuPricePerSec6}/sec per whole node, ${Math.round(Number(d.cpuMilli) / 10)}% of it here)`;
          this.#record(id, { status: "queued", reason, appRef: d.appRef });
          return { accepted: false, reason };
        }
      } catch (e) { this.log(`claimableBy ${id.slice(0, 10)}: ${e.shortMessage || e.message}`); }
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
    await this.ensureApp(id, d, { force, version: v });
    return { accepted: true, status: this.records.get(id)?.status || "unknown" };
  }

  /** Fetch + verify + run the deployment's app, and keep the record honest about which stage failed. */
  async ensureApp(id, d, { force = false, version = null } = {}) {
    const rec = this.#record(id, { appRef: d.appRef, leaseUntil: Number(d.leaseUntil), cpuShare: Number(d.cpuMilli) / 1000 });
    let v = version;
    if (!v) try { v = await chain.resolveAppRef(d.appRef); } catch (e) { return this.#record(id, { status: "failed", reason: `catalog: ${e.message}` }); }
    if (v.yanked) return await this.#giveUp(id, "the catalog version is yanked");
    // The CORELESS floor, which is the only kind this box does: the version's own memMb, raised by
    // the publisher's cpuFallback when they declared one. Sizing a fallback off the card-case
    // figure is how a big model lands on a small slice and dies at weight-load with nothing having
    // said no, so the guest's memory cap is the larger number.
    const floor = chain.nodeFloorOf(v);
    this.#record(id, { cid: v.cid, version: v.version, memMb: floor.memMb, cpuFallbackSized: floor.fromFallback });
    let art;
    try { art = await fetchArtifact({ cid: v.cid, dir: path.join(this.cfg.dir, "apps"), python: this.cfg.python, gateway: this.cfg.gateway, log: (m) => this.log(m) }); }
    catch (e) { return this.#record(id, { status: "failed", reason: `artifact: ${e.message}` }); }
    try {
      const layer = wasmLayer(art.path);
      if (layer !== 1) return await this.#giveUp(id, `the artifact is a core wasm module (layer ${layer}), not a wasi:http component`);
      // What the artifact needs from its runtime, checked BEFORE it is launched: an app built
      // against the platform's patched wasmtime (wasi-nn inference, guest threads) cannot run
      // here, and finding that out by watching it restart while holding the lease is the worst
      // of the available orders.
      const needs = missingHostInterfaces(art.path);
      if (needs.length) return await this.#giveUp(id, `this box cannot run it: the artifact needs ${needs.join(" and ")}. It runs stock wasmtime 49 and carries no model volume; the enclave's own model is reachable at ENCLAVE_INFERENCE_URL instead, which is a different contract`);
    } catch (e) { return this.#record(id, { status: "failed", reason: `artifact: ${e.message}` }); }
    let app = this.apps.get(id);
    if (app && force) { await app.stop(); this.apps.delete(id); app = null; }
    if (!app) {
      const port = this.cfg.portBase + (this.apps.size % 64);
      const memMb = floor.memMb;
      app = new App({ id, wasmtime: this.cfg.wasmtime, wasmPath: art.path, port, memMb,
                      allowHttp: true, dir: this.cfg.dir, log: (m) => this.log(m),
                      env: appEnv({ config: this.appConfig(d, v), memMb, inferenceUrl: this.cfg.inferenceUrl }) });
      this.apps.set(id, app);
    }
    if (app.state !== "running") {
      this.#record(id, { status: "provisioning" });
      try { await app.start(); }
      catch (e) {
        // Three goes, then the lease goes back. A start that keeps failing is not always this
        // box's fault (a port, a cold cache, a bad artifact), but holding a lease through it
        // keeps the deployment off every other enclave while its balance drains.
        const tries = (this.records.get(id)?.startTries || 0) + 1;
        this.#record(id, { status: "failed", reason: `app: ${e.message}`, startTries: tries });
        if (tries >= 3) return await this.#giveUp(id, `it would not start after ${tries} tries: ${e.message}`);
        return this.records.get(id);
      }
    }
    return this.#record(id, { status: "running", reason: null, port: app.port, startTries: 0 });
  }

  /**
   * The app's config: the catalog version's, replaced by the deployment's override when it carries
   * one. Through the same parser the claim policy used, so the config that reaches the guest is
   * the one the policy accepted and nothing else - a second, looser reading of the same field is
   * how a runner ends up honouring an option it told the tenant it had refused.
   */
  appConfig(d, v) {
    try {
      const opts = chain.parseEnvelope(d?.configCid, d?.gpuMilli);
      if (opts.config !== undefined) return JSON.stringify(opts.config);
    } catch { /* the policy already refused it; the version's own config stands */ }
    return String(v?.config || "");
  }
  #record(id, patch) {
    const cur = this.records.get(id) || { id, status: "unknown", reason: null };
    const rec = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, rec);
    return rec;
  }

  /**
   * Read the ledger and take the work this box may run.
   *
   * In "market" scope that is any wallet's public, coreless, option-compatible deployment that
   * fits in what this box has left; in "owner-only" it is the box owner's alone. An unclaimed row
   * is the platform's Queued state, so this scan IS how a deployment reaches this box - nobody
   * pushes work at a runner.
   *
   * ONE new claim per pass. A claim costs gas and a lease commits capacity, and a scan that took
   * every row it liked at once would spend both before the first app had proved it starts.
   */
  async scanLedger() {
    const owner = this.ownerAllow();
    const scope = this.scope();
    if (!this.cfg.appsEnabled || !this.registered || !chain.operatorAddress()) return;
    if (scope === "owner-only" && !owner) return;
    let rows; try { rows = await chain.allDeployments(); } catch (e) { this.log(`ledger scan failed: ${e.shortMessage || e.message}`); return; }
    const isOwners = (d) => owner && String(d.owner).toLowerCase() === String(owner).toLowerCase();
    const pool = rows.filter((d) => d.active && (scope === "market" ? d.isPublic : isOwners(d)));
    if (pool.length && !this._sawLedger) {
      this._sawLedger = true;
      this.log(`ledger: ${pool.length} active deployment(s) in scope (${scope})`);
    }
    // Ours first (a lease already held is work in progress), then this box owner's own, then the
    // market oldest-first: a queue, not a cherry-pick.
    const ourId = this.enclaveId.toLowerCase();
    const rank = (d) => (String(d.runner || "").toLowerCase() === ourId ? 0 : isOwners(d) ? 1 : 2);
    pool.sort((a, b) => rank(a) - rank(b) || Number(a.createdAt) - Number(b.createdAt));
    let claimed = 0;
    for (const d of pool) {
      const id = String(d.id).toLowerCase();
      if (this.blocked.has(id)) continue;                  // already tried, already handed back
      const rec = this.records.get(id);
      if (rec && ["running", "provisioning", "claiming"].includes(rec.status)) continue;
      const ours = String(d.runner || "").toLowerCase() === ourId;
      const live = Number(d.leaseUntil) * 1000 > Date.now();
      if (!ours && live && !/^0x0+$/.test(String(d.runner || ""))) continue;   // somebody else is running it
      if (!ours && claimed >= 1) continue;
      let v = null; try { v = await chain.resolveAppRef(d.appRef); } catch {}
      const refuse = chain.claimPolicy(d, { ownerAllow: owner, enclaveId: this.enclaveId, appsEnabled: true,
                                            scope, version: v, capacity: this.capacity(), listedAt: this.listedAt() });
      if (refuse) {
        // Recorded, not logged every 30 seconds: a refusal is a standing fact about a row, and
        // the console reads it off /v1/deployments. Only a CHANGE is worth a line.
        if (!rec || rec.reason !== refuse) { this.#record(id, { status: "refused", reason: refuse, appRef: d.appRef }); this.log(`ledger: not taking ${id.slice(0, 10)}: ${refuse}`); }
        continue;
      }
      if (!ours) claimed++;
      this.log(`ledger: taking ${id.slice(0, 10)} (${d.appRef}, owner ${d.owner}, ${Math.round(Number(d.cpuMilli) / 10)}% of a node)`);
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
          // rateCap doctrine (the platform runner's, mirrored): a renew the LEDGER refuses is not
          // an error to retry, it is the deployment's own rate cap or its balance saying "this is
          // the last quantum". Say when the app goes rather than retrying until it vanishes.
          const msg = e.shortMessage || e.message;
          const ends = new Date(untilMs).toISOString().replace("T", " ").slice(0, 19);
          const capped = /cap|balance|fund|rate/i.test(msg);
          this.#record(id, { reason: capped ? `the lease ends at ${ends} UTC and will not renew: ${msg}` : `renew failed: ${msg}` });
          if (untilMs < Date.now()) { await this.#stopApp(id, `the lease expired and renew failed: ${msg}`); continue; }
        }
      }
      this.#record(id, { leaseUntil: Number(d.leaseUntil), rate6: String(d.rate), balance6: String(d.balance6), cpuShare: Number(d.cpuMilli) / 1000 });
      const app = this.apps.get(id);
      if (!app || app.state !== "running") await this.ensureApp(id, d);
    }
  }
  /**
   * Give the lease back. The ledger's release() is what puts the deployment in front of the rest
   * of the fleet again, and this box remembers not to take it a second time. Every caller is a
   * failure that will not fix itself by waiting, which makes holding the lease the wrong answer:
   * a tenant whose app cannot run here is better served by a row that reads Queued somewhere else
   * than by one that reads "running on nucbox-k11" over a restart loop.
   */
  async #giveUp(id, why) {
    const app = this.apps.get(id);
    if (app) { await app.stop(); this.apps.delete(id); }
    this.#record(id, { status: "failed", reason: why, port: null });
    this.blocked.set(id, why);
    this.tracked.delete(id); this.#saveTracked();
    this.log(`giving up on ${id.slice(0, 10)}: ${why}`);
    try {
      const held = await chain.readDeployment(id).catch(() => null);
      if (held && String(held.runner || "").toLowerCase() === this.enclaveId.toLowerCase()) {
        const hash = await chain.releaseDeployment(id);
        this.log(`released ${id.slice(0, 10)} back to the fleet (tx ${hash})`);
        this.#record(id, { status: "released", reason: why });
      }
    } catch (e) { this.log(`release ${id.slice(0, 10)} failed: ${e.shortMessage || e.message}`); }
    return this.records.get(id);
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
  /**
   * What this box has left to sell, in the numbers a refusal can be checked against. The reserve
   * is not slack: the enclave holds the model and its pads in VTL1, the shielded worker feeds the
   * card, and the owner of the PC is entitled to their own machine.
   */
  capacity() {
    const slots = this.cfg.appSlots ?? 4;
    const running = [...this.records.values()].filter((r) => r.status === "running" || r.status === "provisioning");
    const committedMb = running.reduce((a, r) => a + (Number(r.memMb) || 0), 0);
    const ramMb = Math.max(0, Math.round((Number(this.cfg.ramGb) || 0) * 1024 * (1 - (this.cfg.reservedShare ?? 0.25))) - committedMb);
    return { slots, slotsFree: Math.max(0, slots - running.length), cpuShareFree: this.cpuShareFree(),
             ramMbFree: ramMb, cpuGflops: Number(this.cfg.gflops) || 0 };
  }
  /**
   * Does an app this box hosts run INSIDE the enclave? Today: no, and that is the gate on
   * everything below. A VBS enclave has no JIT, no mmap and no Rust std, so `wasmtime serve`
   * cannot run in VTL1; the app runs in the ordinary Windows session while the enclave holds the
   * model, the pads and the keys. That is not what this platform sells, so this box does not sell
   * app hosting: it stays out of the serving set and takes nothing from the market. It flips to
   * true when the in-enclave runtime lands, and then the row needs no caveat, because there will
   * not be one to make.
   */
  appsInTee() { return this.cfg.appsInTee === true; }
  /**
   * Which scope this box claims in. The market is only open when an app runs inside the enclave
   * (appsInTee): claiming a stranger's deployment onto a runtime the enclave does not cover would
   * sell them the one thing they came here for and not deliver it. Until then the box runs its
   * OWNER's apps only, which is the owner's own machine and the owner's own call.
   */
  scope() { return this.appsInTee() && this.cfg.claimScope === "market" ? "market" : "owner-only"; }
  /**
   * What this box adds to /availability.
   *
   * claimEnabled is the relay's question "does this box take work", and the answer is yes only
   * when it actually can: apps enabled, an operator key with gas, a registry entry with a price
   * and a proof key, and somewhere to put the work. Saying yes while any of those is missing
   * publishes capacity the platform would then offer and this box would refuse.
   */
  availability() {
    const running = [...this.apps.values()].filter((a) => a.state === "running").length;
    const cap = this.capacity();
    const ready = !!(this.cfg.appsEnabled && this.registered && Number(this.registered.cpuPricePerSec6) > 0
                     && chain.operatorAddress() && (this.gasRenewals ?? 1) > 0);
    return {
      // Selling app hosting requires the app to run in the enclave (appsInTee, false today). The
      // rest of `ready` is the ordinary can-it-actually-claim check: apps enabled, an operator key
      // with gas, a priced registry entry, and somewhere to put the work.
      claimEnabled: this.appsInTee() && ready && cap.slotsFree > 0 && cap.cpuShareFree > 0,
      // The honest word for what this box is: a seller of SOME of the platform's features. The
      // relay reads it and keeps this box out of the fleet-wide capability ANDs, the sizing floors
      // and the default price, so the flags below can be the plain truth about this box instead of
      // a promise the whole fleet has to keep.
      fullService: false,
      ...this.features(),
      apps: {
        // Where a hosted app runs, in the one word that matters. The relay's teeCpu describes the
        // enclave that holds the MODEL; an app is a wasm component under wasmtime in VTL0 and the
        // owner of this PC can read its memory. Never report this as a TEE.
        isolation: "host-process", inTee: false, runtime: "wasmtime", world: "wasi:http",
        scope: this.scope(), public: true, running, capacity: cap.slots,
        note: "apps run on the Windows host, not inside the VBS enclave; the enclave holds the model and the pads",
      },
      claimScope: this.scope(),
      // The REGISTRY's price, not the config's, when this box is listed: that entry is what the
      // ledger charges a lease and therefore what a buyer would actually pay. The config value is
      // only what a fresh box would register itself at.
      askCpuPricePerSec6: Number(this.registered?.cpuPricePerSec6) || this.cfg.cpuPricePerSec6,
      askGpuPricePerSec6: 0,                    // no card for sale: this box's GPU serves the enclave's masked inference
      nodeSlotsFree: cap.slotsFree, ramMbFree: cap.ramMbFree,
      enclaveId: this.enclaveId,
      registered: !!this.registered,
      operator: chain.operatorAddress() || null,
      gasRenewalsLeft: this.gasRenewals ?? null,   // an operator key out of gas stops renewing, and the app goes at the end of its quantum

      proofKey: chain.proofAddress() || null,
      ownerWallet: this.ownerAllow(),
    };
  }
  /**
   * Exactly which of the platform's deployment features this box implements. The relay AND-folds
   * these across the full-service fleet; this box is not in that fold (fullService: false), so
   * these describe THIS box and nothing else. A true here is a promise the claim policy keeps: if
   * a flag is false, a deployment that needs it is refused by name rather than run without it.
   */
  features() {
    return {
      // What it does implement.
      configOverride: true,   // the envelope's `config` namespace: the deployment's app-config replaces the version's (appConfig() below)
      gpuOptional: true,      // {"gpu":{"optional":true}}: a card-dialled deployment may run here on cores instead of queueing for a card
      cpuFallback: true,      // a version config's cpuFallback ({memMb, cpuGflops}) raises the node floor this box demands of a coreless placement (chain.nodeFloorOf)
      networkOptions: true,   // the envelope's `network` namespace is understood and not refused; the choice itself is consumed at the DNS layer, as it is on every runner
      rateCap: true,          // it prices a claim off its own registry entry, asks the ledger first (claimableBy) and treats a cap-blocked renew as "stop at lease end"
      proofOfTime: true,      // it signs EIP-712 checkpoints from the proof key in its registry entry; /v1/attestation says where that key lives, which on this box is the Windows host
      // What it does not, each one a refusal in chain.claimPolicy rather than a silent gap.
      waf: false,             // no per-IP rate limit and no request filter: a deployment carrying {"waf":…} is refused
      secrets: false, secretsInConfig: false,   // it fetches and injects no relay-stored secrets
      configCid: false, configCidOverride: false,   // it fetches no pinned config, so the rev-7 split is refused
      configEdit: false, shareResize: false,    // a live edit or resize lands on-chain and applies at re-claim, not in place
      customDomains: false,   // it mints no certificates: traffic reaches an app here through the relay's /x/<id>
      devDeploy: false,       // pending catalog versions stay refused, public or not
      p3: false, set: false, coopThreads: false, mem64: false,   // stock wasmtime: no SET spawn, no cooperative threads, and p3/memory64 untested here
      volumes: [],            // no attested model volumes: the one model on this box is the enclave's own
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
    const needs = missingHostInterfaces(art.path);
    if (needs.length) throw new Error(`this box cannot run it: the artifact needs ${needs.join(" and ")}`);
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
