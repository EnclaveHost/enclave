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
// A LEASED app runs INSIDE the enclave: its artifact is compiled to Pulley bytecode in VTL0 and
// interpreted in VTL1 by the runtime linked into the enclave image (windows/enclave-rt). Its code,
// its memory and its model calls never leave the enclave, and the card underneath only ever sees
// masked activations. An artifact built for a world the enclave cannot serve is refused by name
// rather than run beside the enclave, which is the thing this box does not sell.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import http from "node:http";
import * as chain from "./chain.mjs";
import { App, EnclaveApp, fetchArtifact, wasmLayer, appEnv, missingHostInterfaces, precompile } from "./apprun.mjs";
import { worldOf } from "./appframe.mjs";
import { fetchSecrets } from "./secrets.mjs";
import { ensureCert, appHostFor, selfSigned } from "./apptls.mjs";
import { fetchDomains } from "./domains.mjs";
import tls from "node:tls";
import * as waf from "./waf.mjs";

const HEARTBEAT_MS = 10 * 60_000;
const TICK_MS = 30_000;
const PROOF_MS = 5 * 60_000;         // the contract's window is 15 min; the platform proves every 5
// Renew this long before the lease ends. It was 5 minutes, which with a 5-minute tick left exactly
// ONE attempt: a single transaction lost to a flaky RPC and the lease lapsed, after which `renew`
// reverts "lease expired" and the app is stopped - for risc-box, a cold boot of the whole machine.
// 15 minutes gives three attempts inside a ~30-minute lease, for twice the renewals' gas (cents).
const RENEW_LEAD_MS = 15 * 60_000;

