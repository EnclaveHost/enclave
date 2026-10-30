// Strict source-hash patch generator: baseline windows/node/host.mjs (exact SHA-256) -> a SEPARATE host candidate with
// the lifecycle routing guards inserted at exact, unique anchors. Insertions only: every baseline byte is retained, in
// order, and the generator proves it by removing its insertions and comparing to the baseline. It never writes the
// baseline, never overwrites an existing output, and refuses a changed hash, a missing or duplicate anchor, overlapping
// edits or an input that already carries a patch.
//
//   node generate-lifecycle-host-candidate.mjs /abs/baseline/windows/node/host.mjs /abs/output/host.lifecycle-candidate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BASELINE_HOST_SHA256 = '8f0b92bb7b3eb0662d706ab0da0f80b07ec4621f78105384c59a907b89d469c7';
export const BASELINE_COMMIT = 'b7dcf5af9';
const sha256 = s => createHash('sha256').update(s).digest('hex');

// { name, before, after, text }: `before + after` must occur exactly once; `text` goes between them.
export const EDITS = Object.freeze([
  { name: 'import',
    before: 'import { isSessionHeader } from "./session-api-auth.mjs";\n',
    after: '\n/** The delegations this box carries:',
    text: '// THE EVENT-DRIVEN LIFECYCLE ROUTES (network/lifecycle-host-dispatch.mjs): only from an explicitly composed cfg.lifecycleDispatch.\n'
      + 'import { attachLifecycleDispatch } from "../../network/lifecycle-host-dispatch.mjs";\n' },
  { name: 'constructor',
    before: '    this.verifierMarket = null;\n',
    after: '  }\n  /**\n   * The startup authority, built lazily',
    text: `    // EVENT-DRIVEN LIFECYCLE ROUTES: immutable per-deployment routes from an explicitly composed dispatch, never from the
    // environment or the address book. None (the default) leaves every legacy path below exactly as it was. A routed id is
    // excluded from every legacy claim, renewal, release, proof checkpoint and restart from here on, activated or not.
    this.lifecycle = attachLifecycleDispatch(cfg.lifecycleDispatch ?? null, {
      hostId: this.enclaveId,
      legacyLedger: () => chain.addresses.deployments,
      legacyHold: (id) => chain.releaseHold(id),
      serviceRestriction: () => this.platformPolicy.serviceRefusal() || (this.caps.paused === true ? "the owner of this box turned hosting off" : null),
      newWorkRestriction: () => this.platformPolicy.newWorkRefusal(),
      legacyActivity: (id) => this.#lifecycleLegacyActivity(id),
      record: (id, patch) => this.#record(id, patch),
      log: (m) => this.log(m),
    });
` },
  { name: 'init-start',
    before: '    this.platformPolicy.start();\n',
    after: '    setInterval(() => this.tick().catch((e) => this.log(`tick: ${e.message}`)), TICK_MS);',
    text: `    // routed ids are held until their own verified quiescence evidence activates them; the cadence carries off-chain permits
    if (this.lifecycle) { this.lifecycle.start(); this.lifecycle.activate().catch((e) => this.log(\`lifecycle routes held: \${e.message}\`)); }
` },
  { name: 'helpers',
    before: '  listedAt() { return Number(this.registered?.registeredAt || 0); }\n',
    after: '\n  /**\n   * Consider a deployment: the policy first',
    text: `
  /** An immutable lifecycle route owns this id: no legacy claim/renew/release/prove/restart path may act on it. */
  #lifecycleOwns(id) { return !!this.lifecycle && this.lifecycle.owns(String(id || "").toLowerCase()); }
  /** What this process's legacy machinery still holds for a routed id; a route activates only when this is empty. */
  #lifecycleLegacyActivity(id) {
    const busy = [], rec = this.records.get(id);
    if (this.#renewing.has(id)) busy.push("a legacy renewal in flight");
    if (this.#givingUp.has(id)) busy.push("a legacy give-up in flight");
    if (this.apps.has(id)) busy.push("a legacy engine app");
    if (rec && rec.lifecycle !== true && ["running", "provisioning", "claiming"].includes(rec.status)) busy.push(\`a legacy record (\${rec.status})\`);
    if (rec?.isolation?.instance || rec?.isolationHeld || rec?.isolationRetireFailed) busy.push("a legacy isolated domain");
    return busy;
  }
  #lifecycleRefused(what) { return \`managed by its event-driven lifecycle route: the legacy \${what} path is refused for it\`; }
` },
  { name: 'consider',
    before: '    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };\n',
    after: '    // a sponsored release of it may still land',
    text: '    if (this.#lifecycleOwns(id)) return this.lifecycle.considerHint(id, { force });   // never a claim, never v1\n' },
  { name: 'restart',
    before: '  async restart(id, d) {\n    id = String(id).toLowerCase();\n',
    after: '    const refuse = this.restartRefusal(id, d);',
    text: '    if (this.#lifecycleOwns(id)) { const reason = this.#lifecycleRefused("restart"); this.log(`restart ${id.slice(0, 10)} refused: ${reason}`); return { refused: true, reason }; }\n' },
  { name: 'restartRequest',
    before: '    if (!/^0x[0-9a-f]{64}$/.test(id)) return j(422, { error: "bad_id", message: "id must be the bytes32 deployment id" });\n',
    after: '    const auth = (headers || {}).authorization;',
    text: '    if (this.#lifecycleOwns(id)) return j(409, { error: "refused", id, reason: this.#lifecycleRefused("restart") });\n' },
  { name: 'ensureApp',
    before: '  async ensureApp(id, d, { force = false, version = null } = {}) {\n',
    after: '    const wallet = await this.#walletPolicyState({ ...d, id });\n    if (wallet.refusal) return await this.#giveUp(id, wallet.refusal, { retry: true });',
    text: '    if (this.#lifecycleOwns(id)) { this.log(`${String(id).slice(0, 10)} ${this.#lifecycleRefused("launch")}`); return this.records.get(id) || null; }\n' },
  { name: 'scanLedger',
    before: '      const id = String(d.id).toLowerCase();\n',
    after: '      if (this.blocked.has(id)) continue;',
    text: '      if (this.#lifecycleOwns(id)) continue;               // routed: its lifecycle dispatch, never a legacy claim here\n' },
  { name: 'renewDue',
    before: '      const early = lead && lead.leaseUntil === seen?.leaseUntil && now - lead.at < RENEW_LEAD_CACHE_MS && until - now >= lead.ms;\n',
    after: '      return seen && !early && until > now',
    text: '      if (this.#lifecycleOwns(id)) return false;          // routed: no legacy renewal, ever\n' },
  { name: 'renewSend',
    before: '  async #renewSend(id, d, permit) {\n',
    after: '    const untilS = Number(d.leaseUntil);\n    if (this.#renewedFrom.get(id) === untilS) return { extended: true };',
    text: '    if (this.#lifecycleOwns(id)) return { superseded: this.#lifecycleRefused("renewal") };\n' },
  { name: 'reconcileTracked',
    before: '  async #reconcileTracked(id, { deferClaim = false } = {}) {\n',
    after: '    let d; try { d = await chain.readDeployment(id); } catch { return; }',
    text: `    // ROUTED: no legacy read, renewal, give-up, re-claim or adoption. Its lifecycle dispatch reconciles it on its own cadence.
    if (this.#lifecycleOwns(id)) {
      this.#leaseSeen.delete(id); this.#renewVoid(id);
      this.#leaseChecks.set(id, { id, sequence: this.#leaseSequence, status: "lifecycle", checkedAt: Date.now() });
      return;
    }
` },
  { name: 'giveUp',
    before: '  #giveUp(id, why, opts = {}) {\n',
    after: '    const busy = this.#givingUp.get(id);',
    text: '    if (this.#lifecycleOwns(id)) return this.lifecycle.restrict(id, why);   // enforced locally (fence, stop); nothing released on v1\n' },
  { name: 'stopApp',
    before: '  async #stopApp(id, why) {\n',
    after: '    this.#renewVoid(id);\n    this.#walletRevoke(id);\n    // BEFORE forgetting anything',
    text: '    if (this.#lifecycleOwns(id)) { this.log(`${String(id).slice(0, 10)} legacy stop not applied (${why}): ${this.#lifecycleRefused("stop")}`); return; }\n' },
  { name: 'proveAll',
    before: '    for (const [id, rec] of this.records) {\n',
    after: '      if (!rec || rec.status !== "running" || !rec.leaseUntil || free(id, rec)) continue;',
    text: '      if (this.#lifecycleOwns(id)) continue;              // no v1 checkpoint for a routed id; v2 settlement is separate\n' },
  { name: 'retireForeignRecovered',
    before: '      const rec = this.records.get(owner);\n',
    after: '      if (v.recovered !== true || !/^0x[0-9a-f]{64}$/.test(owner) || this.tracked.has(owner)',
    text: '      if (this.#lifecycleOwns(owner)) continue;           // the lifecycle runtime owns its manager names\n' },
  { name: 'runUnleased',
    before: '  async runUnleased({ appRef, cid, id }) {\n',
    after: '    if (!this.cfg.appsEnabled) throw new Error("apps are not enabled on this node (APPS=1)");',
    text: '    if (id && this.#lifecycleOwns(id)) throw new Error(this.#lifecycleRefused("unleased run"));\n' },
]);

