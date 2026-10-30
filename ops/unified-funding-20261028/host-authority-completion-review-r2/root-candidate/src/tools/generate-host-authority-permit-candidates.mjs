// host-authority permit r1 strict hash-pinned ADDITIVE generator (SOURCE ONLY), with root r2's REQUIRED correction (host-wide advance
// invalidates only grants of THAT host: e.host === c.hostId) and the completion r2 edits. Insertions only, each output self-proves
// byte-for-byte restoration of its pinned input (root r3 insertion-patch.mjs 53eeef0d). Inputs (exact reviewed baselines):
//   deployment-serving-permit.mjs    82494ed8  v2 typed data + verifier-side host-authority check; v1 untouched
//   deployment-permit-gate.mjs       e198fe21  durable floor/Offline/handoff before resources; same-host invalidation; bound assert/track
//   deployment-lifecycle-witness.mjs 9859a130  own-reader authority + durable Offline; floor before signing; FINAL read re-checks every guard
//   deployment-isolation-runtime.mjs 40333d5b  v2 record producer, REAL snapshot->servingContext conversion, bound track/assert/ack, handoffs
//   deployment-chain-adapter.mjs     b648a3ed  root r3 GENERATED adapter (schema3 + canonical registry applied ONCE; not re-run here):
//                                              durable prepared host authority in the canonical payload + final pre-relay.send guard
// Every behavioral insertion is guarded by explicit pins (pins.servingPermit v2) or the adapter's existing HR profile flag; v1/default,
// independent-r1 and independent-schema3-r1 keep their exact behavior. Marker: 'host-authority permit r1' (absent from every input).
//
//   node generate-host-authority-permit-candidates.mjs <abs dir holding the five exact baselines> <abs output dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInsertions, sha256 } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/host-registry-repair-root-review-r3/src/tools/insertion-patch.mjs';

export const MARKER = 'host-authority permit r1';
export const INPUT_SHA256 = Object.freeze({
  'deployment-serving-permit.mjs': '82494ed819f91f65565391dc3f61a16341fc3465df0bf47a3ec823a8b8de0e61',
  'deployment-permit-gate.mjs': 'e198fe2160cf9ab31f1c473856c44d58e51c995ce0fe0f0907c94c2d39c8661b',
  'deployment-lifecycle-witness.mjs': '9859a1307a83ff4f60ae6088c6533b0666ae12497c49794b9ef9ee32569551c0',
  'deployment-isolation-runtime.mjs': '40333d5bc08796f2881650331022746abc0b93051b48351c89f84d62a4462fd9',
  'deployment-chain-adapter.mjs': 'b648a3edf805252e239f548a4816b90b8281999b848d2ecece453cee7b8c226d' });
for (const [f, h] of Object.entries(INPUT_SHA256)) if (!/^[0-9a-f]{64}$/.test(h)) throw Error(`pinned input hash for ${f} is not 64 hex characters`);

const SERVING_PERMIT = [
  { name: 'import', before: "import { canRestoreLifecycleDenial, lifecycleHostAdmitted } from './deployment-authority-window.mjs';\n", after: 'const OPERATIONAL = Symbol(',
    text: "// host-authority permit r1: explicit v2 (pins.servingPermit) binds the exact canonical host authority; v1 unchanged\n" +
      "import { isHostAuthorityPermit, servingPermitTypedDataV2, checkPermitHostAuthority } from './deployment-host-authority.mjs';\n" },
  { name: 'typed-v2', before: 'export function servingPermitTypedData(pins, record) {\n', after: "  if (!Number.isSafeInteger(pins.chainId) || pins.chainId < 1) throw new Error('invalid chain');",
    text: '  if (isHostAuthorityPermit(pins)) return servingPermitTypedDataV2(pins, record);   // host-authority permit r1: separate domain version\n' },
  { name: 'validate-params', before: 'export function validateServingPermitContext(record, { pins, assignment, policy, nowSec, floor = null', after: ' }) {',
    text: ', hostAuthority, hostAdmitted, hostAuthorityFloor = null, generationAuthority' },
  { name: 'validate-v2', before: '  const digest = hashTypedData(data);\n', after: '  if (floor && (floor.generation > r.generation',
    text: '  if (isHostAuthorityPermit(pins)) checkPermitHostAuthority(r, { hostAuthority, hostAdmitted, hostAuthorityFloor, assignment, generationAuthority });   // host-authority permit r1\n' },
  { name: 'verify-return', before: '  return { record: r, assignment: options.assignment, policy, restoredAt: options.restoredAt,\n', after: '    signers: [...signers]',
    text: '    ...(isHostAuthorityPermit(options.pins) ? { hostAuthority: r.hostAuthority } : {}),   // host-authority permit r1\n' },
];