export class Host {
  constructor(cfg) {
    this.cfg = cfg;                                  // { dir, endpoint, name, appsEnabled, ownerWallet, cpuPricePerSec6, vcpus, ramGb, wasmtime, python, gateway, portBase, inferenceUrl, log }
    this.log = cfg.log || (() => {});
    /// The card, as the worker last described it, asked of the agent rather than remembered here:
    /// the pool this box sells is only as real as the worker that answers for it. Null when this
    /// box has no card or its worker is down, which sells nothing.
    this.card = cfg.card || (() => null);
    this.apps = new Map();                           // id -> App
    this.records = new Map();                        // id -> { id, status, reason, appRef, cid, version, leaseUntil, claimedAt, provenAt }
    this.enclaveId = chain.enclaveIdOf(cfg.endpoint);
    this.registered = null;                          // the registry entry as last read
    this.chainReady = false; this.lastError = "";
    this.statePath = path.join(cfg.dir, "host-state.json");
    const st = this.#loadState();
    this.tracked = new Set(st.tracked || []);
    // THE PER-APP ISOLATION BACKEND, off unless a manager is configured. One place decides, so no
    // other code path can half-enable it: the deployed build has no such config and is unaffected.
    this.cfg.isolationManager   = this.cfg.isolationManager   || process.env.ENCLAVE_ISOLATION_MANAGER || "";
    this.cfg.isolationRuntimeId = this.cfg.isolationRuntimeId || process.env.ENCLAVE_ISOLATION_RUNTIME_ID || "";
    // host:port of the manager's data plane. Without it the app zone has no splicer, so an
    // isolated deployment is refused at the route rather than served through this agent.
    this.cfg.isolationDataAddr  = this.cfg.isolationDataAddr  || process.env.ENCLAVE_ISOLATION_DATA_ADDR || "";
    /// Secrets this box fetched for a lease it holds, in memory only: never written beside the
    /// state file, never logged, and dropped when the lease goes.
    this.secrets = new Map();
    /// The app-zone certificate per deployment, its backoff after a refusal, and the one request
    /// in flight: a browser retrying a name this box cannot certify must not turn into a retry
    /// storm at the relay's issuer.
    this.appCerts = new Map();
    this.appCertFails = new Map();
    /// The hostnames a customer attached to each deployment, their certificates, and what
    /// issuance did. Kept with the lease, not in the domains client, so there is one copy of the
    /// truth: `domains` is the list the relay last told us, `hostCerts` the certificate per name,
    /// and `certReports` what to tell the customer about names that did NOT get one.
    this.domains = new Map();        // id -> [hostname]
    /// hostname -> the deployment id that owns it, GLOBAL and live. `contextFor` consults this
    /// rather than a list captured when the connection opened: certificates are keyed by hostname
    /// across the whole box, so a name that moves between deployments would otherwise let the old
    /// owner keep serving it - with the NEW owner's certificate - for as long as a captured array
    /// survived. The window is small and the consequence is another tenant's identity.
    this.domainOwner = new Map();
    /// hostname -> a counter bumped on every ownership change. An issuance that started before a
    /// change and finishes after it is discarded rather than stored: the name is not ours now.
    this.domainGen = new Map();
    this.hostCerts = new Map();      // hostname -> { cert, ctx }
    // Both carry their OWNER, for the same reason hostCerts does: they are keyed by hostname
    // across the whole box, but what they are ABOUT is a (deployment, hostname) pair. A name that
    // moves takes neither the previous owner's backoff nor their pending report with it.
    this.certReports = new Map();    // hostname -> { owner, ok, error?, message?, at }
    this.domainFails = new Map();    // hostname -> { owner, until } retry-after epoch ms
    this.appCertInflight = new Set();
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
      if (this.registered) this.log(`registry: listed as ${e.endpoint} price ${e.cpuPricePerSec6}/sec cpu`
        + `${Number(e.gpuPricePerSec6) > 0 ? ` + ${e.gpuPricePerSec6}/sec card` : ""}, payout ${e.payoutWallet}`);
    } catch (e) { this.lastError = e.message; }
  }
  /** Is this box running apps as isolated domains? False unless a manager is configured. */
  get isolation() { return !!this.cfg.isolationManager; }

  /** The isolation backend this box runs, by name, or null. What a tenant's `require` must match. */
  get isolationBackend() { return this.cfg.isolationManager ? "hyperv-partition-per-app" : null; }

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
        cpuPricePerSec6: this.cfg.cpuPricePerSec6, gpuPricePerSec6: this.cardPrice(), proofKey });
      this.log(`registry: registered ${this.cfg.endpoint} id=${id} price=${this.cfg.cpuPricePerSec6}/sec proofKey=${proofKey} tx=${hash}`);
      await this.refreshRegistration();
    } catch (e) { this.log(`registry: register failed: ${e.shortMessage || e.message}`); }
  }
  /**
   * What this box asks for its whole card, per second, in USDC 6dp - and zero unless there IS a
   * card answering right now. A price posted for silicon whose worker is down would have the
   * ledger sell a share this box cannot deliver.
   */
  cardPrice() {
    const card = this.card();
    return card && Number(card.vramBudgetGb) > 0 ? Number(this.cfg.gpuPricePerSec6) || 0 : 0;
  }
  /**
   * Keep the REGISTRY's asks in step with what this box actually offers. The entry is what the
   * ledger charges, so the card became sellable here only when this transaction landed: publishing
   * a pool in /availability while the registry says the card costs nothing would have the platform
   * hand it out for free.
   */
  async ensurePriced() {
    if (!this.chainReady || !this.registered || !chain.operatorAddress()) return;
    const want = this.cardPrice();
    if (Number(this.registered.gpuPricePerSec6 || 0) === want) return;
    if ((this.gasRenewals ?? 1) <= 0) return;
    try {
      const hash = await chain.setPrices(this.enclaveId, Number(this.registered.cpuPricePerSec6) || this.cfg.cpuPricePerSec6, want);
      this.log(`registry: card price now ${want}/sec (was ${this.registered.gpuPricePerSec6 || 0}) tx=${hash}`);
      await this.refreshRegistration();
    } catch (e) { this.log(`registry: setPrices failed: ${e.shortMessage || e.message}`); }
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

  /** The loopback port a server-shaped app binds inside the enclave. Stable per deployment id so
   * a restart lands on the same one, and clear of the ephemeral range. */
  #portFor(id) {
    const base = this.cfg.portBase + 64;
    const n = parseInt(id.slice(2, 10), 16) % 64;
    return base + n;
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
    const refuse = chain.claimPolicy(d, { isolationBackend: this.isolationBackend, ownerAllow: this.ownerAllow(), enclaveId: this.enclaveId,
                                          appsEnabled: this.cfg.appsEnabled, scope: this.scope(),
                                          version: v, capacity: this.capacity(),
                                          listedAt: this.listedAt(), invited: invited || force,
                                          legacy: this.cfg.claimLegacy === true, fetchesConfigCid: true,
                                          privateOk: !!this.cfg.sessionKid,
                                          features: this.features() });
    if (refuse) { this.#record(id, { status: "refused", reason: refuse, appRef: d?.appRef || "" }); return { accepted: false, reason: refuse }; }
    const retired = this.retiredEngineClaimRefusal(d);
    if (retired) { this.#record(id, { status: "refused", reason: retired, appRef: d?.appRef || "" }); return { accepted: false, reason: retired }; }
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

  /**
   * An owner resized the deployment on-chain (setShares). Honour it, or hand the lease back.
   *
   * The ledger starts billing the new shares at once, so the only two honest outcomes are to serve
   * them or to stop serving. What each axis means HERE:
   *
   *   cpu  an admission and billing figure. An app in this enclave is interpreted bytecode on the
   *        enclave's own threads - there is no cgroup to widen - so a CPU resize changes what the
   *        box has left to sell and what this tenant pays, not a slice anyone can feel. Said
   *        plainly rather than implied by silence.
   *   gpu  real, and it gates the model: the card share rides into VTL1 as ENCLAVE_GPU_MILLI and
   *        the runtime refuses `generate` without it. It is read when the app is opened, so a
   *        change means a restart in place.
   *
   * A resize this box cannot fit is not an error to retry: the lease goes back so a box that does
   * fit can take it.
   */
  async #applyShareResize(id, d, rec) {
    const cpu = Number(d.cpuMilli) / 1000, gpu = Number(d.gpuMilli) / 1000;
    const wasCpu = Number(rec?.servedCpuShare), wasGpu = Number(rec?.servedGpuShare);
    if (!Number.isFinite(wasCpu) || !Number.isFinite(wasGpu)) {
      // First sight of this deployment under the watch: adopt what it is, without a restart.
      this.#record(id, { servedCpuShare: cpu, servedGpuShare: gpu });
      return;
    }
    if (cpu === wasCpu && gpu === wasGpu) return;
    // Does the new size still fit BESIDE the others? Its own old share is excluded, or a tenant
    // growing from 10% to 20% is measured against a box that still counts their first 10%.
    const cap = this.capacity({ exclude: id });
    if (cpu > cap.cpuShareFree + 1e-9) {
      return await this.#giveUp(id, `it was resized to ${Math.round(cpu * 100)}% of a node and this box has`
        + ` ${Math.round(cap.cpuShareFree * 100)}% left; handing the lease back so a box that fits can take it`);
    }
    if (gpu > 0 && gpu > (cap.gpuShareFree ?? 0) + 1e-9) {
      return await this.#giveUp(id, `it was resized to ${Math.round(gpu * 100)}% of this box's card and`
        + ` ${Math.round((cap.gpuShareFree ?? 0) * 100)}% of it is left; handing the lease back`);
    }
    this.#record(id, { servedCpuShare: cpu, servedGpuShare: gpu });
    if (gpu !== wasGpu) {
      this.log(`resize ${id.slice(0, 10)}: card share ${Math.round(wasGpu * 100)}% -> ${Math.round(gpu * 100)}%,`
        + ` relaunching in place so the enclave sees it`);
      await this.ensureApp(id, d, { force: true });
      return;
    }
    this.log(`resize ${id.slice(0, 10)}: node share ${Math.round(wasCpu * 100)}% -> ${Math.round(cpu * 100)}%`
      + ` (an admission and billing figure here: an app in this enclave is interpreted, not cgroup-sliced)`);
  }

  /**
   * Act on the verdict: stamp, swap the rules live, or relaunch on the new configuration.
   *
   * The restart is IN PLACE and deliberate: the lease, the slot and the certificate are all kept,
   * so what the tenant sees is their app coming back on the configuration they just signed, not a
   * re-placement. An envelope that does not parse leaves the running app exactly as it is.
   */
  async #applyEnvelopeEdit(id, d) {
    const rec = this.records.get(id);
    const cur = String(d?.configCid || "");
    const verdict = this.envelopeVerdict(rec, cur);
    if (verdict === "skip") return;
    if (verdict === "stamp") { this.#record(id, { envelope: cur }); return; }
    if (verdict === "error") {
      let why = "it does not parse";
      try { chain.parseEnvelope(cur, d.gpuMilli); } catch (e) { why = e.message; }
      // Recorded once, not every 30 seconds: a bad edit is a standing fact about the row.
      if (rec.reason !== `the owner's last options edit was not applied: ${why}`)
        this.log(`config edit ${id.slice(0, 10)} NOT applied (the running app keeps its old configuration): ${why}`);
      this.#record(id, { reason: `the owner's last options edit was not applied: ${why}` });
      return;
    }
    let opts = {};
    try { opts = chain.parseEnvelope(cur, d.gpuMilli); } catch { return; }
    if (verdict === "waf") {
      // {} not null: the envelope parsed, so "no rules" is KNOWN. null means "could not read",
      // which isolationPlan holds on - so recording null after a live edit that REMOVED the rules
      // would re-hold an isolated deployment forever (enclave-99).
      this.#record(id, { envelope: cur, waf: opts.waf || {} });
      waf.forget(id);                          // new rules, new counters: an old bucket is not the owner's intent
      this.log(`config edit ${id.slice(0, 10)}: protection rules swapped live, no restart`);
      return;
    }
    // "restart": the app's own configuration changed.
    this.#record(id, { envelope: cur, waf: opts.waf || {} });
    waf.forget(id);
    this.log(`config edit ${id.slice(0, 10)}: the app's configuration changed, relaunching it in place`);
    await this.ensureApp(id, d, { force: true });
  }

  /**
   * An owner edited the deployment's options envelope on-chain (setConfig). Does the SERVING app
   * re-apply, and how?
   *
   * MIRRORED FROM THE PLATFORM RUNNER (supervisor.js envelopeEditVerdict) and checked against its
   * own self-test seam. The envelope is mutable on the ledger but was only ever read when the
   * lease was claimed; this is what makes an edit reach an app that is already running.
   *
   *   "skip"    nothing changed, or this is not a record we serve
   *   "stamp"   a record from before this watch existed: adopt the current value WITHOUT a
   *             restart, because rolling the feature out must not restart every tenant
   *   "waf"     only the protection rules changed: swap them live, no restart
   *   "restart" the app's configuration changed: relaunch it on the new ENCLAVE_CONFIG
   *   "error"   the new envelope does not parse under THIS build's rules: keep the old
   *             configuration serving and say why. The claim gate's fail-closed refusal cannot
   *             apply to something already running - tearing a tenant down because their NEXT
   *             edit was invalid would punish them for a typo.
   */
  envelopeVerdict(rec, chainCid) {
    if (!rec || rec.status !== "running") return "skip";
    const cur = String(chainCid || "");
    if (rec.envelope == null) return "stamp";
    if (rec.envelope === cur) return "skip";
    let oldO = {}, newO;
    try { oldO = chain.parseEnvelope(rec.envelope); } catch { /* a stale unparsable stamp reads as no options */ }
    try { newO = chain.parseEnvelope(cur); } catch { return "error"; }
    // "config absent" (use the version's) and "config: {}" (explicitly empty) are different owner
    // intents, so null and "{}" stay distinct. The CID rides the same key: repointing it at a
    // different pinned document is a config change even when the inline part is byte-identical.
    const cfg = (o) => (o.config !== undefined || o.configCid)
      ? JSON.stringify([o.configCid || "", o.config !== undefined ? o.config : null]) : null;
    return cfg(newO) === cfg(oldO) ? "waf" : "restart";
  }

  /**
   * The deployment's relay-stored secrets, fetched as its lease holder and kept in memory.
   *
   * This is the one thing on this box that the app gets and the operator does not: the values go
   * into the enclave with the app's environment and are never written down. A refusal is recorded
   * and NOT fatal by itself - an app whose config references a secret it did not get will say so
   * itself, and that reason is more useful than this box guessing.
   */
  async loadSecrets(id) {
    if (!this.cfg.secretsSign) return;
    const r = await fetchSecrets({ id, endpoint: this.cfg.endpoint, sign: this.cfg.secretsSign,
                                   base: this.cfg.relayBase, log: (m) => this.log(m) });
    if (r.count > 0) {
      this.secrets.set(id, r.env);
      this.#record(id, { secrets: r.count });
      this.log(`secrets: ${r.count} for ${id.slice(0, 10)} (${Object.keys(r.env).join(", ")})`);
    } else { this.secrets.delete(id); }
  }

  /**
   * true / false / null for "does this deployment have relay-stored secrets?", where null means
   * NOT KNOWABLE on this box rather than "no". The distinction is the whole point: a caller that
   * turns null into false has assumed exactly what it was asked to establish.
   */
  async #secretsState(id) {
    if (!this.cfg.secretsSign) return null;          // we cannot ask, so we do not know
    try {
      if (!this.secrets.has(id)) await this.loadSecrets(id);
    } catch { return null; }                          // asking failed: still unknown, never "no"
    const env = this.secrets.get(id);
    return !!(env && Object.keys(env).length > 0);
  }

  /**
   * Run this deployment as an isolated domain through the manager, and translate the outcome into
   * this node's record vocabulary. Returns a record when it decided, or null to fall through to the
   * in-enclave path.
   *
   * The lease rule is the client's, not restated here: `held` means the outcome is UNKNOWN, so the
   * lease stays and nothing is retried; only a KNOWN failure frees it.
   */
  /**
   * The parameters this deliberately does NOT take: `memMb` and `port`. It used to be handed both,
   * and when the branch moved above their declarations ensureApp threw `memMb is not defined` on
   * every deployment - so the real ensureApp never reached the manager at all (enclave-5d, running
   * it for real). Neither was used: the policy's memMiB comes from the version's ON-CHAIN memMb
   * through isolationPlan, and the app port from the plan too. Removing them is the fix, not
   * hoisting the declarations, because taking a value you do not use is how it comes back.
   *
   * `envOpts` and `envRead` ARE taken, for the opposite reason: they are used here, they are
   * ensureApp's locals, and reading them as free variables was the SAME ReferenceError one line
   * apart (enclave-5d found it on the rerun after the memMb fix - I corrected one and did not look
   * for the others in the block I had just moved). Passing them makes the dependency a parameter
   * the reader can see instead of a scope accident.
   */
  async #isolationReconcile(id, d, v, { envOpts = {}, envRead = false } = {}) {
    const { reconcile } = await import("./isolation-lifecycle.mjs");
    const { IsolationManagerClient } = await import("./isolation-client.mjs");
    const { isolationPlan } = await import("../vbslike/datapath/node-bridge.mjs");
    const client = new IsolationManagerClient({ base: this.cfg.isolationManager });

    // THE BODY IS BUILT BY THE PLAN, NOT BY HAND.
    //
    // enclave-5d checked my hand-built record against the live ones and it was WRONG in two ways
    // that a test here would never have caught, because both produce a perfectly well-formed body:
    //   - the policy's memMiB came from this node's memMb (nodeFloorOf, which applies the
    //     publisher's cpuFallback). The rule takes the version's ON-CHAIN memMb. A different
    //     number is a different AppID from the Linux tier's for the same app, so a verifier
    //     recomputing from the catalog would not reproduce what ran here.
    //   - catalog.app was d.appRef with version.version, where the rule wants the bytes32 app id
    //     and the index.
    // One implementation of the rule, shared with the tier that already runs it, is the only way
    // these stay equal; the plan reproduces the live records exactly (hookbin 1fb9360d, hello
    // bff33b95).
    //
    // WHAT IT REFUSES, and the distinction that matters: `unknown` means an input could not be
    // established, which is NOT the same as an input that says no. Unknown holds the lease;
    // a definite refusal gives it back with the reason.
    // The WHOLE /health object, not just its derivations list: the plan checks the manager's
    // backend name too, so a manager of another backend that happens to list /1 is refused rather
    // than used. null when it could not be asked, which the plan treats as unknown (held).
    let managerHealth = null;
    try { managerHealth = (await client.health()) ?? null; } catch { managerHealth = null; }

    // Which model volumes this version needs, from the version's own config rather than from a
    // literal. null when the config could not be read at all: unknown, not "none".
    let volumes = null;
    try {
      const cfg = v && v.config ? (typeof v.config === "string" ? JSON.parse(v.config) : v.config) : {};
      volumes = Array.isArray(cfg.volumes) ? cfg.volumes.slice() : [];
    } catch { volumes = null; }

    // DID THIS DEPLOYMENT ASK FOR ISOLATION?
    //
    // enclave-99: nothing in the plan's inputs carries the deployment's own requirement, so a
    // deployment that never asked for a partition would be planned onto one simply because this
    // box is configured for the backend. That is a scope decision the tenant makes, not the
    // operator, so it is refused HERE - before the plan - rather than waiting for the plan to
    // grow an input. A deployment that did not ask falls through to the in-enclave path, which is
    // what it bought.
    const req = this.records.get(id)?.isolationRequired;
    if (req !== true) {
      if (req === undefined || req === null) this.log(`${id.slice(0, 10)} isolation: the deployment's envelope was not read for an isolation requirement; not isolating`);
      return null;      // fall through: not an error, just not this backend
    }

    const plan = isolationPlan({
      deploymentId: id,
      deployment: d,
      version: v,
      appConfig: await this.appConfigResolved(d, v),
      hasSecrets: await this.#secretsState(id),
      // {} and [] ONLY when known to be none: this node parsed the envelope at claim time and
      // recorded what it found, so an unparsed envelope must not read as "no rules".
      waf: this.records.get(id)?.waf ?? null,
      // DERIVED, not asserted. I wrote `volumes: []` here as a literal, flagged it to 5d as
      // "asserted by me, not derived", and then left it - which is the same class as the
      // hasSecrets:false I had just removed, so removing one and leaving the other was not a fix,
      // it was a preference. enclave-99 caught it. The version's own config says which model
      // volumes the app needs; a config we could not read is UNKNOWN and holds the lease.
      volumes,
      runtimeId: this.cfg.isolationRuntimeId,
      // The tenant's requirement as a STRING, from the envelope this node parsed above. The plan
      // refuses a deployment requiring another backend, or none - so the opt-in is now enforced in
      // BOTH places: my gate above (which falls through to in-enclave) and the plan (which
      // refuses). Steven asked for both, and they answer different questions: mine is "is this
      // mine to run", the plan's is "may this be planned at all".
      require: envOpts.isolationRequire ?? null,
      manager: managerHealth,
      // The deployment's config OVERRIDE cid. "" when known none; null when the envelope could not
      // be read, which is unknown, not none.
      appConfigCid: envRead ? String(envOpts.configCid || "") : null,
    });
    if (!plan.ok) {
      const why = `isolation: ${plan.input}: ${plan.why}`;
      if (plan.unknown) {
        this.log(`${id.slice(0, 10)} ${why}`);
        return this.#record(id, { status: "provisioning", reason: why });
      }
      return await this.#giveUp(id, why);
    }

    const body = IsolationManagerClient.spawnBody(plan.spawn);
    let r;
    try { r = await reconcile({ client, deployment: { id, body }, ledger: null }); }
    catch (e) { return this.#record(id, { status: "failed", reason: `isolation: ${e.message}` }); }

    if (r.action === "held") {
      // NOT a failure and NOT a success: the lease is kept and this tick decided nothing.
      this.log(`${id.slice(0, 10)} isolation held: ${r.reason}`);
      return this.#record(id, { status: "provisioning", reason: r.reason });
    }
    if (r.action === "failed") {
      if (r.leaseFree) return await this.#giveUp(id, `isolation: ${r.reason}`);
      return this.#record(id, { status: "failed", reason: `isolation: ${r.reason}` });
    }
    // adopted or spawned, and serving
    const inst = r.instance || {};
    this.log(`${id.slice(0, 10)} isolation ${r.action}: ${inst.id} status=${inst.status} image=${inst.image || "?"}`);
    return this.#record(id, { status: "running", reason: null,
                              isolation: { backend: "hyperv-partition-per-app", instance: inst.id,
                                           // appId is REQUIRED by isolatedTarget; without it the
                                           // app-zone route cannot name what it is splicing to
                                           appId: inst.appId ?? null,
                                           image: inst.image ?? null,
                                           // NORMALISED to the contract's spelling. The HCS backend's
                                           // BOUNDARY says "t0-hv" and start() hands it up verbatim, but
                                           // judge-hv and the splice's routeFor use "T0-hv" - so every
                                           // partition would have been read as an SNP guest and refused
                                           // for "not stating a whole verified identity" (enclave-5d).
                                           // They made routeFor case-insensitive; this makes the record
                                           // say the contract's word in the first place.
                                           tier: inst.tier ? String(inst.tier).toUpperCase().replace(/^T0-HV$/, "T0-hv") : null,
                                           // carried up verbatim; this is NOT verified capacity
                                           hostExcluded: inst.hostExcluded === true,
                                           transportKeySha256: inst.transportKeySha256 ?? null } });
  }

  /** Fetch + verify + run the deployment's app, and keep the record honest about which stage failed. */
  async ensureApp(id, d, { force = false, version = null } = {}) {
    const rec = this.#record(id, { appRef: d.appRef, leaseUntil: Number(d.leaseUntil),
                                   cpuShare: Number(d.cpuMilli) / 1000, gpuShare: Number(d.gpuMilli) / 1000,
                                   // What the data-path gate needs, from the ledger and nowhere else.
                                   isPublic: d.isPublic !== false, owner: String(d.owner || "").toLowerCase() });
    // HELD first, before the catalog read: a yanked version, like every later gate, would otherwise give the
    // lease back on chain (heldReason).
    const held = this.heldReason(d);
    if (held) return this.#record(id, { status: "held", reason: held });
    let v = version;
    if (!v) try { v = await chain.resolveAppRef(d.appRef); } catch (e) { return this.#record(id, { status: "failed", reason: `catalog: ${e.message}` }); }
    if (v.yanked) return await this.#giveUp(id, "the catalog version is yanked");
    // The CORELESS floor, which is the only kind this box does: the version's own memMb, raised by
    // the publisher's cpuFallback when they declared one. Sizing a fallback off the card-case
    // figure is how a big model lands on a small slice and dies at weight-load with nothing having
    // said no, so the guest's memory cap is the larger number.
    const floor = chain.nodeFloorOf(v);
    this.#record(id, { cid: v.cid, version: v.version, memMb: floor.memMb, cpuFallbackSized: floor.fromFallback });

    // THE ENVELOPE, parsed ONCE and BEFORE the isolation branch, because the branch's opt-in gate
    // reads what it records. It used to be parsed further down, so `isolationRequired` was written
    // after the gate had already read it as absent - and nothing wrote it at all, which is the
    // defect enclave-99 found: the gate could never be satisfied. Through the same parser
    // claimPolicy used, so "accepted at claim" and "applied here" cannot drift.
    let envOpts = {}, envRead = false;
    try { envOpts = chain.parseEnvelope(d.configCid, d.gpuMilli) || {}; envRead = true; }
    catch { envOpts = {}; envRead = false; }
    this.#record(id, {
      // {} = the envelope was read and carries no rules; null = it could not be read at all.
      // `envOpts.waf || null` conflated them, so an ordinary deployment with no WAF rules looked
      // UNKNOWN to isolationPlan and was held forever - every WAF-less deployment permanently
      // un-isolatable, from a line meant to be careful (enclave-99).
      waf: envRead ? (envOpts.waf || {}) : null,
      envelope: String(d?.configCid || ""),
      // true only when the tenant asked for THIS box's backend by name. claimPolicy already
      // refuses a deployment requiring a backend this box does not run, so a mismatch here means
      // the config changed under a live lease.
      isolationRequired: !!envOpts.isolationRequire && envOpts.isolationRequire === this.isolationBackend,
    });

    // A FORCED re-ensure retires the existing domain first. Without this the reconcile below
    // ADOPTS the live one by name and the deployment keeps running its previous configuration
    // while the record says the new one was applied - a config edit or an artifact override that
    // silently did nothing (defect 15's third path).
    if (force && this.records.get(id)?.isolation) {
      const gone = await this.#retireIsolated(id, "forced relaunch");
      if (!gone) return this.#record(id, { status: "provisioning",
        reason: "the previous isolated domain could not be confirmed gone, so a new one is not started" });
    }

    // THE PER-APP ISOLATION BACKEND, decided HERE - before every gate that judges the IN-ENCLAVE
    // runtime, and before anything that can give the lease back.
    //
    // It used to sit further down, after the artifact-layer, host-interface, appsInTee, world and
    // engine-memory checks. Every one of those calls #giveUp, which RELEASES THE LEASE ON CHAIN
    // when this enclave is the runner - so on a box configured for isolation with no in-enclave
    // runtime, the first ensureApp handed back every isolated lease before the branch was ever
    // reached. enclave-5d measured it end to end: hello-world and hookbin both died at
    // appsInTee, then at the engine-memory check with the flags forced on, and hookbin's
    // wasi:cli world would have died at the world check too.
    //
    // None of those gates is meaningful for this backend: they ask what THIS enclave's runtime can
    // run, and an isolated deployment does not run in this enclave. The manager fetches the
    // component by CID and derives from it itself. What IS needed first is the catalog version,
    // the yanked check and the policy floor, which are above.
    //
    // The opt-in check lives inside the branch, so a deployment that did not ask for isolation
    // returns null here and falls through to the in-enclave path unharmed.
      //
      // Default OFF. Without ENCLAVE_ISOLATION_MANAGER nothing below runs and this node behaves
      // exactly as the deployed build does - which matters, because the bytes running on nucbox-k11
      // are NOT this branch's, and a change that altered the default would take six live apps with
      // it.
      //
      // When it IS set, the deployment's domain is a Hyper-V child partition managed by the
      // manager rather than a process in this enclave, and `reconcile` owns the decision: it adopts
      // a domain that is already there (so a node restart does not run a deployment twice), waits
      // for the manager's own readiness verdict, and HOLDS the lease whenever the outcome is
      // unknown. It never frees a lease on a guess.
      //
      // What it does NOT do: change what this box advertises. A T0-hv partition does not exclude
      // the host, attestedCapacity() is false for it, and nothing here touches meetsIsolationContract().
      if (this.isolation) {
        const outcome = await this.#isolationReconcile(id, d, v, { envOpts, envRead });
        if (outcome) return outcome;
      }

    let art;
    // An OPERATOR ARTIFACT OVERRIDE, when one is set for this deployment (see #artifactPatch). It
    // replaces only WHICH BYTES run; the lease, the config, the secrets and the checks below are
    // the catalog version's, unchanged.
    const patched = this.#artifactPatch(id, v);
    if (patched && patched.error) return this.#record(id, { status: "failed", reason: `artifact override: ${patched.error}` });
    if (patched) art = { path: patched.path };
    else {
      try { art = await fetchArtifact({ cid: v.cid, dir: path.join(this.cfg.dir, "apps"), python: this.cfg.python, gateway: this.cfg.gateway, log: (m) => this.log(m) }); }
      catch (e) { return this.#record(id, { status: "failed", reason: `artifact: ${e.message}` }); }
    }
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
    // WHICH WORLD the artifact was built for, read from the bytes rather than from a claim beside
    // them. Only the enclave:app world runs in VTL1: wasi:http needs a socket, a poll loop and a
    // host implementation of wasi:io, none of which exist in an enclave. A tenant whose app is
    // built for that world is told so, and their lease is handed back, rather than having their
    // app quietly run in the Windows session where this box's owner can read it.
    const world = worldOf(fs.readFileSync(art.path));
    if (!this.appsInTee())
      return await this.#giveUp(id, "this enclave image carries no app runtime, so this box cannot host an app inside the enclave and will not host one outside it");
    // Which worlds this enclave image actually serves (a bitmask from the runtime itself):
    // 1 = enclave:app, 2 = wasi:http. An ordinary platform app is world 2 and runs unchanged.
    const worlds = Number(this.cfg.enclaveAppWorlds || 1);
    const want = world === "enclave-app" ? 1 : world === "wasi-http" ? 2 : world === "wasi-cli" ? 4 : 0;
    if (!want || !(worlds & want))
      return await this.#giveUp(id, `this box runs an app INSIDE its VBS enclave. It serves`
        + ` ${worlds & 1 ? "enclave:app@0.1.0" : ""}${(worlds & 3) === 3 ? " and " : ""}${worlds & 2 ? "wasi:http" : ""},`
        + ` and this artifact is built for ${world === "wasi-cli" ? "wasi:cli with wasi:sockets, a server that binds its own"
            + " port: an enclave has no socket to bind and no reactor to poll, so that shape needs the brokered sockets"
            + " that are not built yet" : world}`);
    // Did anybody with the standing to say so declare the card optional? The same two voices
    // claimPolicy listens to: the owner's envelope and the publisher's version config. When they
    // did, a card-dialled deployment runs here on cores and nothing below applies.
    let gpuSoft = envOpts.gpuOptional === true;
    const wafRules = envOpts.waf || null;
    // The owner's protection rules, kept beside the lease so every request can be checked against
    // them without re-parsing the envelope. claimPolicy already refused anything unreadable.
    this.#record(id, { waf: wafRules, envelope: String(d?.configCid || "") });
    gpuSoft = gpuSoft || chain.gpuOptionalOfConfig(v && v.config);
    // TEMPORARY OPERATOR OVERRIDE (ENCLAVE_ALLOW_CARD_WITHOUT_MODEL), for the risc-box milestone.
    // The rule below is right in general - a card share here buys the MODEL, and an app that
    // cannot reach `generate` would be paying for silicon it cannot address - but risc-box bought
    // 1% of the card and wants the enclave for its own compute, not for inference. Until the
    // publisher declares `gpuOptional` on the version, this lets the operator say "I know, run it
    // anyway". Off unless set; windows/PARITY.md lists it with the other relaxations.
    gpuSoft = gpuSoft || this.cfg.allowCardWithoutModel === true;
    // Bought the card, but built for a world that cannot reach it. The model in this enclave is
    // offered through the enclave:app world's `generate` and nowhere else: a wasi:http or wasi:cli
    // artifact has no import that reaches it, so its card share would buy it nothing. Say so and
    // hand the lease back rather than take money for silicon the app cannot address.
    if (Number(d.gpuMilli) > 0 && want !== 1 && !gpuSoft)
      return await this.#giveUp(id, `it bought ${Math.round(Number(d.gpuMilli) / 10)}% of this box's card, and`
        + ` what a share buys here is the model inside the enclave, reached through the enclave:app@0.1.0`
        + ` world's generate. This artifact is built for ${world}, which has no import that reaches it`);
    let app = this.apps.get(id);
    if (app && force) { await app.stop(); this.apps.delete(id); app = null; }
    if (!app) {
      // WHAT THE APP'S OWN CONFIG ASKS FOR, when that is more than the catalog's declared floor.
      //
      // risc-box declares memMb 3072 in the catalog and `ramMiB: 21764` in its config - the guest
      // machine it boots. Given the floor it started, listened, and then died on a 72 KB
      // allocation, which reads as a corrupt app rather than a budget. The config is the app's own
      // statement of what it needs and the node already resolves it for everything else, so it is
      // honoured here too, bounded by what the enclave actually has left.
      let memMb = floor.memMb;
      try {
        const want = Number(JSON.parse(String(await this.appConfigResolved(d, v) || "{}")).ramMiB) || 0;
        // A little headroom: ramMiB is the GUEST's memory and the app needs its own on top.
        if (want > 0 && Math.round(want * 1.1) > memMb) memMb = Math.round(want * 1.1);
      } catch { /* a config that will not parse is the resolver's problem, not this one's */ }
      if (memMb !== floor.memMb)
        this.log(`${id.slice(0, 10)}: the version declares ${floor.memMb} MB but its config asks for`
          + ` a ${Math.round(memMb / 1.1)} MiB guest; giving it ${memMb} MB`);
      this.#record(id, { memMb });
      // Against the budget capacity() computed, not a config number: the enclave is a fixed size
      // and what is left of it is the enclave's size less what the engine holds less what the
      // other apps were promised. A version bigger than that cannot fit however the file is set.
      const cap = this.capacity({ exclude: id });
      if (!cap.ramMeasured)
        return await this.#giveUp(id, "this box has not yet measured what its engine holds of the enclave,"
          + " so it does not know how much memory it can honestly promise; it re-checks every 30 seconds");
      if (memMb > cap.ramMbFree)
        return await this.#giveUp(id, `the version asks for ${memMb} MB and this enclave has ${cap.ramMbFree} MB left`
          + ` of its ${Math.round((Number(this.cfg.enclaveGb) || 0) * 1024)} MB`);
      // Compile once per CID AND per runtime ABI, then keep it. The bytecode is a pure function
      // of the artifact and the compiler's tunables, and the runtime refuses bytecode built with
      // different ones ("compiled without epoch interruption but it is enabled for the host"), so
      // the ABI belongs in the name: a runtime change simply misses the cache instead of loading
      // something it will reject.
      // The cache key carries the runtime's ABI **and its feature mask**, both read from the
      // enclave itself. The ABI alone was not enough: turning a wasm feature on does not change
      // what wasmtime records in a cwasm, so an artifact compiled before the change would be
      // reused unchanged unless someone remembered to bump the ABI by hand. Naming the file after
      // the features removes that human step - any change on either side simply misses the cache.
      const abi = Number(this.cfg.enclaveAppAbi || 0);
      const feats = Number(this.cfg.enclaveAppFeatures || 0);
      const cwasm = path.join(this.cfg.dir, "apps", `${patched ? `local-${patched.sha.slice(0, 16)}` : `ipfs-${v.cid}`}.rt${abi}f${feats}.cwasm`);
      if (!fs.existsSync(cwasm) || fs.statSync(cwasm).size < 64) {
        this.#record(id, { status: "provisioning", reason: "compiling the app to enclave bytecode" });
        try { await precompile({ wasmPath: art.path, outPath: cwasm, exe: this.cfg.precompileExe,
                                 features: this.cfg.enclaveAppFeatures, log: (m) => this.log(m) }); }
        catch (e) {
          // A COMPILE FAILURE THAT NAMES A MISSING WASM FEATURE IS PERMANENT, and the lease must
          // go back. wasmtime says "<feature> must be enabled for <thing>" when an artifact uses
          // something this build does not have, and no amount of retrying changes that - while the
          // lease keeps running and the tenant keeps paying for an app that will never start.
          //
          // Found live: this box claimed risc-box 0.6.15, whose catalog config does NOT declare
          // set:true, and the artifact turned out to contain shared memories anyway. The claim gate
          // reads the declaration; only the compiler reads the bytes. So the gate let it through
          // and the box sat in "failed" holding the lease.
          const missing = /([a-z0-9_-]+) must be enabled/i.exec(String(e.message || ""));
          if (missing) {
            return await this.#giveUp(id, `its artifact uses ${missing[1]}, which this box's enclave runtime`
              + ` does not build for - whatever the catalog version declares. The bytes are the authority:`
              + ` ${String(e.message).split("\n").filter((l) => /must be enabled/i.test(l))[0]?.trim() || e.message}`);
          }
          return this.#record(id, { status: "failed", reason: `bytecode: ${e.message}` });
        }
      }
      // A server-shaped app binds a port INSIDE the enclave, so the node picks the actual port
      // (nothing else on this machine may already hold it) and tells the app through
      // ENCLAVE_PORTS, which is the platform's own convention: "<label>:<declared>=<actual>". An
      // app that hardcodes a port instead of reading this is the one thing that cannot work here.
      const port = want === 4 ? this.#portFor(id) : 0;
      const declared = Number(d.appPort) || 8080;
      // The secrets, fetched here rather than beside the claim: a node restart rebuilds the app
      // from a lease it already holds and never passes through consider(), and an app that comes
      // back WITHOUT its credentials starts unconfigured and answers 503 - which is exactly what
      // happened to the s3-ipfs-adapter on the first restart after it was claimed.
      if (!this.secrets.has(id)) {
        await this.loadSecrets(id).catch((e) => this.log(`secrets ${id.slice(0, 10)}: ${e.message}`));
      }
      // ...and the custom hostnames, HERE, before the environment is built. The platform runner
      // does the same thing in the same place (supervisor.js launchSpec calls fetchDepDomains
      // before launchSpecFrom), and for the same reason: ENCLAVE_HOSTS is a LAUNCH-TIME SNAPSHOT,
      // so a box that only learned the names on its next tick would hand every cold-started guest
      // a list missing the very domain its owner attached. The tick keeps certificates and SNI
      // serving current after that; the guest's own copy changes when it next starts, which is
      // also what happens on a platform box.
      await this.refreshDomains(id, { forLaunch: true })
        .catch((e) => this.log(`domains ${id.slice(0, 10)}: ${e.message}`));
      const env = this.appEnvFor(id, d, v, { memMb, port, world: want, declared,
                                             config: await this.appConfigResolved(d, v) });
      app = new EnclaveApp({ id, cwasmPath: cwasm, hostCmd: this.cfg.hostCmd, memMb, world: want, port, env,
                             log: (m) => this.log(`${id.slice(0, 10)} ${m}`) });
      this.apps.set(id, app);
    }
    if (app.state !== "running") {
      this.#record(id, { status: "provisioning", reason: null });
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
    const rec2 = this.#record(id, { status: "running", reason: null, port: app.port, startTries: 0 });
    // Ask for the app's certificate NOW rather than when the first visitor arrives: issuance goes
    // through ACME and takes a moment, and the console's padlock stays amber (and a browser lands
    // on a warning) until a handshake actually succeeds. Fire and forget - appZoneTarget holds its
    // own backoff, and nothing about the app depends on the outcome.
    if (app.port) {
      this.appZoneTarget(id).then((t) => {
        if (t) this.log(`${id.slice(0, 10)} app-zone ready at https://${t.cert.name}/`);
      }).catch(() => {});
    }
    return rec2;
  }

  /**
   * The app's config: the catalog version's, replaced by the deployment's override when it carries
   * one. Through the same parser the claim policy used, so the config that reaches the guest is
   * the one the policy accepted and nothing else - a second, looser reading of the same field is
   * how a runner ends up honouring an option it told the tenant it had refused.
   */
  /**
   * Resolve `$NAME` / `${NAME}` in an app config from this deployment's secrets.
   *
   * MIRRORED FROM THE PLATFORM RUNNER (wasm/wasm_manager.py `_subst_secrets`), deliberately and
   * down to the escape rule, because a box that reads these differently from the rest of the fleet
   * is worse than one that does not read them at all: the same app would be configured here and
   * unconfigured there, with nothing having said no. The published apps depend on it - risc-box's
   * catalog config is `"endpoint": "$S3_ENDPOINT"` and four more like it.
   *
   * The substitution walks the PARSED JSON and replaces inside string values only, so a secret
   * holding a quote or a backslash is re-serialised safely rather than spliced into raw JSON text.
   * Only names that really are secrets substitute; anything else keeps its literal `$`, because a
   * config may legitimately contain dollar signs. `$$` is a literal `$`.
   *
   * The resolved text exists only in the environment handed to the enclave. What the node records
   * and what the owner reads back keeps the placeholder - same exposure class as the secrets.
   */
  #substituteSecrets(text, secrets) {
    if (!text || !secrets || !Object.keys(secrets).length || !text.includes("$")) return text;
    const RE = /\$(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
    const rep = (m, dollar, braced, bare) => {
      if (dollar) return "$";
      const name = braced || bare;
      const v = secrets[name];
      return v === undefined ? m : String(v);
    };
    const walk = (x) => {
      if (typeof x === "string") return x.replace(RE, rep);
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") {
        const o = {};
        for (const [k, val] of Object.entries(x)) o[k] = walk(val);
        return o;
      }
      return x;
    };
    // A config that is not JSON is passed through untouched rather than mangled: the app owns its
    // own format, and this box is not the place to discover it is not JSON.
    let parsed;
    try { parsed = JSON.parse(text); } catch { return text; }
    return JSON.stringify(walk(parsed));
  }

  /**
   * The environment a guest is started with: the same one the platform gives an app on a
   * confidential VM.
   *
   * Its own method so it can be READ. What a guest receives is a contract - an app reads its
   * config, its hostnames and its card share from here and has no other way to learn them - and a
   * contract that can only be observed by starting a real enclave is a contract nobody checks.
   */
  appEnvFor(id, d, v, { memMb, port = 0, world = 1, declared = 8080, config }) {
    return {
      // The same environment the platform gives an app on a confidential VM.
      // RESOLVED against this deployment's secrets, which is what the platform's runner hands a
      // guest. An app whose config says "$S3_ENDPOINT" must receive the endpoint, not the word.
      ENCLAVE_CONFIG: config,
      ENCLAVE_MEM_MB: String(memMb),
      // THE CARD SHARE THIS DEPLOYMENT BOUGHT, read off the ledger record and carried into VTL1,
      // where the runtime gates the model on it: `generate` answers a deployment that bought a
      // share of this box's card and refuses one that did not (windows/enclave-rt HostState).
      // The tenant never supplies this value; the only lie available to this side is giving its
      // own card away.
      ENCLAVE_GPU_MILLI: String(Number(d.gpuMilli) || 0),
      // Every hostname this deployment answers on: its own subdomain first, then whatever its
      // owner attached. An app that generates absolute URLs or checks the Host header needs to
      // know its customer's name, and this is how the platform tells it.
      ENCLAVE_HOSTS: this.hostsFor(id).join(","),
      ...(world === 4 ? { ENCLAVE_PORTS: `http:${declared}=${port}` } : {}),
      // ...plus this deployment's relay-stored secrets, which is how an app's credentials reach
      // it. They are fetched as the LEASE HOLDER (secrets.mjs) and injected into the enclave,
      // never written to disk and never given to the VTL0 side beyond this call.
      ...(this.secrets.get(id) || {}),
    };
  }

  async appConfig(d, v) {
    try {
      const opts = chain.parseEnvelope(d?.configCid, d?.gpuMilli);
      if (opts.config !== undefined) return JSON.stringify(opts.config);
      if (opts.configCid) {
        // Fetched through the CID verifier, not trusted from the gateway: the bytes are re-hashed
        // against the CID the ledger names before they become an app's configuration.
        const file = path.join(this.cfg.dir, "apps", `cfg-${opts.configCid}.json`);
        if (!fs.existsSync(file)) {
          await fetchArtifact({ cid: opts.configCid, dir: path.join(this.cfg.dir, "apps"),
                                python: this.cfg.python, gateway: this.cfg.gateway,
                                maxBytes: 1 << 20, out: file, log: (m) => this.log(m) });
        }
        const text = fs.readFileSync(file, "utf8");
        JSON.parse(text);                              // it must BE JSON before an app sees it
        this.log(`config: ${opts.configCid} applied to ${String(d.id).slice(0, 10)} (${text.length} bytes, CID-verified)`);
        return text;
      }
    } catch (e) { this.log(`config: ${e.message}; the version's own config stands`); }
    // THE PUBLISHER's split (catalog rev 7): when the version names a config CID, the inline field
    // is only the routing manifest (volumes, mem64, set...) and the fetched bytes are what the
    // guest gets. Handing it the manifest instead would look like a working app with a nonsense
    // configuration, so a fetch that FAILS refuses rather than falling back to the inline field.
    if (v?.configCid) {
      const file = path.join(this.cfg.dir, "apps", `cfg-${v.configCid}.json`);
      if (!fs.existsSync(file)) {
        await fetchArtifact({ cid: v.configCid, dir: path.join(this.cfg.dir, "apps"),
                              python: this.cfg.python, gateway: this.cfg.gateway,
                              maxBytes: 1 << 20, out: file, log: (m) => this.log(m) });
      }
      const text = fs.readFileSync(file, "utf8");
      JSON.parse(text);                                // it must BE JSON before an app sees it
      this.log(`config: the version's own ${v.configCid} applied (${text.length} bytes, CID-verified)`);
      return text;
    }
    return String(v?.config || "");
  }

  /** The app's config as the GUEST sees it: resolved against this deployment's secrets. */
  async appConfigResolved(d, v) {
    const text = await this.appConfig(d, v);
    const secrets = this.secrets.get(String(d?.id || "").toLowerCase()) || {};
    const out = this.#substituteSecrets(text, secrets);
    if (out !== text) {
      const names = Object.keys(secrets).filter((n) => text.includes(n));
      this.log(`config: resolved ${names.length} secret placeholder${names.length === 1 ? "" : "s"}`
        + ` for ${String(d.id).slice(0, 10)} (${names.join(", ")})`);
    }
    return this.#patchConfig(d, out);
  }
  /**
   * An OPERATOR-SET, per-deployment patch over a tenant's resolved app config, from
   * ENCLAVE_APP_CONFIG_PATCH ({"<deployment id>": {"key": value}}). It is a local override: it
   * changes nothing on chain and nothing for the same version anywhere else.
   *
   * It exists because a setting that is right on one box can be fatal on another. risc-box asks
   * for `realtime: true` - the guest's clock driven by the HOST's, which anything that paces
   * itself (a game, a video player) needs. That assumes the guest runs near real speed. In this
   * enclave there is no JIT: the emulator is Pulley bytecode and the guest manages ~0.5 MIPS, so
   * the 10 ms timer arrives every ~5,000 guest instructions while the kernel's timer ISR costs
   * ~31,000 - measured 65M vs 121M instructions to reach "Linux version" under Pulley with the
   * clock off and on. The guest never finishes one tick before the next is due, so it executes
   * flat out and never gets past OpenSBI, which is exactly what this box showed.
   *
   * A patch is a WORKAROUND and should name itself as one: it is logged on every apply, and the
   * standing list lives in windows/PARITY.md.
   */
  /**
   * An OPERATOR-SET artifact override: ENCLAVE_APP_ARTIFACT_PATCH = {"<deployment id>":
   * {"file": "<path>", "sha256": "<hex>"}}. The deployment runs that file instead of its catalog
   * version's CID.
   *
   * It exists for one case: a fix whose permanent form needs signatures this box does not hold.
   * risc-box's catalog app and the deployment both belong to the governance hardware wallet, so a
   * fixed build can only become the catalog's version, and the deployment's, through two signatures
   * on that device (publishVersion, then setAppRef). Until then the override is how the fix runs.
   *
   * The bytes are pinned by hash - a file that does not match is refused, never run - and the
   * compiled cache is keyed by that hash, so it cannot be confused with the catalog CID's. Every
   * apply is logged and recorded on the deployment, and the list lives in windows/PARITY.md. It is a
   * WORKAROUND and must be removed once the signed version exists.
   */
  #artifactPatch(id, v) {
    const raw = process.env.ENCLAVE_APP_ARTIFACT_PATCH;
    if (!raw) return null;
    let all;
    try { all = JSON.parse(raw); } catch (e) { return { error: `ENCLAVE_APP_ARTIFACT_PATCH is not JSON (${e.message})` }; }
    const key = String(id).toLowerCase();
    const p = all[key] || all[key.replace(/^0x/, "")];
    if (!p) return null;
    if (!p.file || !/^[0-9a-f]{64}$/i.test(String(p.sha256 || ""))) return { error: "needs {file, sha256}" };
    let bytes;
    try { bytes = fs.readFileSync(p.file); } catch (e) { return { error: `cannot read ${p.file}: ${e.message}` }; }
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha !== String(p.sha256).toLowerCase()) return { error: `${p.file} is sha256 ${sha.slice(0, 16)}…, not the pinned ${String(p.sha256).slice(0, 16)}… - refusing to run it` };
    this.log(`ARTIFACT OVERRIDE (operator, NOT the catalog's bytes) for ${key.slice(0, 10)}: running ${path.basename(p.file)} `
      + `sha256 ${sha.slice(0, 16)}… in place of catalog ${v.version} (${v.cid})`);
    this.#record(key, { artifactOverride: { file: path.basename(p.file), sha256: sha, replaces: v.cid } });
    return { path: p.file, sha };
  }
  #patchConfig(d, text) {
    const raw = process.env.ENCLAVE_APP_CONFIG_PATCH;
    if (!raw) return text;
    let all;
    try { all = JSON.parse(raw); } catch (e) {
      this.log(`config patch: ENCLAVE_APP_CONFIG_PATCH is not JSON (${e.message}); ignoring it`);
      return text;
    }
    const id = String(d?.id || "").toLowerCase();
    const patch = all[id] || all[id.replace(/^0x/, "")] || null;
    if (!patch || typeof patch !== "object") return text;
    let cfg;
    try { cfg = JSON.parse(text || "{}"); } catch { return text; }
    const changed = Object.keys(patch).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(patch[k]));
    if (!changed.length) return text;
    this.log(`config patch (operator override, NOT the tenant's published config) for ${id.slice(0, 10)}: `
      + changed.map((k) => `${k}=${JSON.stringify(patch[k])}`).join(" "));
    return JSON.stringify({ ...cfg, ...patch });
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
      // A LEASE THIS BOX ALREADY HOLDS is work in progress, not a candidate. The tick's own loop
      // resumes it; asking the claim gate about it here can only produce a wrong answer, because
      // the gate decides whether to TAKE work and this work is already taken.
      //
      // It showed up as a restart window: on a fresh boot the records have no status yet, so the
      // scan ran before the resume and stamped "refused" on an app that was seconds from serving -
      // visible to the tenant and to the console, and a lie either way. Caught by curling the app
      // during a restart and finding it marked refused while the lease was live.
      if (ours && live) continue;
      if (!ours && live && !/^0x0+$/.test(String(d.runner || ""))) continue;   // somebody else is running it
      if (!ours && claimed >= 1) continue;
      let v = null; try { v = await chain.resolveAppRef(d.appRef); } catch {}
      const refuse = chain.claimPolicy(d, { isolationBackend: this.isolationBackend, ownerAllow: owner, enclaveId: this.enclaveId, appsEnabled: true,
                                            scope, version: v, capacity: this.capacity(), listedAt: this.listedAt(),
                                            legacy: this.cfg.claimLegacy === true, fetchesConfigCid: true,
                                            privateOk: !!this.cfg.sessionKid,
                                            features: this.features() });
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
    // The asks, every tick rather than once at start-up: the card price is a function of whether
    // a worker is answering, and a worker that dies mid-shift must take the card's price off the
    // registry with it.
    await this.ensurePriced().catch((e) => this.log(`prices: ${e.message}`));
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
      // HELD (a retired-engine node, a deployment it cannot run): before the renewal, the envelope edit and
      // the resize, each of which can spend or give back the lease on chain. Recorded, and left alone.
      const held = this.heldReason(d);
      if (held) { this.#record(id, { status: "held", reason: held, leaseUntil: Number(d.leaseUntil) }); continue; }
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
      this.#record(id, { leaseUntil: Number(d.leaseUntil), rate6: String(d.rate), balance6: String(d.balance6),
                         cpuShare: Number(d.cpuMilli) / 1000, gpuShare: Number(d.gpuMilli) / 1000,
                         isPublic: d.isPublic !== false, owner: String(d.owner || "").toLowerCase() });
      // THE OWNER'S EDIT, reaching an app that is already running. The envelope is mutable on the
      // ledger (setConfig) and used to be read only at claim time, so an owner who changed their
      // app's configuration or its protection rules saw nothing happen until the lease turned over.
      await this.#applyEnvelopeEdit(id, d).catch((e) => this.log(`config edit ${id.slice(0, 10)}: ${e.message}`));
      // ...and the owner's RESIZE (setShares), which the ledger bills from immediately. A box that
      // billed the new share while serving the old one would be charging for something it is not
      // doing, which is why the fleet AND-folds this before a client will even send the tx.
      await this.#applyShareResize(id, d, rec).catch((e) => this.log(`resize ${id.slice(0, 10)}: ${e.message}`));
      const app = this.apps.get(id);
      if (!app || app.state !== "running") await this.ensureApp(id, d);
    }
    // The app's own origin: a certificate order at the relay answers 202 while ACME runs, so keep
    // asking on the tick rather than only when a visitor arrives. Until it is issued the console's
    // padlock stays amber and a browser gets a handshake failure, so nobody should have to trigger
    // this by hand. appZoneTarget holds the backoff; this only re-enters it.
    // An owner attaches a domain while the app is already RUNNING - that is the whole point - so
    // the list is re-read on the tick rather than only at claim time.
    for (const id of this.apps.keys())
      await this.refreshDomains(id).catch((e) => this.log(`domains ${id.slice(0, 10)}: ${e.message}`));
    for (const [id, app] of this.apps) {
      const cur = this.appCerts.get(id);
      if (app.state === "running" && app.port && (!cur || !cur.cert || cur.cert.selfSigned)) {
        this.appZoneTarget(id).then((t) => {
          // "Ready" has to mean a BROWSER WILL LOCK. appZoneTarget answers a target either way -
          // the self-signed fallback is still a servable target - so logging on `t` alone printed
          // "app-zone ready at https://..." every tick for an app whose padlock was amber, which
          // is how a missing certificate stayed invisible here while the log said it was fine.
          if (t && t.cert && !t.cert.selfSigned) this.log(`${id.slice(0, 10)} app-zone ready at https://${t.cert.name}/`);
        }).catch(() => {});
      }
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
    // An isolated domain first: handing the lease back while its partition still serves would
    // leave the deployment answering with no lease behind it (defect 15).
    await this.#retireIsolated(id, why);
    // Everything that belonged to the lease goes with it. The rate buckets and concurrency
    // counters are keyed by deployment id, and an id CAN come back - a lease handed back for one
    // reason is re-claimable once that reason changes. Leaving the counters behind would meet the
    // returning tenant with a bucket their own traffic emptied an hour ago.
    waf.forget(id);
    this.secrets.delete(id);
    this.forgetDomains(id);
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
  /**
   * DEFECT 15 (enclave-99): nothing ever retired an isolated domain. #stopApp, #giveUp and the
   * forced restart all stop `this.apps` entries, and a partition has none - so no DELETE ever
   * reached the manager and a domain outlived its lease, still answering under a name whose lease
   * was gone. Worse than a leak: it is a deployment served without a lease.
   *
   * Returns true when the domain is KNOWN gone. False means the manager could not confirm it, and
   * the caller must not treat the deployment as finished - retire() already keeps the lease in
   * that case, and this reports it so the record says why.
   */
  async #retireIsolated(id, why) {
    const rec = this.records.get(id);
    if (!rec || !rec.isolation || !this.cfg.isolationManager) return true;    // nothing to retire
    try {
      const { retire } = await import("./isolation-lifecycle.mjs");
      const { IsolationManagerClient } = await import("./isolation-client.mjs");
      const client = new IsolationManagerClient({ base: this.cfg.isolationManager });
      const r = await retire({ client, deployment: { id }, ledger: null, instanceId: rec.isolation.instance });
      if (r.removed) {
        // CLEARED ONLY ON A CONFIRMED REMOVAL (enclave-99). Dropping `isolation` on any other
        // outcome would erase the only record of which instance is still out there: the domain
        // would keep serving and nothing here would name it, so a later tick could neither retire
        // it nor even report it. Keeping it is what makes an unconfirmed retire visible.
        this.#record(id, { isolation: null, isolationRetireFailed: null });
        this.log(`${id.slice(0, 10)} isolated domain retired (${why})`);
        return true;
      }
      this.log(`${id.slice(0, 10)} isolated domain NOT retired: ${r.reason}`);
      this.#record(id, { isolationRetireFailed: r.reason });
      return false;
    } catch (e) {
      this.log(`${id.slice(0, 10)} isolated domain retire failed: ${e.message}`);
      this.#record(id, { isolationRetireFailed: e.message });
      return false;
    }
  }

  async #stopApp(id, why) {
    // BEFORE forgetting anything: a partition is not in this.apps, so without this the domain
    // simply keeps running under a lease that has ended.
    await this.#retireIsolated(id, why);
    waf.forget(id);
    this.secrets.delete(id);                           // they belong to the lease, not to this box
    this.appCerts.delete(id); this.appCertFails.delete(id);
    this.forgetDomains(id);
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
  cpuShareFree({ exclude = null } = {}) {
    if (!this.cfg.appsEnabled) return 0;
    const used = [...this.records.values()].filter((r) => r.status === "running")
      .filter((r) => !exclude || String(r.id).toLowerCase() !== String(exclude).toLowerCase())
      .reduce((a, r) => a + (r.cpuShare || 0), 0);
    return Math.max(0, Math.min(1, 1 - used - (this.cfg.reservedShare ?? 0.25)));   // a quarter stays for the enclave, the worker and the owner
  }
  /**
   * The CARD pool this box has left, as a fraction of the worker's budget.
   *
   * Two limits, and the smaller wins. What this box has SOLD is its own ledger: the card shares of
   * the leases it is running. What is actually FREE on the silicon is the worker's business, and
   * on a desktop it is not the same number - the owner of the PC may be playing a game on it. The
   * card facts arrive from the agent (shieldedcard.mjs asks the worker), so a box whose worker is
   * down sells nothing rather than selling from memory.
   */
  gpuShareFree({ exclude = null } = {}) {
    if (!this.cfg.appsEnabled) return 0;
    const card = this.card && this.card();
    if (!card || !(Number(card.vramBudgetGb) > 0)) return 0;
    const sold = [...this.records.values()].filter((r) => r.status === "running")
      .filter((r) => !exclude || String(r.id).toLowerCase() !== String(exclude).toLowerCase())
      .reduce((a, r) => a + (r.gpuShare || 0), 0);
    const onCard = Number(card.vramFreeGb) / Number(card.vramBudgetGb);
    return Math.max(0, Math.min(1, 1 - sold, Number.isFinite(onCard) ? onCard : 0));
  }

  /**
   * What this box has left to sell, in the numbers a refusal can be checked against. The reserve
   * is not slack: the enclave holds the model and its pads in VTL1, the shielded worker feeds the
   * card, and the owner of the PC is entitled to their own machine.
   */
  capacity({ exclude = null } = {}) {
    const slots = this.cfg.appSlots ?? 4;
    // `exclude` is how a deployment is sized against the room it would leave BESIDE the others
    // rather than beside itself, and it applies to EVERY axis - memory, node share and card share.
    // Two things need it: a restart re-reads a record that already carries its own floor, and a
    // RESIZE measures a tenant growing from 10% to 20% against a box that would otherwise still be
    // counting their first 10%. Either way, counting a deployment against itself refuses it for
    // asking for what it already has.
    const running = [...this.records.values()].filter((r) => r.status === "running" || r.status === "provisioning")
      .filter((r) => !exclude || String(r.id).toLowerCase() !== String(exclude).toLowerCase());
    const committedMb = running.reduce((a, r) => a + (Number(r.memMb) || 0), 0);
    // AN APP INSIDE THE ENCLAVE LIVES IN ENCLAVE MEMORY, and the enclave is a FIXED, DEDICATED
    // size chosen at creation (ee-main.cpp EnclaveSize). So the pool is that size, and what is
    // taken out of it is two measured things and nothing else:
    //
    //   - what the ENGINE holds: the model, its KV cache and the pads, read from the enclave
    //     itself before any app was claimed (the host protocol's `mem`).
    //   - what each running app was PROMISED: its declared floor, because the box has to keep
    //     that promise whether or not the app has touched the pages yet.
    //
    // What it is NOT is a fraction of the share ledger. The RAM cell used to be cpuShareFree x the
    // node's RAM, so a box that had sold 5% of its cores and reserved a quarter for its owner
    // reported 14 GB of its enclave "used" while four apps between them held half a gigabyte.
    // Cores are sold as a share; this memory is a fixed allocation, and it reports as one.
    const enclaveMb = Math.round((Number(this.cfg.enclaveGb) || 0) * 1024);
    const hostMb = Math.round((Number(this.cfg.ramGb) || 0) * 1024 * (1 - (this.cfg.reservedShare ?? 0.25)));
    // UNKNOWN is not ZERO. `engineHeldMb` is null until the node has asked the enclave what the
    // model, its KV cache and the pads hold (the host protocol's `mem`), and treating that as "the
    // engine holds nothing" would offer a tenant the WHOLE enclave including the part the engine
    // is already sitting in - an app admitted on that figure does not fit and thrashes VTL1.
    //
    // So an unmeasured box admits NOTHING NEW. It keeps serving what it already runs, and the
    // agent re-probes every tick, so this is a startup window that closes itself rather than a
    // state a box can be stuck in silently.
    // `Number(null)` is 0, so the null check has to come FIRST or "not measured" silently becomes
    // "measured as nothing" - which is the exact over-admission this guard exists to prevent.
    const raw = this.cfg.engineHeldMb;
    const measured = raw === null || raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < 0
      ? null : Number(raw);
    const engineMb = measured ?? 0;
    // The optional cap: an owner may keep an app ceiling below the enclave's own size. Absent, the
    // whole enclave less what the engine holds is the budget.
    const capMb = Number(this.cfg.enclaveAppRamMb) || 0;
    const budgetMb = this.appsInTee()
      ? (measured === null ? 0 : Math.min(Math.max(0, enclaveMb - engineMb), capMb > 0 ? capMb : Infinity))
      : hostMb;
    const ramMb = Math.max(0, budgetMb - committedMb);
    const card = this.card && this.card();
    return { slots, slotsFree: Math.max(0, slots - running.length), cpuShareFree: this.cpuShareFree({ exclude }),
             ramMbFree: ramMb, ramMbPool: this.appsInTee() ? enclaveMb : hostMb, ramMbEngine: engineMb,
             // Has the engine's own hold been measured? A caller that sees false knows ramMbFree
             // is a refusal, not a capacity.
             ramMeasured: !this.appsInTee() || measured !== null,
             cpuGflops: Number(this.cfg.gflops) || 0,
             // The card, in the same shape: what a GPU-dialled deployment is checked against.
             gpuShareFree: this.gpuShareFree({ exclude }), cardGb: card ? Number(card.vramBudgetGb) || 0 : 0 };
  }
  /**
   * Does an app this box hosts run INSIDE the enclave?
   *
   * DETECTED, never configured: the answer is whether the loaded enclave image carries an app
   * runtime, which the enclave itself answers (EeAppAbi -> `appabi` on the host protocol, read at
   * startup). A switch in a config file could say yes while the image said nothing, and this
   * property is the whole basis on which the box sells app hosting at all.
   */
  appsInTee() { return Number(this.cfg.enclaveAppAbi || 0) >= 1; }
  /**
   * THE LEGACY BACKEND IS RETIRED on a node started without the VBS enclave engine (cfg.engineRetired;
   * Steven, 2026-09-25). Only a deployment that requires THIS box's isolation backend by name runs here.
   * isolatedForThisBox(d) -> true when the deployment's envelope asks for this.isolationBackend. An unreadable
   * envelope, or a node with no isolation manager, is not that.
   */
  isolatedForThisBox(d) {
    if (!this.isolationBackend) return false;
    try { return (chain.parseEnvelope(d?.configCid, d?.gpuMilli) || {}).isolationRequire === this.isolationBackend; }
    catch { return false; }
  }
  /**
   * heldReason(d) -> the reason a deployment this node already holds is HELD, or null. A held deployment is
   * refused and recorded, never started, never renewed (a tenant is not billed for a service this box cannot
   * give), and NEVER released on chain automatically. Giving a lease back is an on-chain transaction and the
   * operator's decision (enclave-d1 F2). A held lease simply lapses at leaseUntil.
   */
  heldReason(d) {
    if (this.cfg.engineRetired !== true || this.isolatedForThisBox(d)) return null;
    return "this node runs only the isolated backend (the legacy VBS-enclave backend is retired) and this deployment "
      + "does not require it: held - not started, not renewed, not released - pending the operator's decision";
  }
  /** claimRefusal(d) -> why a retired-engine node will not CLAIM a deployment, or null (see heldReason). */
  retiredEngineClaimRefusal(d) {
    if (this.cfg.engineRetired !== true || this.isolatedForThisBox(d)) return null;
    return "this node runs only the isolated backend (the legacy VBS-enclave backend is retired): "
      + `it claims only deployments that require ${this.isolationBackend || "an isolation backend it does not have"}`;
  }
  /**
   * Does this box meet the isolation contract it would be SOLD under (site: Develop > Architecture,
   * "The isolation contract")? Tenant work needs every property, and this box knows which it lacks
   * today: the app-zone TLS key and the app traffic run through VTL0 (windows/PARITY.md, the
   * declared gap), and a test-signed enclave is the development tier, not a production trusted
   * layer. Both are facts about this build, not switches: appTrafficInsideEnclave() is false by
   * construction until the code that terminates app TLS inside VTL1 exists, and the tier is the
   * RELAY's verdict from attach (relayTier, set by the agent from attest-result), never this box's
   * own word. Until both hold, the box is implementation evidence and takes its OWNER's apps only.
   * The relay applies the same rule from its side (relay/api-relay.js computeEligible), so a build
   * that lied here would still not be routed work; this gate keeps the box from claiming it off
   * the ledger on its own.
   */
  appTrafficInsideEnclave() { return false; }
  meetsIsolationContract() {
    return this.appsInTee() && this.appTrafficInsideEnclave() && String(this.relayTier || "") === "vbs";
  }
  /**
   * Which scope this box claims in. The market is only open when an app runs inside the enclave
   * (appsInTee): claiming a stranger's deployment onto a runtime the enclave does not cover would
   * sell them the one thing they came here for and not deliver it. Until then the box runs its
   * OWNER's apps only, which is the owner's own machine and the owner's own call.
   */
  scope() { return this.meetsIsolationContract() && this.cfg.claimScope === "market" ? "market" : "owner-only"; }
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
      // Does this box take work from the market at all? That is a question about CAPABILITY, not
      // about whether it is busy: an app runtime in the enclave, apps enabled, an operator key
      // with gas and a priced registry entry. How much room is left is `cpuShareFree` and
      // `nodeSlotsFree` beside it. Folding "full" into this made the box drop out of the serving
      // set the moment its fourth app started, which took its capacity, its price and its card off
      // the fleet's books - the opposite of what a full box should report.
      // ...and, above all of those, the isolation contract: a box that does not meet it takes no
      // tenant work and says so, whatever its scope config asks for (meetsIsolationContract).
      claimEnabled: this.meetsIsolationContract() && ready,
      // The honest word for what this box is: a seller of SOME of the platform's features. The
      // relay reads it and keeps this box out of the fleet-wide capability ANDs, the sizing floors
      // and the default price, so the flags below can be the plain truth about this box instead of
      // a promise the whole fleet has to keep.
      fullService: false,
      ...this.features(),
      apps: this.appsInTee() ? {
        // Where a leased app runs, in the one word that matters: INSIDE the enclave. The bytecode
        // is interpreted in VTL1 by the runtime linked into the measured image, so the app's code
        // and memory are covered by the same attestation as the model beside it. What is NOT
        // covered is the traffic: VTL0 owns the socket and carries the request and response
        // frames, exactly as the platform's relay does for every other box in the fleet.
        isolation: "vbs-enclave", inTee: true, runtime: "wasmtime-pulley", abi: Number(this.cfg.enclaveAppAbi || 0),
        worlds: [...(Number(this.cfg.enclaveAppWorlds || 1) & 1 ? ["enclave:app@0.1.0"] : []),
                 ...(Number(this.cfg.enclaveAppWorlds || 1) & 2 ? ["wasi:http@0.2"] : []),
                 ...(Number(this.cfg.enclaveAppWorlds || 1) & 4 ? ["wasi:cli@0.2 (its own socket, brokered)"] : [])],
        world: "enclave:app@0.1.0", traffic: "carried by the host",
        // The contract verdict this box gives about ITSELF, for the row and for the operator's own
        // eyes: false today, with the reason. The relay's verdict is the one that counts.
        isolationContract: this.meetsIsolationContract(),
        ...(this.meetsIsolationContract() ? {} : { contractGap: "app-zone TLS key and traffic run through the host OS; tier " + (this.relayTier || "unverified") }),
        scope: this.scope(), public: true, running, capacity: cap.slots,
        // The enclave's dedicated size, what the engine holds of it, and what is free - the three
        // numbers that make the pool checkable rather than asserted.
        ramMb: cap.ramMbPool, engineMb: cap.ramMbEngine, ramMbFree: cap.ramMbFree,
        note: "an app runs inside the VBS enclave, interpreted from bytecode; its host carries the request and response bytes",
      } : {
        // No app runtime in this enclave image: the box hosts nothing for a tenant. The VTL0
        // wasmtime path still exists for the box owner's own bring-up, and is not an offer.
        isolation: "none", inTee: false, running, capacity: 0,
        note: "this enclave image carries no app runtime, so this box sells no app hosting",
      },
      // The app's own origin: whether this box can answer a TLS handshake for it, and WHERE the
      // key lives. On a confidential VM the key is minted inside the measured guest; here it is in
      // the agent's process in VTL0, which is the same place the /x/ path's plaintext already
      // passes through. Published rather than implied.
      // WHERE THE SESSION KEY LIVES, published for the same reason appTls.keyIn is. On a
      // confidential VM this key is minted inside the measured guest, so the operator cannot forge
      // a session for somebody else's wallet. Here it is in the agent's process in VTL0, so on
      // this box a session is worth what the machine owner's word is worth - which is the SAME bar
      // this box already publishes for app traffic, not a new one.
      session: this.cfg.sessionKid
        ? { kid: this.cfg.sessionKid, alg: "ES256", keyIn: "host-process", jwks: "/v1/session-jwks",
            note: "private deployments are served to their owner; the key that proves it is in the agent's process, not inside the enclave" }
        : null,
      appTls: {
        served: this.appsInTee() && Number(this.cfg.enclaveAppWorlds || 0) & 4 ? true : false,
        zone: this.cfg.appZone, keyIn: "host-process", terminatesIn: "host-process",
        issued: [...this.appCerts.values()].filter((c) => c.cert && !c.cert.selfSigned).length,
        selfSigned: [...this.appCerts.values()].filter((c) => c.cert && c.cert.selfSigned).length,
        note: "the app's own hostname is answered by this box; its TLS key is in the agent's process, not inside the enclave",
      },
      claimScope: this.scope(),
      // The REGISTRY's price, not the config's, when this box is listed: that entry is what the
      // ledger charges a lease and therefore what a buyer would actually pay. The config value is
      // only what a fresh box would register itself at.
      askCpuPricePerSec6: Number(this.registered?.cpuPricePerSec6) || this.cfg.cpuPricePerSec6,
      // The CARD's price, on the same rule: the registry entry when this box is listed, because
      // that is what the ledger would charge. Zero means this box sells no card share - either it
      // has none, or it has not registered a price for the one it has.
      askGpuPricePerSec6: Number(this.registered?.gpuPricePerSec6) || 0,
      // ...and the same number under the name a SHIELDED pool's price is read by. The platform's
      // own boxes publish both from one on-chain figure (supervisor.js: askShieldedPricePerSec6 =
      // SELL_GPU_PRICE6), because the card is charged as the card whichever side of the enclave it
      // sits on; what differs is only which pool the fleet row draws it under. A box that posted
      // only askGpu rendered a shielded pool with no rate at all, which reads as "free".
      ...(Number(this.registered?.gpuPricePerSec6) > 0 && this.card()
            ? { askShieldedPricePerSec6: Number(this.registered.gpuPricePerSec6) } : {}),
      nodeSlotsFree: cap.slotsFree, ramMbFree: cap.ramMbFree,
      // The enclave's memory as the fleet row reads it: a FIXED pool and what is really left of
      // it. ramGbFree is the field the row prefers over the share-derived figure, and publishing
      // it is what stops a box that sold 5% of its cores from reporting 14 GB of its enclave
      // "used" while its apps hold half a gigabyte between them.
      ramGbFree: Math.round((cap.ramMbFree / 1024) * 10) / 10,
      ramGbEngine: Math.round((cap.ramMbEngine / 1024) * 10) / 10,
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
      // Per-deployment protection rules (rate, concurrency, body size, method/path/agent filters),
      // enforced at BOTH of this box's doors because they funnel through one proxy. Mirrored from
      // the platform runner down to the status codes: the envelope is fail-closed, so a box that
      // read these rules differently would leave the same deployment protected in one place and
      // open in another.
      //
      // ONE HONEST DIFFERENCE, published rather than implied. On the /x/<id> path the relay
      // forwards the caller's address and the limits are per-address, as on the fleet. On the
      // app's OWN hostname the relay splices TLS bytes without terminating them, so there is no
      // client address to read and the rate and concurrency limits there count the DEPLOYMENT as a
      // whole. The filters (method, path, agent, body size) are unaffected either way.
      waf: true,
      // Relay-stored secrets, fetched as the lease holder and injected INTO the enclave with the
      // app's environment (secrets.mjs, host.loadSecrets) - AND resolved inside the app's config,
      // which is what `secretsInConfig` means. An app that resolves its own placeholders (the
      // s3-ipfs-adapter does) worked either way; one that expects the runner to do it (risc-box's
      // config is "$S3_ENDPOINT" and four more) did not, and simply started unconfigured.
      secrets: !!this.cfg.secretsSign, secretsInConfig: !!this.cfg.secretsSign,
      // BOTH halves of the rev-7 split, because the envelope shares one ledger field with
      // everything else and an app config bigger than that has nowhere else to live.
      //   configCidOverride  the OWNER's: the envelope's `configCid` namespace.
      //   configCid          the PUBLISHER's: the catalog version's own configCid, read through
      //                      versionConfigCid when the catalog says it speaks rev 7.
      // Either way the bytes are fetched and RE-HASHED against the CID the chain names before they
      // become an app's configuration. A box that knew only the inline field would hand such an
      // app its ROUTING MANIFEST and call it configured.
      configCid: true, configCidOverride: true,
      // An owner's setConfig reaches a LIVE deployment: the protection rules swap in place and a
      // config change relaunches the app on the new value (envelopeVerdict, mirrored from the
      // platform runner and checked against its own self-test seam).
      configEdit: true,
      // ...and setShares does too: the card half really re-slices (it gates the model in VTL1), the
      // node half is an admission and billing figure on this box, and a resize that no longer fits
      // hands the lease back rather than billing for a size it is not serving.
      shareResize: true,
      // A hostname the deployment's owner attached and proved: this box reads the list from the
      // relay (operator-signed, scoped by the live lease), gets a certificate for each name from
      // the same service that certifies its own subdomain, answers TLS for them by SNI, and hands
      // the guest ENCLAVE_HOSTS. Reported false when the box has no operator key to sign the
      // fetch with, because then it cannot learn the names at all and a lease landing here would
      // leave the customer's domain dark with nothing on the dashboard to explain it.
      customDomains: !!this.cfg.secretsSign && this.cfg.customDomains !== false,
      // A PENDING catalog version may run on a PRIVATE deployment - a publisher testing their own
      // app before the catalog owner has approved it. Public deployments of a pending version stay
      // refused, here as on the fleet. Both depend on being able to verify who is asking.
      devDeploy: !!this.cfg.sessionKid,
      // The wasm features, READ OFF THE ENCLAVE (the runtime's own ee_rt_features, carried out
      // through `appabi`). Never a config value: these are compile-time engine features recorded
      // in every cwasm, so a box that advertised one its image does not build would take a lease
      // and then refuse the artifact.
      //
      // `set` is the one that costs real work: wasmtime refuses the threads proposal outright for
      // a Pulley target, and with that gate lifted the compiler stops at the first `atomic_rmw`
      // for want of a lowering - Pulley's ISA has no atomic instructions at all. Until they exist
      // this stays false and a version declaring set:true is refused by name.
      mem64: !!(Number(this.cfg.enclaveAppFeatures) & 1),
      set: !!(Number(this.cfg.enclaveAppFeatures) & 2),
      p3: !!(Number(this.cfg.enclaveAppFeatures) & 4),
      coopThreads: !!(Number(this.cfg.enclaveAppFeatures) & 8),
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

  /**
   * What the app-zone half needs to answer a TLS handshake for this deployment: the app's own
   * loopback port and a certificate for its hostname. Null when this box does not serve it.
   *
   * The certificate is fetched ONCE and kept (apptls.mjs writes it beside the agent), and a
   * failure is remembered with its backoff so a browser hammering a name this box cannot certify
   * does not hammer the relay's issuer with it. A pending issuance answers null, which the caller
   * turns into a 503 rather than a broken handshake.
   */
  /**
   * Learn this deployment's custom hostnames, and get a certificate for each.
   *
   * Runs on the tick for every deployment this box is serving, because an owner attaches a domain
   * while the app is already running - that is the whole point of the feature - and a lease that
   * only read the list at claim time would leave the customer's name dark until the next turnover.
   *
   * The failure semantics are the platform runner's and they are not symmetrical (domains.mjs has
   * the reasoning): an authoritative "none" clears the list, but an unreachable relay KEEPS it,
   * because forgetting a hostname is an outage on a name the customer owns.
   */
  async refreshDomains(id, { forLaunch = false } = {}) {
    if (!this.cfg.secretsSign || !this.cfg.customDomains) return;
    const rec = this.records.get(id);
    // `forLaunch` is the cold-start call, made while the record is still "provisioning": the names
    // have to be known BEFORE the environment is built, or the guest starts without them.
    if (!rec || (!forLaunch && rec.status !== "running")) return;
    // Lower-cased once, as #certifyHost and forgetDomains already do: the index is written through
    // #setOwner, which normalises, so comparing a raw id against it is a bug waiting for the first
    // mixed-case deployment id to arrive.
    const key = String(id).toLowerCase();
    const previous = this.domains.get(id) || [];
    // What to tell the customer about names that did not get a certificate. This is the only way
    // somebody learns a CA refused their domain, so it rides on the next fetch and is cleared only
    // once the relay has taken it.
    const report = [];
    for (const h of previous) {
      const r = this.certReports.get(h);
      // OURS only. The map is keyed by hostname, so a report found under a name this deployment
      // now holds may still be the PREVIOUS owner's account of why their certificate was refused -
      // and that is their CA's message about their DNS, delivered to somebody else's customer.
      if (!r || r.owner !== key) continue;
      const { owner, ...rest } = r;
      report.push({ hostname: h, ...rest });
    }
    let r;
    try {
      r = await fetchDomains({ id, endpoint: this.cfg.endpoint, sign: this.cfg.secretsSign,
                               base: this.cfg.relayBase, previous, report, log: (m) => this.log(m) });
    } catch (e) { this.log(`domains ${id.slice(0, 10)}: ${e.message}`); return; }
    for (const h of r.delivered) if (this.certReports.get(h)?.owner === key) this.certReports.delete(h);
    if (r.source === "kept" && r.why && rec.domainWhy !== r.why) {
      this.log(`domains ${id.slice(0, 10)}: ${r.why}; keeping the ${previous.length} name(s) already known`);
      this.#record(id, { domainWhy: r.why });
    }
    const before = previous.join(",");
    this.domains.set(id, r.hosts);
    // ONLY AN AUTHORITATIVE ANSWER MAY MOVE OWNERSHIP. `source: "kept"` is this box's own stale
    // cache, returned because the relay could not be reached - it keeps the app answering, which
    // is the point, but it is not NEWS. Writing it into the index let a deployment RECLAIM a name
    // that had already moved to another one: A loses the name, B takes it, A's next fetch fails,
    // and A's stale list put A back in the index and started re-issuing a certificate for it.
    // A cache must never override newer knowledge.
    if (r.source === "relay" || r.source === "none") {
      for (const h of r.hosts) this.#setOwner(h, id);
      for (const h of previous) if (!r.hosts.includes(h) && this.domainOwner.get(h) === key) this.#setOwner(h, null);
    }
    if (before !== r.hosts.join(",")) {
      // A name that has gone away stops being served AND stops being certified: its key is dropped
      // here rather than left on disk answering for a domain this deployment no longer owns.
      for (const h of previous) {
        if (r.hosts.includes(h)) continue;
        // Same rule as forgetDomains: a detached name whose certificate now belongs to another
        // deployment is not ours to delete.
        if (this.hostCerts.get(h)?.owner === key) this.hostCerts.delete(h);
        // Ours to drop only if it IS ours: by now the name may already have been taken by another
        // deployment, whose first attempt must not inherit this one's silence.
        if (this.certReports.get(h)?.owner === key) this.certReports.delete(h);
        if (this.domainFails.get(h)?.owner === key) this.domainFails.delete(h);
      }
      this.log(`domains ${id.slice(0, 10)}: ${r.hosts.length ? r.hosts.join(", ") : "no custom domains"}`);
      this.#record(id, { domains: r.hosts, domainWhy: null });
    }
    // Certificates only for names this box currently believes are OURS. On a kept answer that is
    // whatever the index says, which may be nothing - and asking a CA to certify a name another
    // deployment now holds is the very thing the index exists to prevent.
    for (const h of r.hosts) if (this.domainOwner.get(h) === key) await this.#certifyHost(id, h);
  }

  /**
   * Record who owns a hostname, and bump its GENERATION.
   *
   * The generation is what makes a late answer safe to discard. Certificate issuance is an await
   * of unbounded length - an ACME order can take minutes - and a name can move underneath it. A
   * result that lands after the move must not be stored, however correct it was when it was asked
   * for.
   */
  #setOwner(hostname, id) {
    const cur = this.domainOwner.get(hostname) || null;
    const next = id ? String(id).toLowerCase() : null;
    if (cur === next) return;
    this.domainGen.set(hostname, (this.domainGen.get(hostname) || 0) + 1);
    if (next) this.domainOwner.set(hostname, next); else this.domainOwner.delete(hostname);
  }

  /** One custom hostname's certificate, with its own backoff and its own report to the customer. */
  async #certifyHost(id, hostname) {
    const key = String(id).toLowerCase();
    const have = this.hostCerts.get(hostname);
    // Reused only if it was minted FOR THIS DEPLOYMENT. A name that has moved between deployments
    // gets a fresh certificate for its new owner rather than inheriting the old one: the entry is
    // keyed by hostname across the whole box, and handing B a certificate obtained on A's behalf
    // would have this box assert an identity B never proved. Found by the test - the index said B
    // and the cached entry still said A, so nobody could serve the name at all.
    if (have?.cert && have.owner === key
        && new Date(have.cert.notAfter).getTime() - Date.now() > 7 * 24 * 3600 * 1000) return;
    if (have && have.owner !== key) this.log(`custom domain ${hostname}: moved to ${key.slice(0, 10)}; getting its own certificate`);
    // A backoff belongs to the deployment that EARNED it. Reading it by hostname alone let one
    // deployment's rate-limited order suppress another's first attempt ever - and because that
    // attempt never ran, the previous owner's failure report stayed under the name and went out
    // to the new owner's customer as though it were about them. Found by the test: B's domain sat
    // uncertified for the rest of A's hour while the CA would happily have said yes.
    const fail = this.domainFails.get(hostname);
    if (fail && fail.owner === key && Date.now() < fail.until) return;
    // Captured BEFORE the await. An ACME order can take minutes and a name can move underneath it.
    const gen = this.domainGen.get(hostname) || 0;
    const stillOurs = () => this.domainGen.get(hostname) === gen && this.domainOwner.get(hostname) === key;
    try {
      // `issueCert` is injectable so a test can drive the REAL bookkeeping below - the ownership
      // stamp, the index, the teardown - with the certificate authority stubbed out. A test that
      // wrote into hostCerts itself would be reimplementing the very thing it is checking.
      const issue = this.cfg.issueCert || ensureCert;
      const cert = await issue({ id, endpoint: this.cfg.endpoint, sign: this.cfg.secretsSign,
                                 base: this.cfg.relayBase, dir: this.cfg.dir,
                                 hostname, log: (m) => this.log(m) });
      // The entry carries its OWNER. The map is keyed by hostname across the whole box, so a
      // context found under a name is not by itself evidence that this deployment may present it:
      // belt and braces with the live index below, because between them is another tenant's
      // identity.
      if (!stillOurs()) {
        // The name moved while we were asking. Storing this would put a certificate obtained on
        // our behalf under a name somebody else now owns - and would set `owner` back to us.
        this.log(`custom domain ${hostname}: it moved while its certificate was being issued; discarding the result`);
        return;
      }
      this.hostCerts.set(hostname, { cert, ctx: tls.createSecureContext({ key: cert.key, cert: cert.cert }),
                                     owner: key });
      this.certReports.set(hostname, { owner: key, ok: true, notAfter: cert.notAfter, at: new Date().toISOString() });
      this.domainFails.delete(hostname);
      this.log(`${id.slice(0, 10)} custom domain ready: https://${hostname}/`);
    } catch (e) {
      if (!stillOurs()) return;          // a failure for a name that is no longer ours says nothing
      const wait = Math.max(60, Number(e.retryAfterSec) || 600) * 1000;
      this.domainFails.set(hostname, { owner: key, until: Date.now() + wait });
      // Reported to the CUSTOMER, not just logged here: a CA refusing their domain is something
      // only they can fix, and they cannot see this box's logs.
      this.certReports.set(hostname, { owner: key, ok: false, error: "issue_failed",
                                       message: String(e.message).slice(0, 200), at: new Date().toISOString() });
      this.log(`custom domain ${hostname}: ${e.message} (retrying in ${Math.round(wait / 1000)}s)`);
    }
  }

  /**
   * Drop every hostname this deployment answered on, with its key and its pending report.
   *
   * One function so that losing a lease, giving one up and a name being detached all converge -
   * and so a test can exercise the REAL cleanup instead of repeating it, which would go green
   * against a regression in the thing it is meant to guard.
   *
   * A hostname is only released from the global index if THIS deployment still owns it: a name
   * already reassigned belongs to somebody else, and taking it out on the old owner's teardown
   * would leave the new one unable to serve it.
   */
  forgetDomains(id) {
    const key = String(id).toLowerCase();
    for (const h of this.domains.get(key) || []) {
      // Only what this deployment STILL owns. A name already reassigned belongs to somebody else,
      // and taking its certificate out on the old owner's teardown would leave the new one unable
      // to serve a domain it legitimately holds - found by the test, not by reading.
      if (this.domainOwner.get(h) !== key) continue;
      this.domainOwner.delete(h);
      if (this.hostCerts.get(h)?.owner === key) this.hostCerts.delete(h);
      this.certReports.delete(h);
      this.domainFails.delete(h);
    }
    this.domains.delete(key);
  }

  /**
   * The wallet that may reach this deployment, if it is PRIVATE - otherwise null.
   *
   * Read from the ledger record this box already holds, so the answer cannot drift from the
   * deployment's own state. A record this box does not have returns null, which means "not
   * private here": the caller is about to get a 404 from the app path anyway, and pretending a
   * deployment we do not serve is private would leak that it exists somewhere.
   */
  privateOwner(id) {
    const rec = this.records.get(String(id).toLowerCase());
    if (!rec || rec.isPublic !== false) return null;
    return String(rec.owner || "").toLowerCase() || null;
  }

  /** Every hostname a deployment answers on: its own subdomain first, then the customer's. */
  hostsFor(id) {
    const names = [];
    const rec = this.records.get(String(id).toLowerCase());
    if (rec?.appHost) names.push(rec.appHost);
    else names.push(appHostFor(id, this.cfg.appZone));
    for (const h of this.domains.get(String(id).toLowerCase()) || []) names.push(h);
    return names;
  }

  /**
   * What the app zone needs to serve one deployment: its protection rules (so a request is parsed
   * rather than spliced), its body ceiling (so the READ stops at the limit instead of buffering
   * past it), and which certificate to present for a given SNI name.
   *
   * Public rather than private because the app zone is a separate module that consumes it, and
   * because a test that reimplements `contextFor` proves only that the reimplementation works -
   * which is exactly how a cross-tenant check would go green while the real one drifted.
   */
  zoneRules(id) {
    const key = String(id).toLowerCase();
    const w = this.records.get(key)?.waf || null;
    // contextFor: the certificate to present for a given SNI name. The app zone cannot know which
    // of a deployment's hostnames a browser asked for until the ClientHello arrives, so the choice
    // is a callback rather than a field. An unknown name answers null and the default is served,
    // which gives the browser a name mismatch it can explain rather than a reset.
    return {
      waf: w, bodyLimit: waf.bodyLimit(w),
      // A private deployment must be PARSED rather than spliced to its port: an opaque byte stream
      // carries no Authorization header and no cookie, so there is nothing to check. The app zone
      // reads this and takes the parsed path, which ends in `proxy` above.
      private: !!this.privateOwner(key),
      contextFor: (name) => {
        const h = String(name || "").toLowerCase().replace(/\.+$/, "");
        // Asked of the LIVE index at handshake time, not of a list captured when this object was
        // built. Certificates are keyed by hostname across the whole box, so a name that moves
        // between deployments would otherwise let the OLD owner keep serving it - presenting the
        // NEW owner's certificate - for as long as the captured array survived, and a connection
        // can sit between `resolve` and its ClientHello for as long as a client cares to take.
        if (this.domainOwner.get(h) !== key) return null;
        const e = this.hostCerts.get(h);
        // BOTH must agree. The index says who owns the name now; the entry says who the context
        // was minted for. A disagreement is a name mid-move, and mid-move nobody serves it.
        return e && e.owner === key ? e.ctx : null;
      },
    };
  }

  async appZoneTarget(ref) {
    // A label (the first 8 hex, which is what the hostname carries) or a full id: resolved against
    // the leases this box holds, so a prefix that matches nothing here is simply not ours.
    let id = String(ref).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) {
      const pre = id.startsWith("0x") ? id : "0x" + id;
      const hit = [...this.records.keys()].filter((k) => k.startsWith(pre));
      if (hit.length !== 1) return null;
      id = hit[0];
    }
    const rec = this.records.get(id);
    // AN ISOLATED DEPLOYMENT HAS NO `app` HERE, AND MUST NOT NEED ONE.
    //
    // Its process is a partition, not an entry in this.apps, so the checks below - which want a
    // port and a certificate this agent holds - are all wrong for it. Before this, an isolated
    // record fell through to `!app` and answered null, which the app zone turns into a 503: the
    // deployment would have been running and unreachable (enclave-5d, tracing the real route).
    //
    // Nothing here terminates TLS for it. The target says only WHICH domain to splice to; the
    // guest holds the key and does the handshake, which is the entire point of the tier.
    if (rec && rec.isolation) {
      const { isolatedTarget } = await import("../vbslike/datapath/node-bridge.mjs");
      return isolatedTarget(id, rec, this.cfg.appZone);
    }
    const app = this.apps.get(id);
    if (!rec || rec.status !== "running" || !app) return null;
    // A server-shaped app has a port to proxy into. A GATE-SERVED app (wasi:http, enclave:app)
    // does not, so its origin is served the other way: the TLS session is terminated here, the
    // request is parsed out of it and carried through the gate as a frame, exactly as the /x/
    // path does. Either way the app's own hostname works, which is what a browser needs before
    // it will show a closed padlock.
    const gate = !app.port;
    const have = this.appCerts.get(id);
    if (have && have.cert && !have.cert.selfSigned) return { id, port: app.port, gate, cert: have.cert, ...this.zoneRules(id) };
    // The FALLBACK pair, while the real certificate is being issued. Without it the connection
    // dies at the first byte and the failure reads as a broken box rather than a certificate that
    // has not arrived; with it the path is provable (a client told to skip verification gets the
    // app) and a browser sees exactly what the console's amber padlock is warning about. The
    // platform's own boxes do the same thing.
    const fallback = () => {
      let f = this.appCerts.get(id);
      if (!f || !f.cert) {
        f = { cert: selfSigned(appHostFor(id, this.cfg.appZone)) };
        this.appCerts.set(id, f);
        this.log(`${id.slice(0, 10)} app-zone: serving a self-signed pair for ${f.cert.name} until the real one is issued`);
      }
      return { id, port: app.port, gate, cert: f.cert, ...this.zoneRules(id) };
    };
    const fail = this.appCertFails.get(id);
    if (fail && Date.now() < fail) return fallback();
    if (this.appCertInflight.has(id)) return fallback();
    this.appCertInflight.add(id);
    try {
      const cert = await ensureCert({ id, endpoint: this.cfg.endpoint, sign: this.cfg.secretsSign,
                                      base: this.cfg.relayBase, dir: this.cfg.dir,
                                      zone: this.cfg.appZone, log: (m) => this.log(m) });
      this.appCerts.set(id, { cert });
      this.#record(id, { appHost: cert.name, certNotAfter: cert.notAfter });
      return { id, port: app.port, gate, cert, ...this.zoneRules(id) };
    } catch (e) {
      const wait = Math.max(30, Number(e.retryAfterSec) || 300) * 1000;
      this.appCertFails.set(id, Date.now() + wait);
      this.log(`certificate for ${appHostFor(id, this.cfg.appZone)} not ready: ${e.message} (retrying in ${Math.round(wait / 1000)}s)`);
      return fallback();
    } finally { this.appCertInflight.delete(id); }
  }

  /** Carry an /x/:id/... request to that deployment's app: into the enclave, or to a local port. */
  async proxy(id, { method, pathRest, headers, body, ip = null }) {
    const key = String(id).toLowerCase();
    // THE DEPLOYMENT'S OWN PROTECTION RULES, before the app is consulted. Both of this box's doors
    // funnel through here - the relay's /x/<id> path and the app's own hostname - so the rules
    // hold on either, which is the property the envelope promises.
    // A PRIVATE DEPLOYMENT IS CHECKED HERE, in the one place every HTTP serving path funnels
    // through: the relay's /x/<id> and the app zone's own hostname both end up in this function.
    // The check used to live in the agent's /x/ handler alone, which left a private app reachable
    // anonymously on its own hostname - the hole this moved to close.
    //
    // AFTER the protection rules and before anything else, mirroring the platform runner: a flood
    // on a private deployment must not be able to grind token verification either.
    const priv = this.privateOwner(key);
    const denyPrivate = () => {
      if (!this.cfg.sessionVerify) {
        // FAIL CLOSED. A box that cannot prove who is asking must not serve a deployment whose
        // whole contract is that only one wallet may reach it. This should be unreachable - the
        // claim gate refuses private deployments without a verifier - but "should be" is not a
        // reason to serve one.
        return { status: 503, headers: { "content-type": "application/json" },
                 body: JSON.stringify({ error: "no_session_key",
                                        message: "This box cannot verify who is asking, so it will not serve a private deployment." }) };
      }
      const who = this.cfg.sessionVerify(headers || {}, key);
      if (!who) return { status: 401, headers: { "content-type": "application/json" },
                         body: JSON.stringify({ error: "unauthorized", message: "Missing or invalid token." }) };
      if (who !== priv) return { status: 403, headers: { "content-type": "application/json" },
                                 body: JSON.stringify({ error: "forbidden", message: "Not your deployment." }) };
      return null;
    };
    const w = this.records.get(key)?.waf;
    if (w) {
      // The ACTUAL body length, not the declared one. By the time a request reaches here the body
      // is whole (the relay hands /x/ a complete frame; the app zone counts as it reads), so this
      // is the guard that holds when content-length is absent or lying.
      const bodyBytes = body == null ? 0 : (Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body));
      const v = waf.check(key, w, { method, url: pathRest, headers: headers || {}, ip, bodyBytes });
      if (v && !v.allow) {
        return { status: v.status, headers: { "content-type": "application/json", ...(v.headers || {}) },
                 body: JSON.stringify({ error: v.error, message: v.message }) };
      }
      // An allowed request holds a concurrency slot until it is answered. try/finally rather than
      // a callback: every return below this point has to give the slot back, including the throws.
      try {
        if (priv) { const no = denyPrivate(); if (no) return no; }
        return await this.#proxyApp(key, { method, pathRest, headers, body });
      } finally { v.release(); }
    }
    if (priv) { const no = denyPrivate(); if (no) return no; }
    return await this.#proxyApp(key, { method, pathRest, headers, body });
  }

  async #proxyApp(id, { method, pathRest, headers, body }) {
    const app = this.apps.get(String(id).toLowerCase());
    if (!app || app.state !== "running") return { status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not_running", id, state: app?.state || "unknown", reason: this.records.get(String(id).toLowerCase())?.reason || null }) };
    if (app instanceof EnclaveApp) {
      try {
        const r = await app.handle({ method, pathRest, headers, body });
        this.#record(String(id).toLowerCase(), { enclaveUs: r.enclaveUs });
        return { status: r.status, headers: r.headers, body: r.body };
      } catch (e) {
        // "no such app" means the enclave restarted under us and its memory went with it, which is
        // the honest failure mode for an app that lives in there. Mark it for reload rather than
        // pretending the app is still up.
        const gone = /no such app/i.test(e.message || "");
        if (gone) { app.state = "failed"; this.#record(String(id).toLowerCase(), { status: "failed", reason: "the enclave no longer carries this app (it restarted); reloading" }); }
        return { status: 502, headers: { "content-type": "application/json" },
                 body: JSON.stringify({ error: gone ? "app_gone" : "enclave_error", message: e.message }) };
      }
    }
    const hdrs = {};
    for (const [k, v] of Object.entries(headers || {})) if (!/^host$|^connection$|^x-metal-|^x-enclave-/i.test(k)) hdrs[k] = v;
    return await new Promise((resolve) => {
      // The app's RESPONSE is buffered whole here (both doors hand back a complete answer), so it
      // needs the same bound its request has. An app that streams without end - a bug, or a tenant
      // who does not care - would otherwise exhaust the agent's memory and take every OTHER tenant
      // on this box down with it. Same class as the request-body hole, the other direction.
      const cap = Math.round((Number(this.cfg.maxBodyMb) || 64) * 1048576);
      const req = http.request({ host: "127.0.0.1", port: app.port, method: method || "GET", path: pathRest || "/", headers: { ...hdrs, host: `127.0.0.1:${app.port}` } }, (r) => {
        const chunks = [];
        let seen = 0, over = false;
        r.on("data", (c) => {
          if (over) return;
          seen += c.length;
          if (seen > cap) {
            over = true;
            this.log(`${String(id).slice(0, 10)} answered with more than ${cap} bytes; cutting it off`);
            try { req.destroy(new Error("response too large")); } catch {}
            return resolve({ status: 502, headers: { "content-type": "application/json" },
                             body: JSON.stringify({ error: "app_response_too_large",
                                                    message: `The app answered with more than ${(cap / 1048576).toFixed(0)} MB.` }) });
          }
          chunks.push(c);
        });
        r.on("end", () => { if (!over) resolve({ status: r.statusCode || 502, headers: r.headers, body: Buffer.concat(chunks) }); });
      });
      req.setTimeout(120_000, () => { req.destroy(new Error("app timed out")); });
      req.on("error", (e) => resolve({ status: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "app_unreachable", message: e.message }) }));
      if (body && body.length) req.write(body);
      req.end();
    });
  }
}