const count = (s, sub) => { let n = 0; for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + 1)) n++; return n; };

/** baseline text -> { source, sha256, manifest }. Pure: no I/O. Throws on any mismatch. */
export function generateHostCandidate(baseline, { expectedSha256 = BASELINE_HOST_SHA256, edits = EDITS } = {}) {
  if (typeof baseline !== 'string') throw Error('baseline source text required');
  const got = sha256(baseline);
  if (got !== expectedSha256) throw Error(`baseline host.mjs hash ${got} is not the pinned ${expectedSha256}`);
  if (baseline.includes('lifecycle-host-dispatch.mjs') || baseline.includes('#lifecycleOwns')) throw Error('baseline already carries lifecycle routing');
  const names = new Set();
  const placed = edits.map(e => {
    if (!e.name || names.has(e.name)) throw Error(`edit name missing or duplicate: ${e.name}`);
    names.add(e.name);
    if (!e.before || !e.after || !e.text) throw Error(`edit ${e.name} is incomplete`);
    const anchor = e.before + e.after, n = count(baseline, anchor);
    if (n !== 1) throw Error(`edit ${e.name}: anchor ${n === 0 ? 'missing' : `duplicated (${n})`}`);
    if (count(baseline, e.text)) throw Error(`edit ${e.name}: insertion already present`);
    const start = baseline.indexOf(anchor);
    return { ...e, start, at: start + e.before.length, end: start + anchor.length };
  }).sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i++)
    if (placed[i].start < placed[i - 1].end) throw Error(`edits ${placed[i - 1].name} and ${placed[i].name} overlap`);
  let out = '', cursor = 0;
  const manifest = [];
  for (const e of placed) {
    out += baseline.slice(cursor, e.at);
    manifest.push({ name: e.name, baselineLine: baseline.slice(0, e.at).split('\n').length, candidateOffset: out.length, length: e.text.length });
    out += e.text; cursor = e.at;
  }
  out += baseline.slice(cursor);
  // Self-proof: removing exactly the insertions restores the pinned baseline byte for byte.
  let restored = '', from = 0;
  for (const m of manifest) { restored += out.slice(from, m.candidateOffset); from = m.candidateOffset + m.length; }
  restored += out.slice(from);
  if (restored !== baseline || sha256(restored) !== expectedSha256) throw Error('candidate does not preserve the baseline');
  return { source: out, sha256: sha256(out), baselineSha256: got, manifest };
}