const GATE = [
  { name: 'import', before: "import { verifyServingPermit, servingAssignmentBinding } from './deployment-serving-permit.mjs';\n", after: '\nexport class DeploymentPermitGate {',
    text: '// host-authority permit r1: v2 gates store/compare the exact host authority (durable sidecar) before any resource is allowed\n' +
      "import { isHostAuthorityPermit, validateHostAuthorityContext } from './deployment-host-authority.mjs';\n" },
  { name: 'ctor-param', before: '  constructor({ pins, journal, now = Date.now, monotonic = () => performance.now(),', after: '\n    timers = { set: setTimeout', text: ' hostAuthority = null,' },
  { name: 'ctor-assign', before: '    Object.assign(this, { pins, journal, now, monotonic, timers, onError', after: ' });', text: ', hostAuthority' },
  { name: 'ctor-require', before: '    this.entries = new Map(); this.epochs = new Map(); this.resources = new Map();\n', after: '    this.lastWall = now();',
    text: "    if (isHostAuthorityPermit(pins) && (typeof hostAuthority?.accept !== 'function' || typeof hostAuthority?.observe !== 'function')) throw Error('v2 permit gate requires the durable host authority journal');   // host-authority permit r1\n" },
  { name: 'observe-evidence', before: '    const row = this.journal.read(id);\n', after: '    const floor = row.digest ? { generation: row.generation',
    text: '    if (isHostAuthorityPermit(this.pins)) this.observeHostEvidence(context?.hostAuthority);   // completion r2: authenticated Offline is durable + host-wide BEFORE verification\n' },
  { name: 'verify-floor', before: '      nowSec: Math.floor(wall / 1000), floor, denyFloor: row.denial', after: ' }); }',
    text: ', ...(isHostAuthorityPermit(this.pins) ? { hostAuthorityFloor: this.hostAuthority.read(envelope.record.host)?.floor ?? null } : {})' },
  { name: 'accept-before-resources', before: '    const r = result.record;\n    try {\n', after: '      if (result.restoredAt !== undefined',
    text: '      if (isHostAuthorityPermit(this.pins)) this.#acceptHostAuthority(id, result);   // host-authority permit r1: durable floor + explicit handoff BEFORE any resource\n' },
  { name: 'drop-on-change', before: "    if (old && (old.generation !== r.generation || old.host !== r.host)) this.#dropResources(id, 'assignment changed');\n", after: '    const entry = {',
    text: "    if (old && (old.hostAuthority ?? null) !== (result.hostAuthority?.digest ?? null)) this.#dropResources(id, 'host authority changed');   // host-authority permit r1\n" },
  { name: 'entry-field', before: '    const entry = { host: r.host, generation: r.generation, digest: result.floor.digest,', after: '\n      until: result.serveUntil',
    text: ' hostAuthority: result.hostAuthority?.digest ?? null,' },
  { name: 'install-return', before: '    return { generation: r.generation, host: r.host, validUntil: entry.until', after: ' };\n  }\n  assert(',
    text: ', ...(entry.hostAuthority ? { hostAuthority: entry.hostAuthority } : {})' },
  { name: 'assert-param', before: '  assert(id, { host, generation', after: ' }) {', text: ', hostAuthority = null' },
  { name: 'assert-check', before: '    if (this.closed || !e || e.host !== host || e.generation !== generation', after: ' || wall >= e.until',
    text: ' || (e.hostAuthority ?? null) !== hostAuthority' },
  { name: 'methods', before: '    return e.until;\n  }\n', after: '  track(id, binding, close) {',
    text: `  // ---- host-authority permit r1 + completion r2 ----------------------------------------------------------------------------
  #acceptHostAuthority(id, result) {
    const c = validateHostAuthorityContext(result.hostAuthority);
    // completion r2 coupling: an owned protocol journal that already holds this app's permit floor proves the sidecar was established
    if (!this.hostAuthority.read(c.hostId) && this.journal.read(id).digest) throw Error('established permit state without its host authority journal: unknown');
    this.observeHostAuthority(c);
    const b = this.hostAuthority.read(c.hostId)?.bound?.[id];
    if (!b || b.digest !== c.digest) throw Error('host authority changed or was never handed to this app context: explicit safe handoff required');
  }
  /** An authenticated advance of the host-wide floor withdraws every installed grant of ANOTHER authority for THAT host only. */
  observeHostAuthority(c) {
    validateHostAuthorityContext(c);
    let how;
    try { how = this.hostAuthority.accept(c.hostId, c); }
    catch (e) {   // rollback/equivocation/recorded Offline refuses THIS context; an uncertain durable state withdraws everything
      if (this.hostAuthority.failed?.()) for (const id of new Set([...this.entries.keys(), ...this.resources.keys()])) this.hold(id, 'host authority journal unknown');
      throw e;
    }
    if (how === 'advance') for (const [id, e] of [...this.entries]) if (e.host === c.hostId && e.hostAuthority !== c.digest) this.hold(id, 'host authority advanced');
    return how;
  }
  /**
   * completion r2: the caller's OWN authenticated evidence. An Offline observation for host H is recorded durably (no identity increment)
   * and withdraws EVERY grant of H; other hosts are untouched. Unqualified/Online/request-shaped evidence is ignored (never a veto).
   */
  observeHostEvidence(e) {
    const hostId = e?.context?.hostId;
    if (typeof hostId !== 'string' || !/^0x[0-9a-f]{64}$/.test(hostId)) return 'ignored';
    let how;
    try { how = this.hostAuthority.observe(hostId, e); }
    catch (err) {
      if (this.hostAuthority.failed?.()) for (const id of new Set([...this.entries.keys(), ...this.resources.keys()])) this.hold(id, 'host authority journal unknown');
      throw err;
    }
    if (how === 'recorded' || how === 'already') for (const [id, x] of [...this.entries]) if (x.host === hostId) this.hold(id, 'canonical host Offline');
    return how;
  }
  /** Explicit safe handoff of ONE app context to the exact CURRENT Online host authority, only while nothing of it is installed or tracked. */
  handoffHostAuthority(id, c, { kind }) {
    if (this.closed) throw Error('permit gate closed');
    if (this.entries.has(id) || this.resources.has(id)) throw Error('handoff requires the app context withdrawn first (no installed grant or tracked resource)');
    this.observeHostAuthority(c);
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);   // an install already awaiting verification is superseded
    return this.hostAuthority.bind(c.hostId, id, c, { kind, at: this.#clock() });
  }
` },
];