export function writeHostCandidate(baselineFile, outputFile) {
  if (!path.isAbsolute(baselineFile) || !path.isAbsolute(outputFile)) throw Error('absolute baseline and output paths required');
  const real = fs.realpathSync(baselineFile);
  const outDir = fs.realpathSync(path.dirname(outputFile));
  const outReal = path.join(outDir, path.basename(outputFile));
  if (outReal === real || outDir === path.dirname(real)) throw Error('the candidate must be written outside the baseline directory');
  const baseline = fs.readFileSync(real, 'utf8');
  const r = generateHostCandidate(baseline);
  fs.writeFileSync(outReal, r.source, { flag: 'wx', mode: 0o644 });   // never overwrites
  if (sha256(fs.readFileSync(real, 'utf8')) !== BASELINE_HOST_SHA256) throw Error('baseline changed during generation');
  return { output: outReal, sha256: r.sha256, baselineSha256: r.baselineSha256, manifest: r.manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [baselineFile, outputFile] = process.argv.slice(2);
  if (!baselineFile || !outputFile) { console.error('usage: generate-lifecycle-host-candidate.mjs <baseline host.mjs> <output file>'); process.exit(2); }
  console.log(JSON.stringify(writeHostCandidate(baselineFile, outputFile), null, 1));
}