const WITNESS = [
  { name: 'import', before: "import { canRestoreLifecycleDenial, lifecycleHostAdmitted } from './deployment-authority-window.mjs';\n", after: '\nexport class DeploymentLifecycleWitness {',
    text: "// host-authority permit r1: a v2 witness derives the host authority from its OWN authenticated reader and durable floor\n" +
      "import { isHostAuthorityPermit, validateHostAuthorityContext } from './deployment-host-authority.mjs';\n" },
  { name: 'ctor-param', before: '  constructor({ pins, account, journal, authority, health, now = Date.now, requestTimeoutMs = 10000', after: ' }) {', text: ', hostAuthorityJournal = null' },
  { name: 'ctor-assign', before: '    Object.assign(this, { pins, account, journal, authority, health, now, requestTimeoutMs', after: ' });', text: ', hostAuthorityJournal' },
  { name: 'ctor-require', before: '    Object.assign(this, { pins, account, journal, authority, health, now, requestTimeoutMs });\n', after: '    this.busy = new Set();',
    text: "    if (isHostAuthorityPermit(pins) && (typeof hostAuthorityJournal?.accept !== 'function' || typeof hostAuthorityJournal?.observe !== 'function')) throw Error('v2 witness requires its durable host authority journal');   // host-authority permit r1\n" },
  { name: 'observe-offline', before: '        nowSec: Math.floor(this.now() / 1000), denyFloor: row.denial });\n', after: '      const floor = row.digest ? { generation: row.generation',
    text: '      if (isHostAuthorityPermit(this.pins)) this.hostAuthorityJournal.observe(record.host, context.hostAuthority);   // completion r2: own authenticated Offline is durable here\n' },
  { name: 'floor', before: '      const floor = row.digest ? { generation: row.generation, sequence: row.sequence, digest: row.digest } : null;\n',
    after: '      const checked = validateServingPermitContext(record, { ...context',
    text: '      const V2 = isHostAuthorityPermit(this.pins), haFloor = V2 ? { hostAuthorityFloor: this.hostAuthorityJournal.read(record.host)?.floor ?? null } : {};   // host-authority permit r1\n' },
  { name: 'validate-1', before: '        floor, nowSec: Math.floor(this.now() / 1000)', after: ' });\n      if (!checked.allowed', text: ', ...haFloor' },
  { name: 'reread-after-readiness', before: '      // out. Revalidate the same evidence, never relabel it with the current time.\n',
    after: '      validateServingPermitContext(record, { ...context, pins: this.pins, floor, nowSec });',
    text: '      if (V2) await this.#sameHostAuthority(id, record, signal, row.denial);   // host-authority permit r1: readiness work took time\n' },
  { name: 'validate-2', before: '      validateServingPermitContext(record, { ...context, pins: this.pins, floor, nowSec',
    after: " });\n      signal.throwIfAborted();\n      if (this.closed) throw Error('witness closed');\n      if (context.restoredAt", text: ', ...haFloor' },
  { name: 'durable-floor', before: "      if (this.closed) throw Error('witness closed');\n", after: '      if (context.restoredAt !== undefined',
    text: '      if (V2) this.hostAuthorityJournal.accept(record.host, validateHostAuthorityContext(record.hostAuthority));   // host-authority permit r1: durable BEFORE signing\n' },
  { name: 'after-signing', before: "      if (this.closed || this.journal.read(id).fenced) throw Error('witness fenced during signing');\n",
    after: '      return { witness: this.account.address, signature };',
    text: `      if (V2) {   // completion r2: FINAL asynchronous authority read; every guard is re-checked AFTER it, before the signature leaves
        const fresh = await this.#sameHostAuthority(id, record, signal, this.journal.read(id).denial);
        const finalNow = Math.floor(this.now() / 1000);
        const finalChecked = validateServingPermitContext(record, { ...fresh, pins: this.pins, nowSec: finalNow,
          hostAuthorityFloor: this.hostAuthorityJournal.read(record.host)?.floor ?? null });
        if (health.validUntil <= finalNow || health.validUntil < finalChecked.serveUntil)
          throw Error('authenticated readiness does not cover the final authority window: no signature released');
        signal.throwIfAborted();
        const after = this.journal.read(id);
        if (this.closed || after.fenced || after.denial || after.digest !== checked.digest)
          throw Error('witness closed, fenced, denied or superseded during the final authority read: no signature released');
      }
` },
  { name: 'method', before: '      Number.isSafeInteger(h.validUntil) && h.validUntil > nowSec;\n  }\n', after: '  close() { this.closed = true; }',
    text: `  // host-authority permit r1 + completion r2: the CURRENT host authority from this witness's own authenticated reader must still be exactly
  // the signed one and Online; an Offline observation is recorded durably; returns the freshly resolved app context for full revalidation
  async #sameHostAuthority(id, record, signal, denyFloor) {
    const now = await this.authority.read(id, record.host, { signal });
    signal.throwIfAborted();
    this.hostAuthorityJournal.observe(record.host, now?.hostAuthority);
    const e = now?.hostAuthority;
    if (!e || e.proofVerified !== true || e.status !== 'online' || validateHostAuthorityContext(e.context).digest !== record.hostAuthority.digest)
      throw Error('canonical host authority changed, Offline or unknown during witness verification/signing: no signature released');
    return resolveServingContext({ ...now, pins: this.pins, nowSec: Math.floor(this.now() / 1000), denyFloor });
  }
` },
];

const RUNTIME = [
  { name: 'import', before: '// mandatory dependencies, not inferred from a manager saying "running".\n', after: 'export function createIsolationLifecycleRuntime(',
    text: '// host-authority permit r1: v2 permit records carry the exact host authority; the gate receives the REAL snapshot->servingContext conversion\n' +
      "import { isHostAuthorityPermit, permitHostAuthorityOf, servingContextOf } from './deployment-host-authority.mjs';\n" },
  { name: 'v2', before: '  const instances = new Map();\n', after: '  const releaseResource = new Map();',
    text: '  const V2 = isHostAuthorityPermit(gate?.pins);   // host-authority permit r1 (the gate carries the reviewed pins)\n' +
      "  if (V2 && typeof gate.handoffHostAuthority !== 'function') throw Error('v2 runtime requires the host-authority permit gate');\n" },
  { name: 'expose', before: '  return {\n', after: '    fence, stop,',
    text: '    hostAuthorityPermit: V2,   // completion r2: the dispatch requires exactly this for independent-host-registry-r1 serving and handoff\n' },
  { name: 'fresh-handoff', before: "        throw Error('no verified launch plan with staged I/O enforcement');\n", after: '      let view = await client.findByName(id);',
    text: '      if (V2) {   // host-authority permit r1: a FRESH queued start is an explicit handoff to the current host authority (never a genesis default)\n' +
      "        if (snapshot?.assignment?.state !== 'queued') throw Error('host authority handoff only from a fresh queued origin');\n" +
      "        gate.handoffHostAuthority(id, permitHostAuthorityOf(snapshot), { kind: 'fresh-queued-start' });\n      }\n" },
  { name: 'adopt', before: '      return result;\n    },\n', after: '    async serve(id, snapshot) {',
    text: `    /**
     * host-authority permit r1: EXPLICIT safe adoption of an app context into the exact current host authority. completion r2: called ONLY
     * by the dispatch's serialized adoptHostIncarnation after its fresh pre/post reads, pending/nonfinal refusal, owner-epoch checks and
     * independently confirmed quiescence, with that adoption's final fresh snapshot. Old-context serving is withdrawn first.
     */
    async adoptHostAuthority(id, snapshot) {
      if (!V2) throw Error('host authority adoption exists only for v2 permits');
      await fence(id);
      return gate.handoffHostAuthority(id, permitHostAuthorityOf(snapshot), { kind: 'explicit-adoption' });
    },
` },
  { name: 'serve-guard', before: '    async serve(id, snapshot) {\n', after: '      const assignment = snapshot.assignment;',
    text: "      if (!V2 && snapshot?.profile === 'independent-host-registry-r1') throw Error('independent-host-registry-r1 serves only through v2 host-authority permits');   // completion r2\n" },
  { name: 'record', before: '        policyRevision: assignment.revision, sequence: row.sequence + 1, issuedAt, validUntil: issuedAt + 20 };\n', after: '      const envelope = await collectPermit',
    text: '      if (V2) record.hostAuthority = permitHostAuthorityOf(snapshot);   // host-authority permit r1: signed inside the v2 typed data\n' },
  { name: 'context', before: '        const grant = await gate.install(envelope, ', after: 'snapshot.servingContext);', text: 'servingContextOf(gate.pins, snapshot) ?? ' },
  { name: 'track', before: '        releaseResource.set(id, gate.track(id, { host, generation: grant.generation', after: ' }, () => revokeInstance(id, instance.instance)));',
    text: ', ...(V2 ? { hostAuthority: grant.hostAuthority } : {})' },
  { name: 'assert', before: '        gate.assert(id, { host, generation: grant.generation', after: ' });\n        if (ack?.deployment', text: ', ...(V2 ? { hostAuthority: grant.hostAuthority } : {})' },
  { name: 'ack', before: "          throw Error('runtime boundary grant not acknowledged');\n", after: '        held.delete(id);',
    text: "        if (V2 && ack?.hostAuthority !== grant.hostAuthority) throw Error('runtime boundary did not bind the exact host authority');   // host-authority permit r1\n" },
];

const ADAPTER = [
  { name: 'import', before: "  hostRegistryAdapterFields } from './lifecycle-host-registry-profile.mjs';\n", after: "const SCHEMA3_BUNDLE_SHA256 = '",
    text: '// host-authority permit r1 (generated): new-profile Running intents persist the exact host authority; final pre-send guard\n' +
      "import { hostAuthorityContextOf, hostAuthorityEvidenceOf, validateHostAuthorityContext } from './deployment-host-authority.mjs';\n" },
  { name: 'helpers', before: "    threshold: Number(await call(lifecycle, LIFECYCLE_ABI, 'threshold', [id])), offline: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]) : null, lastEmergency: S3 ? await call(lifecycle, LIFECYCLE_ABI, 'lastEmergency', [id]) : null });\n\n",
    after: '  function parse(id, intent) {',
    text: `  // ---- host-authority permit r1: canonical host authority at ONE fresh proof-qualified block (pinned() checks code/schema/closure) ----
  const hostAt = async (call, header) => ({ lc: await readHostLifecycle(HRP, call, pins.host), hostRec: await call(C('registry'), DEP_ABI.registry, 'get', [pins.host]),
    hostAuthority: await call(C('hostOwnership'), HOST_OWNERSHIP_ABI, 'authority', [pins.host]), blockSec: Number(header.timestamp) });
  const hostStateOf = v => hostLifecycleState(HRP, { lifecycleHost: v.lc, hostRec: v.hostRec, hostAuthority: v.hostAuthority, blockSec: v.blockSec });
  const hostContextOf = hr => hostAuthorityContextOf(hr, { chainId: pins.chainId, hostId: pins.host, registryCodeHash: HRP.codeHash });
  async function preparedHostAuthority(snapshot, digest) {
    const r = await pinned(hostAt);
    if (!qualified(r.evidence) || r.adminChanges.length) throw Error('prepare: no proof-qualified canonical host authority (or administrator changed): no Running intent');
    const hr = hostStateOf(r.value);
    if (hr.online !== true) throw Error(\`prepare: canonical host is \${hr.status}: no Running intent\`);
    const context = hostContextOf(hr);
    if (snapshot.hostAuthorityEvidence?.context?.digest !== context.digest) throw Error('prepare: the admitted snapshot host authority is not the current one');
    return { context, provenance: { intentDigest: digest, blockNumber: String(r.blockNumber), blockHash: lower(r.blockHash) } };
  }
  function checkPreparedHostAuthority(h, digest) {
    if (!h || typeof h !== 'object' || Object.keys(h).length !== 2 || !h.provenance || Object.keys(h.provenance).length !== 3 ||
        h.provenance.intentDigest !== digest || !/^(0|[1-9][0-9]{0,19})$/.test(h.provenance.blockNumber) || !HASH.test(h.provenance.blockHash))
      throw Error('prepared host authority malformed or bound to another intent');
    validateHostAuthorityContext(h.context);
    if (h.context.hostId !== pins.host || h.context.registry !== lower(HRP.address) || h.context.registryCodeHash !== HRP.codeHash)
      throw Error('prepared host authority is for another host, registry or registry runtime');
    return h;
  }
  // The LAST await before relay.send: a fresh, independently authenticated read of the app assignment AND the canonical host at ONE block.
  async function finalRunningGuard(id, intent, p, x, fee) {
    const r = await pinned(async (call, header) => ({ a: await assignment(call, id), maxGas: (await call(lifecycle, LIFECYCLE_ABI, 'budgets', [id]))[3],
      offline: await call(lifecycle, LIFECYCLE_ABI, 'offline', [id]), ...await hostAt(call, header) }));
    const v = r.value, no = why => { throw Error(\`final send guard: \${why}: not submitted (the journal keeps the exact intent)\`); };
    if (!qualified(r.evidence)) no('no proof-qualified authority');
    if (r.adminChanges.length) no('administrator changed outside the reviewed sets');
    if (v.blockSec >= x.deadline || Math.floor(now() / 1000) >= x.deadline) no('intent deadline passed');
    if (fee > v.maxGas) no('fee exceeds the authenticated budget maxGasPrice');
    if (v.a.lastIntent === intent.digest || v.a.generation !== x.generation || v.a.revision !== x.revision) no('app assignment moved since preparation');
    if (schema3Emergency(v.offline, null, v.a).pending) no('emergency offline settlement pending');
    const hr = hostStateOf(v);
    if (hr.online !== true) no(\`canonical host is \${hr.status}\`);
    if (hostContextOf(hr).digest !== p.hostAuthority.context.digest) no('canonical host authority changed since preparation');
  }

` },
  { name: 'canonical-param', before: '  const canonical = (x, maxGasPriceWei, reason', after: ') => JSON.stringify({ format: FORMAT', text: ', hostAuthority = null' },
  { name: 'canonical-body', before: '      healthySince: x.healthySince, payee: x.payee, maxChargeWei: x.maxChargeWei }, maxGasPriceWei, reason', after: ' });\n  function outcomeOf',
    text: ', ...(hostAuthority ? { hostAuthority } : {})' },
  { name: 'parse-canonical', before: '    if (canonical(x, p.maxGasPriceWei, p.reason', after: ') !== intent.payload) throw Error', text: ', p.hostAuthority ?? null' },
  { name: 'parse-check', before: "    if (canonical(x, p.maxGasPriceWei, p.reason) !== intent.payload) throw Error('intent payload is not the canonical prepared form (rewritten)');\n",
    after: '    return { p, x, typedData };',
    text: "    if (p.hostAuthority !== undefined && (!HR || x.target !== TARGET.running)) throw Error('host authority context on a non-Running or non-host-registry intent');\n" +
      '    if (p.hostAuthority !== undefined) checkPreparedHostAuthority(p.hostAuthority, intent.digest);   // host-authority permit r1: old exact payloads stay parseable\n' },
  { name: 'prepare-context', before: "      if (lower(r.value) !== digest) throw Error('controller digest mismatch: wrong chain, controller or domain');\n", after: '      return { payload: canonical(',
    text: "      const hostAuthority = HR && target === 'running' ? await preparedHostAuthority(snapshot, digest) : null;   // host-authority permit r1: persisted IN the payload\n" },
  { name: 'prepare-payload', before: "      return { payload: canonical(x, maxGasPriceWei.toString(), String(reason ?? '').slice(0, 200)", after: '), digest };', text: ', hostAuthority' },
  { name: 'submit-require', before: '      const { p, x, typedData } = parse(id, intent);\n', after: '      if (Math.floor(now() / 1000) >= x.deadline)',
    text: "      if (HR && x.target === TARGET.running && p.hostAuthority === undefined) throw Error('Running intent prepared without the exact host authority: not submitted (kept for read-only resolution)');\n" },
  { name: 'final-guard', before: "      const data = encodeFunctionData({ abi: LIFECYCLE_ABI, functionName: 'transition', args: [tuple, actor.signature, sigs] });\n", after: '      await relay.send(',
    text: '      if (HR && x.target === TARGET.running) await finalRunningGuard(id, intent, p, x, fee);   // host-authority permit r1: LAST await before relay.send\n' },
  { name: 'snapshot-evidence', before: '        ...(HR ? hostRegistryFields(HRP, hr) : {}),   // host-registry r2 only: overrides profile/hostOffline/independence\n', after: '        policy: v.policy, budget:',
    text: '        ...(HR ? { hostAuthorityEvidence: (() => { try { return hostAuthorityEvidenceOf(hr, { chainId: pins.chainId, hostId: pins.host, registryCodeHash: HRP.codeHash,\n' +
      '          blockHash: r.blockHash, blockNumber: r.blockNumber, proofVerified: ok }); } catch { return null; } })() } : {}),   // host-authority permit r1 (+ completion r2 observation block number)\n' },
];

export const EDITS = Object.freeze({ 'deployment-serving-permit.mjs': SERVING_PERMIT, 'deployment-permit-gate.mjs': GATE,
  'deployment-lifecycle-witness.mjs': WITNESS, 'deployment-isolation-runtime.mjs': RUNTIME, 'deployment-chain-adapter.mjs': ADAPTER });

/** { file -> exact baseline text } -> { file -> { source, sha256, baselineSha256, manifest } }. Pure; self-proves restoration. */
export function generateHostAuthorityPermitFiles(inputs) {
  return Object.fromEntries(Object.entries(EDITS).map(([f, edits]) => {
    if (typeof inputs[f] !== 'string') throw Error(`${f}: baseline text required`);
    return [f, applyInsertions(inputs[f], { expectedSha256: INPUT_SHA256[f], edits, marker: MARKER, what: f })];
  }));
}

export function writeHostAuthorityPermitFiles(inputDir, outputDir) {
  if (!path.isAbsolute(inputDir) || !path.isAbsolute(outputDir)) throw Error('absolute input and output directories required');
  const inReal = fs.realpathSync(inputDir), outReal = fs.realpathSync(outputDir);
  if (inReal === outReal) throw Error('the candidates must be written outside the input directory');
  const inputs = Object.fromEntries(Object.keys(EDITS).map(f => [f, fs.readFileSync(path.join(inReal, f), 'utf8')]));
  const r = generateHostAuthorityPermitFiles(inputs), out = {};
  for (const [f, x] of Object.entries(r)) {
    fs.writeFileSync(path.join(outReal, f), x.source, { flag: 'wx', mode: 0o644 });
    if (sha256(fs.readFileSync(path.join(inReal, f), 'utf8')) !== INPUT_SHA256[f]) throw Error(`${f} input changed during generation`);
    out[f] = { sha256: x.sha256, baselineSha256: x.baselineSha256, manifest: x.manifest };
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: generate-host-authority-permit-candidates.mjs <baseline dir> <output dir>'); process.exit(2); }
  console.log(JSON.stringify(writeHostAuthorityPermitFiles(input, output), null, 1));
}
