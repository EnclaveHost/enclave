// The independent tool layer (docs/network/independent-mcp.md): what relay/mcp.js createTools needs beyond chain reads,
// answered from the components that already exist for independent operation - never the Enclave gateway:
//   hosts, prices, capacity  the deployed schema-4 registry at the call's agreed block, filtered by the platform host
//                            policy (admin bans), live by authenticated evidence (network/host-liveness.mjs), and each
//                            host's own operator-signed capacity record (network/host-capacity-http.mjs) when a reviewed
//                            profile and a capacity source are configured;
//   owner management         network/management-client.mjs: the current lease's runner, its operator-signed management
//                            record from signed provider directories, its pinned TLS key; every request carries an
//                            EnclaveSession v1 signature the CLIENT makes with its own session key (two steps: prepare,
//                            then send) - this server never holds a session key;
//   sessions                 the vault itself: relay-free SessionCall digests (fee 0, the vault's own lane nonce, chain
//                            time) for the client to sign, returned as SessionVault.execute calldata for ANY gas payer;
//                            grants for the owner to sign, opened by any gas payer;
//   uploads                  the operator's storage plan: per-adapter EIP-191 upload messages the wallet signs; the bytes go
//                            from the client straight to each adapter, never through this server;
//   secrets                  custody v2 with the committee's owner read (mcp/independent-secrets.mjs): the owner signs,
//                            the existing helpers seal, open and guard; never a relay copy.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, createPublicKey, verify as verifyBytes } from "node:crypto";
import { encodeFunctionData, getAddress, hashTypedData, keccak256, verifyMessage, verifyTypedData, encodeAbiParameters } from "viem";
import { secretsOverrides, secretsExtend, remoteSchemas } from "./independent-secrets.mjs";
import { currentScope, IndependentError, ledgerRows, sessionAt, registryAt, FACTORY_ABI, VAULT_ABI, ZERO, hostLiveness,
  REGISTRY_UPDATE_WINDOW_SEC, quorumPublicClient } from "./independent.mjs";

const lc = (s) => String(s || "").toLowerCase();
const isB32 = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ""));
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
const usd = (v6) => `$${(Number(v6) / 1e6).toFixed(2)}`;
const usdHr = (perSec6) => "$" + (Number(perSec6) * 3600 / 1e6).toFixed(4) + "/h";
const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
const M = () => import("../relay/mcp.js");
const SDK = () => import("../sdk/sessions/dist/node.mjs");
const CAPABILITY_FLAGS = ["devDeploy", "p3", "configOverride", "configCidOverride", "configEdit", "shareResize", "waf"];

// ---- the platform host policy (admin host bans), per profile --------------------------------------------------------
const policies = new WeakMap();
async function hostPolicy(B) {
  const a = B.authority;
  if (policies.has(a)) return policies.get(a);
  const p = (async () => {
    const { createHostPolicyRuntime, resolveHostPolicyConfig, clientSnapshot, verifiedHostSnapshot } = await import("../network/host-policy-runtime.mjs");
    const b = await currentScope().bindings();
    const hp = a.cfg.hostPolicy;
    const env = hp === null || hp === undefined ? {} : { ENCLAVE_PLATFORM_HOST_POLICY: typeof hp === "string" ? hp : JSON.stringify(hp) };
    const r = resolveHostPolicyConfig({ env, chainId: a.chain.chainId, book: b.book });
    // the policy is read on this profile's own agreed quorum, unless the operator's policy configuration names its own
    // read quorum (rpcs): then that one (network/host-policy-runtime.mjs builds it)
    const ownRpcs = hp && typeof hp === "object" && Array.isArray(hp.rpcs) && hp.rpcs.length > 0;
    // chainVerifier (profile): the local proof-backed verifier decides, whatever RPCs are configured (no fallback)
    const rt = !r.on ? null : a.trust?.chainVerifier ? createHostPolicyRuntime(r, { snapshot: verifiedHostSnapshot({ verifier: a.trust.chainVerifier, chainId: a.chain.chainId }) })
      : createHostPolicyRuntime(r, ownRpcs ? {} : { snapshot: clientSnapshot((fn) => a.chain.snapshot(fn).then((x) => x.value)) });
    return { rt, source: r.on ? r.source : r.reason };
  })();
  policies.set(a, p);
  p.catch(() => policies.delete(a));
  return p;
}
/** -> { decisions: {id: {admit,status,reason}} | null (policy off), source } ; an unreadable policy refuses every host */
async function policyDecisions(B, ids) {
  const { rt, source } = await hostPolicy(B);
  if (!rt) return { decisions: null, source };
  try { return { decisions: await rt.admissions(ids.map(lc)), source }; }
  catch (e) { return { decisions: Object.fromEntries(ids.map((i) => [lc(i), { admit: false, status: "unreadable", reason: `platform host policy unreadable: ${e.message}` }])), source }; }
}
async function hostAdmission(B) {
  const { rt } = await hostPolicy(B);
  if (!rt) return null;
  const { leaseHostAdmission } = await import("../network/host-policy-adapters.mjs");
  return leaseHostAdmission(rt.gate);
}

// ---- hosts, capacity, prices ---------------------------------------------------------------------------------------
/** Each host's own signed capacity record, verified against the reviewed profile's registry (a profile is required:
 *  explicit pins carry no code hash). null when no source is configured or there is no profile. */
async function capacityAt(B) {
  const s = currentScope();
  if (s.memo.has("capacity")) return s.memo.get("capacity");
  const p = (async () => {
    const cfg = B.authority.cfg, trust = B.authority.trust;
    if (!trust.profile || (!cfg.capacityDirectories.length && !cfg.capacityCold)) return null;
    const { readCapacity } = await import("../cli/independent-capacity.mjs");
    try {
      return await readCapacity({ reader: B.authority.chain, profile: trust.profile, directories: cfg.capacityDirectories, cold: cfg.capacityCold,
        maxHosts: cfg.maxHosts, state: path.join(cfg.stateDir, "capacity-floors.json") });
    } catch (e) { return { error: String(e.message).slice(0, 200), hosts: [], aggregate: null }; }
  })();
  s.memo.set("capacity", p);
  return p;
}
/** Registered hosts at the call's block, each with the policy decision and its liveness. */
async function hostsAt(B) {
  const s = currentScope();
  if (s.memo.has("hosts")) return s.memo.get("hosts");
  const p = (async () => {
    const rows = await registryAt(B), b = await s.at(), cap = await capacityAt(B);
    const verified = new Map((cap?.hosts || []).filter((h) => h.capacity?.status === "verified").map((h) => [h.hostId, h.capacity]));
    const { decisions, source } = await policyDecisions(B, rows.map((h) => h.id));
    const out = rows.map((h) => {
      const c = verified.get(h.id) || null;
      const liveness = hostLiveness(h, { nowMs: Date.now(), chainNowSec: Math.floor(b.timestamp / 1000), signedUntilMs: c ? c.expiresAt : null,
        registryUpdateWindowSec: REGISTRY_UPDATE_WINDOW_SEC });
      const policy = decisions ? (decisions[lc(h.id)] || { admit: false, status: "undecided", reason: "no policy decision" }) : { admit: true, status: "off", reason: source };
      return { ...h, liveness, policy, capacity: c };
    });
    return { hosts: out, policySource: source, capacityError: cap?.error || null, capacitySources: cap?.sources || [] };
  })();
  s.memo.set("hosts", p);
  return p;
}
const admittedLive = (hosts) => hosts.filter((h) => h.active && h.cpuPricePerSec6 > 0n && h.policy.admit === true && h.liveness.live);
function cheapest(hosts) {
  if (!hosts.length) return null;
  const min = (xs) => xs.reduce((m, x) => (x < m ? x : m), xs[0]);
  const cards = hosts.filter((h) => h.gpuPricePerSec6 > 0n).map((h) => h.gpuPricePerSec6);
  return { cpu6: min(hosts.map((h) => h.cpuPricePerSec6)), gpu6: cards.length ? min(cards) : null };
}
/** The hosted /availability shape, from chain facts and verified host records: aggregate true only on verified records. */
async function availability(B) {
  const { hosts, policySource, capacityError } = await hostsAt(B);
  const live = admittedLive(hosts), c = cheapest(live), cap = await capacityAt(B);
  const verified = live.filter((h) => h.capacity).map((h) => h.capacity.availability);
  const flags = verified.length ? Object.fromEntries(CAPABILITY_FLAGS.map((k) => [k, verified.every((v) => v[k] === true)])) : {};
  return { ...(cap?.aggregate && verified.length ? cap.aggregate : {}), aggregate: verified.length > 0, ...flags,
    cheapestCpuPricePerSec6: c ? c.cpu6.toString() : null, cheapestGpuPricePerSec6: c?.gpu6 ? c.gpu6.toString() : null,
    liveHosts: live.length, registeredHosts: hosts.length, verifiedCapacityRecords: verified.length,
    selfReported: true, platformHostPolicy: policySource, ...(capacityError ? { capacityError } : {}),
    source: verified.length ? "hosts' own operator-signed capacity records, verified against the reviewed registry" : "registry facts only (no verified capacity record): fleet capabilities unknown" };
}
/** The hosted /v1/pricing hardware numbers, only from verified records (the largest node and card reported). */
async function pricing(B) {
  const { hosts } = await hostsAt(B);
  const v = admittedLive(hosts).filter((h) => h.capacity).map((h) => h.capacity.availability);
  if (!v.length) return null;
  const max = (k) => Math.max(0, ...v.map((x) => Number(x[k]) || 0));
  return { node: { ramGb: max("nodeRamGb"), gflops: max("nodeGflops"), vcpus: max("nodeVcpus") }, card: { vramGb: max("cardVramGb"), tflops: max("cardTflops") },
    source: "verified host capacity records (self-reported)" };
}
/** The hosted /enclaves rows: registry entry (posted prices, payout wallet) + the verified record's availability. */
async function enclaves(B) {
  const { hosts } = await hostsAt(B);
  return hosts.filter((h) => h.policy.admit === true).map((h) => ({ id: h.id, name: h.endpoint, endpoint: h.endpoint, operator: h.operator,
    payoutWallet: h.payoutWallet, serving: h.active && h.liveness.live,
    availability: { ...(h.capacity?.availability || {}), askCpuPricePerSec6: h.cpuPricePerSec6.toString(), askGpuPricePerSec6: h.gpuPricePerSec6.toString() } }));
}

// ---- deployments as the ledger holds them --------------------------------------------------------------------------
function deploymentStatus(d, nowSec) {
  if (!d.active) return "stopped";
  if (Number(d.leaseUntil) > nowSec && !/^0x0{64}$/i.test(d.runner)) return "claimed";
  if (BigInt(d.balance6) === 0n && BigInt(d.spent6) === 0n) return "awaiting_payment";
  return BigInt(d.balance6) >= BigInt(d.rate) && BigInt(d.rate) > 0n ? "queued" : "unfunded";
}
async function deploymentView(B, d) {
  const { appUrl } = await M();
  const b = await currentScope().at(), nowSec = Math.floor(b.timestamp / 1000);
  const rate = BigInt(d.rate), bal = BigInt(d.balance6), tail = Math.max(0, Number(d.leaseUntil) - nowSec);
  const leased = Number(d.leaseUntil) > nowSec && !/^0x0{64}$/i.test(d.runner);
  let runner = null;
  if (leased) {
    const h = (await registryAt(B)).find((x) => lc(x.id) === lc(d.runner));
    runner = h ? { id: h.id, endpoint: h.endpoint, operator: h.operator, active: h.active, operatorMatchesLease: lc(h.operator) === lc(d.runnerOperator) }
               : { id: d.runner, registered: false, operator: lc(d.runnerOperator) };
  }
  return { id: d.id, owner: d.owner, status: deploymentStatus(d, nowSec), active: d.active, isPublic: d.isPublic,
    image: { reference: d.appRef }, appRef: d.appRef, ports: d.ports, appPort: Number(d.appPort), envelope: d.configCid,
    shares: { gpuMilli: Number(d.gpuMilli), cpuMilli: Number(d.cpuMilli) }, rate6: rate.toString(), ratePerHour: usdHr(rate),
    balanceUsdc: (Number(bal) / 1e6).toFixed(6), spentUsdc: (Number(d.spent6) / 1e6).toFixed(6), paidUsdc: (Number(bal + BigInt(d.spent6)) / 1e6).toFixed(6),
    timeRemainingSec: tail + (rate > 0n ? Number(bal / rate) : 0), leaseUntil: Number(d.leaseUntil) ? iso(d.leaseUntil) : null,
    runner, url: appUrl(d.id), note: "ledger facts at the agreed block; `claimed` is not proof the app answers" };
}

// ---- owner management: client-signed EnclaveSession v1 requests -----------------------------------------------------
const MANAGEMENT_SCOPE = { status: "api.status", attestation: "api.status", logs: "api.logs", restart: "api.restart", gpu: "api.status",
  release: "api.restart", claimHint: "api.placement" };
const SIGNED = {
  session: { type: "object", additionalProperties: false, required: ["vault", "sid"], description: "Independent mode: the wallet session {vault, sid} whose key signs this host request (session_status lists them)",
    properties: { vault: { type: "string" }, sid: { type: "string" } } },
  publicKey: { type: "object", additionalProperties: true, description: "Independent mode: {x, y} of the session key that signed" },
  signature: { description: "Independent mode, step 2: the session key's P-256 signature over the prepared `message` (WebCrypto ECDSA SHA-256 over its UTF-8 bytes; 64 bytes r||s hex/base64url, {r,s} or DER)" },
  ts: { type: "number", description: "Independent mode, step 2: the prepared ts" },
  n: { type: "string", description: "Independent mode, step 2: the prepared request nonce" },
  authorization: { type: "string", description: "Independent mode, step 2 alternative: a complete EnclaveSession v1 header the session SDK made (Session.apiAuthorization)" },
};
const SIGN_HOW = "Sign `message` with the session's P-256 key: ECDSA with SHA-256 over its UTF-8 bytes (WebCrypto sign({name:'ECDSA', hash:'SHA-256'}, key, bytes) -> 64 bytes r||s), then call this tool again with the same arguments plus publicKey, signature, ts and n, within 60 seconds (the host's window).";
function b64u(hexOrB64, what) {
  const s = String(hexOrB64 || "");
  const b = /^0x[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s.slice(2), "hex") : Buffer.from(s, "base64url");
  if (b.length !== 32) throw new IndependentError("signature", `${what} must be 32 bytes`);
  return b.toString("base64url");
}
// repeat: arguments step 1 chose that step 2 must send back unchanged (they are inside the signed request path)
async function managementCall(B, a, op, { opts, runner, repeat } = {}) {
  const { sessionPublicKey, sessionSignature } = await M();
  if (!a.session) throw new IndependentError("session", `independent mode reaches the host through its signed management endpoint: pass session {vault, sid} of a live session holding ${MANAGEMENT_SCOPE[op]} (the session's key signs each request; this server never holds it)`);
  const cfg = B.authority.cfg, trust = B.authority.trust;
  if (!cfg.managementDirectories.length) throw new IndependentError("config", `profile ${cfg.name} names no managementDirectories (signed provider directories): host management is unavailable`);
  const id = a.__id;
  const vault = getAddress(String(a.session.vault)), sid = lc(a.session.sid);
  if (!isB32(sid)) throw new IndependentError("session", "session.sid must be bytes32");
  // before any host is contacted: live on the pinned factory, holds the scope, and its vault (or owner) holds the record
  const ss = await sessionAt(B, vault, sid);
  if (!ss.exists) throw new IndependentError("session", `session ${sid.slice(0, 10)}… does not exist in vault ${vault}; nothing was sent`);
  if (!ss.live) throw new IndependentError("session", `session ${sid.slice(0, 10)}… is not live (revoked, ended or expired); nothing was sent`);
  const S = await SDK();
  if (((BigInt(ss.session.actions) >> BigInt(S.ACTIONS[MANAGEMENT_SCOPE[op]])) & 1n) !== 1n)
    throw new IndependentError("session", `session ${sid.slice(0, 10)}… lacks the ${MANAGEMENT_SCOPE[op]} scope; nothing was sent`);
  const { depsAbiFor } = await M();
  const d = await B.read((await B.addresses()).deployments, depsAbiFor(await B.depRev()), "get", [id]);
  if (lc(d.owner) !== lc(ss.owner) && lc(d.owner) !== lc(vault))
    throw new IndependentError("session", `${id.slice(0, 10)}… is held by ${d.owner}, not by this session's vault or its owner ${ss.owner}; nothing was sent`);
  let prepared = null, header = null;
  if (a.authorization) header = String(a.authorization);
  else if (a.signature !== undefined) {
    if (!a.publicKey || a.ts === undefined || !a.n) throw new IndependentError("signature", "step 2 needs publicKey, signature, ts and n (from step 1)");
    const pk = sessionPublicKey(a.publicKey), sig = sessionSignature(a.signature);
    header = `EnclaveSession v1 vault=${vault},sid=${sid},ts=${Number(a.ts)},n=${String(a.n)},x=${b64u(pk.x, "publicKey.x")},y=${b64u(pk.y, "publicKey.y")},sig=${Buffer.concat([Buffer.from(sig.r.slice(2), "hex"), Buffer.from(sig.s.slice(2), "hex")]).toString("base64url")}`;
  }
  const { ManagementClient } = await import("../network/management-client.mjs");
  const { LeaseReader } = await import("../network/lease-reader.mjs");
  const { networkAuthorities } = await import("../cli/independent-host.mjs");
  const { independentReaderAuthority } = await import("../cli/independent.mjs");
  const { apiMessage, sha256Hex } = await import("../windows/node/session-api-auth.mjs");
  const authorityPins = networkAuthorities(trust);
  const reader = new LeaseReader({ ...independentReaderAuthority(trust, B.authority.chain), chainId: B.authority.chain.chainId, addressBook: ZERO, authorityPins,
    includeHostPayout: true, maxBlockAgeMs: Math.max(1000, Math.min(trust.maxBlockAgeMs, 120000)), confirmations: Math.max(1, trust.confirmations) });
  const signer = async ({ method, hostPath, body }) => {
    if (header) return header;
    const ts = Math.floor(Date.now() / 1000), n = randomBytes(12).toString("base64url");
    prepared = { method, hostPath, bodySha256: sha256Hex(body), ts, n, vault, sid, message: apiMessage(method, hostPath, sha256Hex(body), ts, n, vault, sid) };
    throw new IndependentError("unsigned", "prepared");
  };
  fs.mkdirSync(path.join(cfg.stateDir, "management"), { recursive: true, mode: 0o700 });
  const client = new ManagementClient({ deploymentId: id, chainId: B.authority.chain.chainId, authorityPins, directories: cfg.managementDirectories,
    stateDir: path.join(cfg.stateDir, "management"), signer, reader, hostAdmission: await hostAdmission(B) });
  try {
    if (op === "logs") {
      const r = await client.logs(opts);
      const chunks = []; let n = 0;
      for await (const c of r.body) { chunks.push(c); n += c.length; if (n > (8 << 20)) break; }
      return { text: Buffer.concat(chunks).toString("utf8"), runner: r.runner };
    }
    if (op === "claimHint") return await client.claimHint({ runner });
    return await client[op === "release" ? "release" : op](opts);
  } catch (e) {
    if (prepared) return { prepared: true, sign: { ...prepared, how: SIGN_HOW }, ...(repeat ? { repeat } : {}), next: SIGN_HOW + (repeat ? ` Send back ${Object.keys(repeat).join(", ")} from \`repeat\` unchanged.` : "") };
    if (e.outcomeUnknown) throw new IndependentError("unknown", `${e.message}; the request may have been delivered - check get_deployment before asking again`);
    throw e;
  }
}
const hostAnswer = (r) => ({ host: { runner: r.runner, endpoint: r.record ? `${r.record.address}:${r.record.port}` : null, authenticated: r.authenticated,
  transport: r.transport, note: "host-reported: authenticated as the HOST by its operator-signed management record and TLS key, not a verification of the app" } });

// ---- relay-free session calls -------------------------------------------------------------------------------------
async function prepareSessionCalls(B, session, steps) {
  const { sessionCallDigest, ACTION_NAME } = await M();
  if (!steps.length) throw new IndependentError("session", "nothing for the session to do");
  const vault = getAddress(String(session.vault || "").trim()), sid = lc(session.sid);
  if (!isB32(sid)) throw new IndependentError("session", "session.sid must be the bytes32 session id");
  const ss = await sessionAt(B, vault, sid);
  if (!ss.live) throw new IndependentError("session", "this session is not live (ended, revoked or expired): open a new one with session_request");
  const mask = BigInt(ss.session.actions);
  const { depsAbiFor } = await M();
  const ledger = (await B.addresses()).deployments;
  for (const s of steps) {
    if (((mask >> BigInt(s.action)) & 1n) === 0n)
      throw new IndependentError("session", `this session's grant does not include ${ACTION_NAME[s.action]}: ask the owner for a session that does (session_request)`);
    if (!s.id) continue;
    const d = await B.read(ledger, depsAbiFor(await B.depRev()), "get", [s.id]);
    const holder = getAddress(d.owner);
    if (holder === vault) continue;
    if (holder !== ss.owner) throw new IndependentError("session", `${s.id.slice(0, 10)}… belongs to ${holder}; this session acts for ${ss.owner} (its vault ${vault})`);
    if (s.action === 2 || s.action === 3)
      throw new IndependentError("session", `${s.id.slice(0, 10)}… is held by the owner's wallet, which a session treats as PRODUCTION: it can stop/resume, resize, fund, lower the cap and refund it, but never change what it runs - the owner signs that with the wallet`);
    if ((Number(ss.session.envs) & 2) === 0) throw new IndependentError("session", `${s.id.slice(0, 10)}… is held by the owner's wallet (production) and this session is staging-only`);
  }
  // the vault's own direct path (sdk prepareCall): lane 0, the vault's sequence, no relay fee, a deadline on chain time
  const b = await currentScope().at();
  const deadline = BigInt(Math.floor(b.timestamp / 1000) + 600);
  let seq = BigInt(await B.read(vault, VAULT_ABI, "seqOf", [sid, 0n]));
  const calls = steps.map((s) => {
    const nonce = seq++;
    const digest = sessionCallDigest({ vault, sid, nonce, action: s.action, args: s.args, fee: 0n, deadline });
    return { action: s.action, actionName: ACTION_NAME[s.action], describe: s.describe, nonce: nonce.toString(), fee: "0", deadline: deadline.toString(),
      args: s.args, digest, digestSha256: "0x" + createHash("sha256").update(Buffer.from(digest.slice(2), "hex")).digest("hex") };
  });
  const walletHeld = steps.some((s) => s.id) ? "a wallet-held record also needs the owner's ledger setDelegate grant to this vault (build_delegate); the vault and ledger enforce it when the call executes" : undefined;
  return { via: "session", mode: "direct (no relay: fee 0, the vault's own lane-0 sequence)", vault, sid, owner: ss.owner, calls,
    ...(walletHeld ? { note: walletHeld } : {}),
    sign: "For each call: ECDSA P-256 over SHA-256 of the 32 digest bytes (WebCrypto: sign({name:'ECDSA', hash:'SHA-256'}, sessionKey, digestBytes) -> 64 bytes r||s). Sign within 10 minutes (deadline, chain time).",
    next: "session_execute { vault, sid, publicKey: {x, y}, calls: [ {…each call, signature} ] } - returns SessionVault.execute transactions IN ORDER for any gas payer (no relay); the vault enforces scope, budget, revocation and replay" };
}
function p256Verify(pk, digest, sig) {
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(pk.x.slice(2), "hex").toString("base64url"), y: Buffer.from(pk.y.slice(2), "hex").toString("base64url") }, format: "jwk" });
  return verifyBytes("sha256", Buffer.from(digest.slice(2), "hex"), { key, dsaEncoding: "ieee-p1363" }, Buffer.concat([Buffer.from(sig.r.slice(2), "hex"), Buffer.from(sig.s.slice(2), "hex")]));
}
async function simulate(B, { from = ZERO, to, data, value = 0n }) {
  return currentScope().agree(async (c, blockNumber) => {
    try { await c.call({ account: from === ZERO ? undefined : from, to, data, value, blockNumber }); return { ok: true }; }
    catch (e) { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError" || x.name === "CallExecutionError" && /revert/i.test(x.shortMessage || "")) return { revert: String(x.reason || x.shortMessage || "reverted").slice(0, 200) }; throw e; }
  }, "simulation");
}

// ---- sessions as the chain holds them ------------------------------------------------------------------------------
const SESSION_OPENED = keccak256(Buffer.from("SessionOpened(bytes32,bytes32,uint64,uint256,uint8,uint256,string)"));
async function scanRange(B) {
  const b = await currentScope().at(), sc = B.authority.cfg.sessionScan;
  const span = BigInt(sc.chunk) * BigInt(sc.maxChunks);
  let from = sc.fromBlock !== null ? BigInt(sc.fromBlock) : (b.number > span ? b.number - span : 0n);
  if (b.number - from > span) throw new IndependentError("config", `session scans cover at most ${sc.maxChunks} x ${sc.chunk} blocks; sessionScan.fromBlock ${from} is further back - raise maxChunks or move fromBlock`);
  return { from, to: b.number, chunk: BigInt(sc.chunk) };
}
async function openedLogs(B, { address, topics }) {
  const { from, to, chunk } = await scanRange(B), out = [];
  for (let x = from; x <= to; x += chunk) out.push(...await currentScope().logs({ address, topics, fromBlock: x, toBlock: x + chunk - 1n > to ? to : x + chunk - 1n }));
  return { logs: out, scanned: { fromBlock: from.toString(), toBlock: to.toString() } };
}
async function describeSession(B, vault, sid, extra = {}) {
  const { decodeSessionState } = await M();
  const s = await sessionAt(B, vault, sid), x = s.session;
  const st = { actions: x.actions, envs: Number(x.envs) };
  return { sid, live: s.live, ...decodeSessionState(st), balance: usd(x.balance6), spent: usd(x.spent6), expiresAt: iso(x.expiresAt),
    keyHash: x.keyHash, ...extra };
}

// ---- the overrides ------------------------------------------------------------------------------------------------
const withId = async (B, api, a) => ({ ...a, __id: await api.resolveFullId(a.id) });

export const overrides = {
  platform_status: async (B) => {
    const s = currentScope(), b = await s.bindings(), { hosts, policySource } = await hostsAt(B);
    return { gateway: "none: independent mode (no Enclave gateway, API or IPFS service is contacted)", profile: B.authority.name,
      registeredHosts: hosts.length, liveHosts: admittedLive(hosts).length, bannedOrRefused: hosts.filter((h) => h.policy.admit !== true).length,
      platformHostPolicy: policySource, fleetVersion: null, ledger: b.deployments, catalog: b.appCatalog, addressBook: b.book };
  },
  pricing: async (B) => {
    const { hosts } = await hostsAt(B), live = admittedLive(hosts), c = cheapest(live), hw = await pricing(B);
    return { model: "per-second USDC on Base; the PRICE IS THE ENCLAVE'S: each host posts its whole node and card price in the registry, and a deployment pays its share fraction (+ any publisher fee) at the host that claims it",
      cheapestLive: c ? { cpuNodePerSec6: c.cpu6.toString(), cpuNodePerHour: usdHr(c.cpu6), gpuCardPerSec6: c.gpu6?.toString() ?? null, gpuCardPerHour: c.gpu6 ? usdHr(c.gpu6) : null } : null,
      hosts: live.map((h) => ({ id: h.id, endpoint: h.endpoint, cpuNodePerHour: usdHr(h.cpuPricePerSec6), gpuCardPerHour: h.gpuPricePerSec6 > 0n ? usdHr(h.gpuPricePerSec6) : null, liveness: h.liveness.evidence })),
      ...(hw ? { node: hw.node, card: hw.card, hardwareSource: hw.source } : { hardware: null, hardwareNote: "hardware sizes are not on chain and no verified capacity record names them: share minimums cannot be computed, so plan_deploy needs explicit gpuShare and cpuShare" }) };
  },
  availability: async (B) => availability(B),
  gpu_capacity: async (B, a, ctx, api) => {
    if (a.id) { const r = await managementCall(B, await withId(B, api, a), "gpu"); return r.prepared ? r : { gpu: r.json, ...hostAnswer(r) }; }
    const { hosts } = await hostsAt(B);
    return { gpuHosts: admittedLive(hosts).filter((h) => h.capacity?.availability?.gpu === true)
      .map((h) => ({ id: h.id, endpoint: h.endpoint, gpuShareFree: h.capacity.availability.gpuShareFree, vramFreeGb: h.capacity.availability.vramFreeGb, smFree: h.capacity.availability.smFree })),
      note: "self-reported by each host's registry operator (verified signed records); pass id (+ session) for one deployment's current host" };
  },
  list_deployments: async (B, a) => {
    if (!a.owner || !isAddr(a.owner)) throw new IndependentError("owner", "independent mode lists a wallet's records from the ledger: pass owner (0x… address)");
    const owner = getAddress(a.owner), b = await currentScope().bindings();
    const vault = getAddress(await B.read(b.factory, FACTORY_ABI, "vaultFor", [owner]));
    const rows = (await ledgerRows(B)).filter((d) => lc(d.owner) === lc(owner) || lc(d.owner) === lc(vault));
    return { owner, vault, deployments: await Promise.all(rows.map(async (d) => ({ ...(await deploymentView(B, d)), heldBy: lc(d.owner) === lc(owner) ? "wallet" : "vault" }))) };
  },
  get_deployment: async (B, a, ctx, api) => {
    const x = await withId(B, api, a), { depsAbiFor } = await M();
    const d = await B.read((await B.addresses()).deployments, depsAbiFor(await B.depRev()), "get", [x.__id]);
    if (/^0x0{40}$/i.test(d.owner)) throw new IndependentError("id", `no deployment ${x.__id} on the ledger at the agreed block`);
    const view = await deploymentView(B, d);
    if (!a.session) return view;
    const r = await managementCall(B, x, "status");
    return r.prepared ? { ...r, deployment: view } : { ...view, live: { status: r.json, ...hostAnswer(r) } };
  },
  deployment_logs: async (B, a, ctx, api) => {
    const r = await managementCall(B, await withId(B, api, a), "logs", { opts: { tail: Math.max(1, Math.min(10000, Number(a.tail) || 100)) } });
    return r.prepared ? r : r.text;
  },
  fleet_attestation: async (B) => {
    const { hosts } = await hostsAt(B);
    return { attestation: null, hosts: admittedLive(hosts).map((h) => ({ id: h.id, endpoint: h.endpoint, measurement: h.measurement, repo: h.repo, operator: h.operator })),
      verify: "There is no fleet document without the gateway. Each host's registered measurement is listed (a registry fact, self-declared); verify an app's enclave client-side with `enclave attest <id> --native-profile FILE` (network/native-client.mjs: fresh SEV-SNP proof bound to its TLS key) or the verifier in EnclaveHost/enclave." };
  },
  deployment_attestation: async (B, a, ctx, api) => {
    const x = await withId(B, api, a);
    if (!a.session) {
      const { depsAbiFor } = await M();
      const d = await B.read((await B.addresses()).deployments, depsAbiFor(await B.depRev()), "get", [x.__id]);
      const h = (await registryAt(B)).find((r) => lc(r.id) === lc(d.runner));
      return { id: x.__id, runner: h ? { id: h.id, endpoint: h.endpoint, measurement: h.measurement, operator: h.operator } : null,
        verify: "independent mode fetches the host's attestation document through its signed management endpoint: pass session (api.status) and sign the request; for a VERIFIED answer use `enclave attest <id> --native-profile FILE`" };
    }
    const nonce = a.nonce || randomBytes(32).toString("hex");   // the freshness challenge is part of the signed request
    const r = await managementCall(B, x, "attestation", { opts: { nonce }, repeat: a.nonce ? undefined : { nonce } });
    return r.prepared ? r : { attestation: r.json, verdict: "NOT VERIFIED (host-reported document)", ...hostAnswer(r) };
  },
  account: async (B, a) => {
    if (!a.owner || !isAddr(a.owner)) throw new IndependentError("owner", "independent mode has no account service: pass owner (0x… address) for the wallet's on-chain account");
    const owner = getAddress(a.owner), b = await currentScope().bindings(), s = currentScope();
    const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
    const [eth, usdc, vault] = await Promise.all([s.balance(owner), B.read(b.usdc, ERC20, "balanceOf", [owner]), B.read(b.factory, FACTORY_ABI, "vaultFor", [owner])]);
    const vaultCode = await s.code(vault);
    const rows = (await ledgerRows(B)).filter((d) => lc(d.owner) === lc(owner) || lc(d.owner) === lc(vault));
    const nowSec = Math.floor((await s.at()).timestamp / 1000), counts = {};
    for (const d of rows) { const st = deploymentStatus(d, nowSec); counts[st] = (counts[st] || 0) + 1; }
    return { owner, ethWei: eth.toString(), usdc: usd(usdc), usdcToken: b.usdc, paymentAddresses: { usdc: b.usdc, ledger: b.deployments },
      vault: getAddress(vault), vaultDeployed: !!vaultCode, deployments: { total: rows.length, ...counts } };
  },
  auth_nonce: async (B, a) => {
    if (!isAddr(a.address)) throw new IndependentError("address", "address must be a 0x… wallet address");
    return { message: null, independent: true,
      howTo: "There is no account/token service in independent mode, so there is no SIWE message to sign. Owner-scoped tools (deployment_logs, restart_deployment, terminate_hosted, deployment_attestation, get_deployment's live view, claim_hint) take session {vault, sid} instead and are signed per request by that session's P-256 key: 1) session_request { publicKey, label, owner } 2) the owner approves it once 3) call the tool with session, sign the returned message, call again with the signature.",
      next: "session_request" };
  },
  auth_login: async () => {
    throw new IndependentError("no-token-service", "independent mode mints no session tokens (they come from the hosted account service): sign each owner request with a wallet session instead - see auth_nonce for the steps");
  },
  claim_hint: async (B, a, ctx, api) => {
    const x = await withId(B, api, a), { hosts } = await hostsAt(B), live = admittedLive(hosts);
    const target = a.enclave ? hosts.find((h) => lc(h.id) === lc(a.enclave) || lc(h.endpoint).replace(/\/+$/, "") === lc(a.enclave).replace(/\/+$/, "")) : null;
    if (a.enclave && !target) throw new IndependentError("host", `${a.enclave} is not a registered host (pass its registry id or registered endpoint)`);
    if (target && target.policy.admit !== true) throw new IndependentError("host", `${target.endpoint} is refused by the platform host policy (${target.policy.reason}); no hint was sent`);
    if (!a.session || !target) return { id: x.__id, sent: false, advisory: true,
      note: "independent mode sends a hint only signed by a session holding api.placement, to a host you name (enclave: its registry id). Without it nothing is sent: every admitted host claims a funded, open record on its own ledger sweep.",
      candidates: live.sort((p, q) => (p.cpuPricePerSec6 < q.cpuPricePerSec6 ? -1 : 1)).slice(0, 8).map((h) => ({ id: h.id, endpoint: h.endpoint, cpuNodePerHour: usdHr(h.cpuPricePerSec6) })) };
    const r = await managementCall(B, x, "claimHint", { runner: lc(target.id) });
    return r.prepared ? r : { id: x.__id, sent: true, to: target.id, answer: r.json, note: "advisory: only the ledger says who holds the lease (get_deployment)" };
  },
  restart_deployment: async (B, a, ctx, api) => {
    const r = await managementCall(B, await withId(B, api, a), "restart");
    return r.prepared ? r : { restarted: r.json, ...hostAnswer(r) };
  },
  terminate_hosted: async (B, a, ctx, api) => {
    const r = await managementCall(B, await withId(B, api, a), "release");
    return r.prepared ? r : { released: r.json, ...hostAnswer(r), note: "the host stopped the app and sent ONE ledger release; confirm with get_deployment (the ledger decides)" };
  },
  upload_token: async (B, a) => {
    const plan = B.authority.cfg.storagePlan;
    if (!plan) throw new IndependentError("config", `profile ${B.authority.name} names no storagePlan: there is no default upload service in independent mode`);
    if (a.signature !== undefined && typeof a.signature === "string" && !a.signatures)
      throw new IndependentError("signature", "a hosted upload-token signature (enclave-upload:…) is not valid for storage adapters: call without signature for the per-adapter messages, then pass signatures");
    if (!/^[0-9a-f]{64}$/.test(String(a.hash || ""))) throw new IndependentError("hash", "hash must be the sha256 hex of the exact bytes");
    if (!isAddr(a.address)) throw new IndependentError("address", "independent uploads are signed by the uploading wallet: pass address");
    const size = Number(a.size), kind = a.kind || "wasm";
    const paths = { wasm: "/add-wasm", json: "/add-json", image: "/add-image", file: "/add-file" };
    if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024 * 1024) throw new IndependentError("size", "size: the exact byte length (at most 2 GiB)");
    if (!paths[kind]) throw new IndependentError("kind", "kind: wasm | json | image | file");
    const { uploadMessage } = await import("../sdk/storage/upload-auth.mjs");
    const nowSec = Math.floor(Date.now() / 1000), expiry = a.expiry !== undefined ? Number(a.expiry) : nowSec + 300;
    if (!(expiry > nowSec && expiry <= nowSec + 300)) throw new IndependentError("expiry", "expiry must be within the next 300 seconds (the adapters' window)");
    const address = lc(a.address);
    const replicas = plan.replicas.map((r) => ({ audience: r.audience, url: new URL(paths[kind], r.upload).href, gateway: r.gateway,
      message: uploadMessage({ audience: r.audience, path: paths[kind], address, hash: a.hash, size, expiry }) }));
    if (!a.signatures) return { prepared: true, expiry, replicas: replicas.map(({ audience, url, message }) => ({ audience, url, message })),
      minimumCopies: plan.minimumCopies, next: "personal_sign each `message` with the wallet, then call upload_token again with the same hash, size, kind, address, expiry and signatures: [one per replica, in order]" };
    if (!Array.isArray(a.signatures) || a.signatures.length !== replicas.length) throw new IndependentError("signature", `signatures: one per replica (${replicas.length}), in order`);
    for (const [i, r] of replicas.entries())
      if (!(await verifyMessage({ address, message: r.message, signature: a.signatures[i] }))) throw new IndependentError("signature", `signature ${i} is not ${address}'s over replica ${i}'s message`);
    const types = { wasm: "application/wasm", json: "application/json", image: "application/octet-stream", file: "application/octet-stream" };
    return { expiry, minimumCopies: plan.minimumCopies, uploads: replicas.map((r, i) => {
      const headers = { "content-type": types[kind], "x-upload-address": address, "x-upload-expiry": String(expiry), "x-upload-sha256": a.hash, "x-upload-signature": a.signatures[i] };
      return { url: r.url, headers, readback: `${r.gateway}/<cid>`,
        curl: `curl -sfX POST ${r.url} ${Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(" ")} --data-binary @app.${kind === "wasm" ? "wasm" : "bin"}` };
    }), next: `POST the exact bytes to every adapter, require the same CID from each, read each copy back from its gateway and compare the sha256; at least ${plan.minimumCopies} verified copies before referencing the CID (sdk/storage publishArtifactReplicas does all of this). The bytes never pass through this server.` };
  },
  session_status: async (B, a) => {
    const { sessionPublicKey, keyHashOf } = await M();
    const b = await currentScope().bindings();
    if (a.publicKey) {
      const kh = keyHashOf(sessionPublicKey(a.publicKey));
      const { logs, scanned } = await openedLogs(B, { topics: [SESSION_OPENED, null, kh] });
      const sessions = [];
      for (const l of logs) {
        if (!(await B.read(b.factory, FACTORY_ABI, "isVault", [getAddress(l.address)]))) continue;
        sessions.push(await describeSession(B, getAddress(l.address), l.topics[1], { vault: getAddress(l.address), openedAtBlock: l.blockNumber.toString() }));
      }
      return { keyHash: kh, sessions, scanned, note: "SessionOpened events in a vault of the pinned factory, within the scanned range" };
    }
    if (!isAddr(a.owner)) throw new IndependentError("owner", "pass owner (0x… wallet) or publicKey");
    const owner = getAddress(a.owner), vault = getAddress(await B.read(b.factory, FACTORY_ABI, "vaultFor", [owner]));
    const deployed = !!(await currentScope().code(vault));
    const sessions = [];
    let scanned = null;
    if (deployed) {
      const r = await openedLogs(B, { address: vault, topics: [SESSION_OPENED] }); scanned = r.scanned;
      for (const l of r.logs) sessions.push(await describeSession(B, vault, l.topics[1], { openedAtBlock: l.blockNumber.toString() }));
    }
    const S = await SDK(), code = await currentScope().agree((c, blockNumber) => c.getCode({ address: b.deployments, blockNumber }), "ledger code");
    return { owner, vault, vaultDeployed: deployed, sessions, scanned,
      delegation: { supported: S.codeHasDelegation(code), granted: null, ledger: b.deployments,
        note: "the deployed ledger keeps setDelegate grants in a private mapping: a session's call on a wallet-held record shows the grant when it executes" } };
  },
  session_request: async (B, a, ctx, api, original) => {
    const { sessionPublicKey, keyHashOf, PRESETS, CHAIN_ID } = await M();
    const S = await SDK(), b = await currentScope().bindings();
    const frontend = B.authority.cfg.grantFrontend;
    if (a.grantRequest) {
      // step 2: the owner signed THIS grant (EIP-712 SessionGrant for its vault): verify, then the factory call for any gas payer
      const req = S.decodeGrantRequest(String(a.grantRequest));
      const owner = getAddress(String(a.owner || req.owner || ""));
      const vault = getAddress(await B.read(b.factory, FACTORY_ABI, "vaultFor", [owner]));
      const pk = sessionPublicKey(a.publicKey);
      if (lc(keyHashOf(pk)) !== lc(req.grant.sessionKey)) throw new IndependentError("grant", "the grant names another session key");
      if (req.grant.budget > 0n) throw new IndependentError("grant", "a budgeted grant also needs the owner's USDC deposit authorization: open it with budgetUsd 0 here and add budget later from the wallet (the owner's frontend opens budgeted grants)");
      const td = S.typedData(CHAIN_ID, vault, "SessionGrant", req.grant);
      if (!(await verifyTypedData({ ...td, address: owner, signature: a.ownerSignature })))
        throw new IndependentError("grant", `ownerSignature is not ${owner}'s SessionGrant signature over exactly this grant for vault ${vault}`);
      const data = encodeFunctionData({ abi: S.sessionVaultFactoryAbi, functionName: "openFor", args: [owner, req.grant, a.ownerSignature] });
      const sim = await simulate(B, { to: b.factory, data });
      if (sim.revert !== undefined) throw new IndependentError("grant", `the factory would refuse this open at the agreed block (${sim.revert})`);
      const sid = S.sessionIdOf(vault, req.grant.sessionKey, req.grant.grantNonce);
      const { unsignedTx } = await M();
      return { vault, sid, owner, transactions: [unsignedTx(b.factory, data, 0n, `SessionVaultFactory.openFor(${owner.slice(0, 10)}…, grant ${keyHashOf(pk).slice(2, 10).toUpperCase()})`)],
        next: `any gas payer sends it (the grant cannot be altered or redirected); then session_status { publicKey } shows the live session ${sid}` };
    }
    const pk = sessionPublicKey(a.publicKey), name = a.preset || "agent", p = { ...PRESETS[name] };
    if (!p.actions) throw new IndependentError("grant", `unknown preset ${name}`);
    if (a.budgetUsd !== undefined) p.budget = BigInt(Math.round(Number(a.budgetUsd) * 100)) * 10000n;
    if (a.spendPerDayUsd !== undefined) p.spendPerPeriod = BigInt(Math.round(Number(a.spendPerDayUsd) * 100)) * 10000n;
    if (a.expiresInHours !== undefined) p.expiresIn = Math.round(Number(a.expiresInHours) * 3600);
    if (!(p.expiresIn > 0) || p.expiresIn > p.maxExpiresIn) throw new IndependentError("grant", `"${name}" sessions last at most ${p.maxExpiresIn / 86400} days`);
    if (a.apps) p.apps = a.apps.map(String);
    if (a.environments) p.environments = a.environments.map(String);
    if (p.budget < 0n || p.budget > 250n * 1_000_000n) throw new IndependentError("grant", "budgetUsd must be 0..250 (the beta vault cap)");
    const blk = await currentScope().at(), nowSec = Math.floor(blk.timestamp / 1000), sessionKey = keyHashOf(pk);
    const grant = { label: String(a.label).slice(0, 80), preset: name, sessionKey, actions: p.actions, apps: p.apps, environments: p.environments,
      budget: p.budget, spendPerPeriod: p.spendPerPeriod, periodSeconds: p.periodSeconds, opsPerPeriod: p.opsPerPeriod, maxFeePerOp: p.maxFeePerOp,
      maxAppFeePerHour: p.maxAppFeePerHour, maxRatePerHour: p.maxRatePerHour, expiresAt: BigInt(nowSec + p.expiresIn), measurement: "0x" + "0".repeat(64),
      grantNonce: "0x" + randomBytes(32).toString("hex"), signBefore: BigInt(nowSec + 86400) };
    const request = { v: 1, chainId: CHAIN_ID, relay: "", x: pk.x, y: pk.y, grant, ...(isAddr(a.owner) ? { owner: getAddress(a.owner) } : {}) };
    const grantRequest = S.encodeGrantRequest(request);
    let vault = null, sid = null, typedData = null;
    if (isAddr(a.owner)) {
      vault = getAddress(await B.read(b.factory, FACTORY_ABI, "vaultFor", [getAddress(a.owner)]));
      sid = S.sessionIdOf(vault, sessionKey, grant.grantNonce);
      typedData = S.typedData(CHAIN_ID, vault, "SessionGrant", grant);
    }
    return { link: frontend ? S.grantLink(frontend, request) : null, grantRequest, keyHash: sessionKey, checkCode: sessionKey.slice(2, 10).toUpperCase(), vault, sid, typedData,
      factory: b.factory, policy: { preset: name, actions: p.actions, apps: p.apps, environments: p.environments, budget: usd(p.budget), spendPerDay: usd(p.spendPerPeriod), expiresAt: iso(nowSec + p.expiresIn) },
      next: typedData
        ? `EITHER the owner opens the link on the frontend they reviewed${frontend ? "" : " (none configured)"} and approves it there, OR the owner signs typedData (eth_signTypedData_v4) and you call session_request again with { publicKey, owner, grantRequest, ownerSignature } for the openFor transaction any gas payer can send. Check code ${sessionKey.slice(2, 10).toUpperCase()} must match.`
        : "pass owner (the approving wallet) to get the typed data the owner signs; the link alone lets ANY wallet open this key in its own vault" };
  },
  session_execute: async (B, a) => {
    const { sessionPublicKey, sessionSignature, sessionCallDigest, ACTION_NAME, unsignedTx } = await M();
    const S = await SDK();
    const vault = getAddress(String(a.vault)), sid = lc(a.sid);
    if (!isB32(sid)) throw new IndependentError("session", "sid must be bytes32");
    const pk = sessionPublicKey(a.publicKey);
    const ss = await sessionAt(B, vault, sid);
    if (!ss.live) throw new IndependentError("session", "this session is not live (ended, revoked or expired); nothing to execute");
    const { keyHashOf } = await M();
    if (lc(keyHashOf(pk)) !== lc(ss.session.keyHash)) throw new IndependentError("session", "publicKey is not this session's key");
    const txs = [];
    for (const [i, c] of a.calls.entries()) {
      const sig = sessionSignature(c.signature);
      const digest = sessionCallDigest({ vault, sid, nonce: BigInt(c.nonce), action: Number(c.action), args: c.args, fee: BigInt(c.fee), deadline: BigInt(c.deadline) });
      if (!p256Verify(pk, digest, sig)) throw new IndependentError("signature", `call ${i} (${ACTION_NAME[c.action] ?? c.action}): the signature is not this session key's over that call's digest`);
      const data = encodeFunctionData({ abi: S.sessionVaultAbi, functionName: "execute",
        args: [sid, BigInt(c.nonce), Number(c.action), c.args, BigInt(c.fee), BigInt(c.deadline), BigInt(pk.x), BigInt(pk.y), sig.r, sig.s] });
      if (i === 0) {
        const sim = await simulate(B, { to: vault, data });
        if (sim.revert !== undefined) throw new IndependentError("simulation", `call 0 (${ACTION_NAME[c.action] ?? c.action}) would revert at the agreed block: ${sim.revert}; nothing to send`);
      }
      txs.push(unsignedTx(vault, data, 0n, `SessionVault.execute(${ACTION_NAME[c.action] ?? c.action}, nonce ${c.nonce})`));
    }
    return { transactions: txs, via: "direct", vault, sid,
      note: "no relay: send these IN ORDER from any gas payer wallet (it pays gas only; it cannot alter a session-signed call). The first was simulated at the agreed block; each later one depends on the one before.",
      next: "after they mine: get_deployment / list_deployments show the effect; a deploy.create's id is topics[1] of the ledger's Created event in its receipt" };
  },
  session_end: async (B, a) => {
    const { sessionPublicKey, sessionSignature, CHAIN_ID, unsignedTx, keyHashOf } = await M();
    const S = await SDK();
    const vault = getAddress(String(a.vault)), sid = lc(a.sid);
    if (!isB32(sid)) throw new IndependentError("session", "sid must be bytes32");
    if (!a.signature) {
      const blk = await currentScope().at(), deadline = BigInt(Math.floor(blk.timestamp / 1000) + 600);
      const digest = hashTypedData({ domain: { name: "Enclave Sessions", version: "1", chainId: CHAIN_ID, verifyingContract: vault },
        types: { SessionEnd: [{ name: "sessionId", type: "bytes32" }, { name: "deadline", type: "uint64" }] }, primaryType: "SessionEnd", message: { sessionId: sid, deadline } });
      return { vault, sid, deadline: deadline.toString(), digest,
        next: "sign the digest (ECDSA P-256, SHA-256 over the 32 bytes) and call session_end again with publicKey, deadline and signature" };
    }
    const pk = sessionPublicKey(a.publicKey), sig = sessionSignature(a.signature);
    const ss = await sessionAt(B, vault, sid);
    if (lc(keyHashOf(pk)) !== lc(ss.session.keyHash)) throw new IndependentError("session", "publicKey is not this session's key");
    const data = encodeFunctionData({ abi: S.sessionVaultAbi, functionName: "terminateBySession", args: [sid, BigInt(a.deadline), BigInt(pk.x), BigInt(pk.y), sig.r, sig.s] });
    const sim = await simulate(B, { to: vault, data });
    if (sim.revert !== undefined) throw new IndependentError("simulation", `the vault would refuse this termination at the agreed block: ${sim.revert}`);
    return { transactions: [unsignedTx(vault, data, 0n, "SessionVault.terminateBySession (the session key ends itself)")], vault, sid,
      refund: `${usd(ss.session.balance6)} returns to the owner's vault`, next: "any gas payer sends it; running apps are untouched" };
  },
  build_delegate: async (B, a) => {
    if (!isAddr(a.owner)) throw new IndependentError("owner", "owner must be a 0x… wallet address");
    const { unsignedTx, LEDGER_DELEGATE_ABI } = await M();
    const S = await SDK(), o = getAddress(a.owner), b = await currentScope().bindings();
    const vault = getAddress(await B.read(b.factory, FACTORY_ABI, "vaultFor", [o]));
    const code = await currentScope().agree((c, blockNumber) => c.getCode({ address: b.deployments, blockNumber }), "ledger code");
    if (!S.codeHasDelegation(code)) throw new IndependentError("delegation", "the pinned ledger does not support delegation");
    const allow = a.grant !== false;
    return { owner: o, vault, ledger: b.deployments, currently: "not readable independently (private mapping on the deployed ledger)",
      transactions: [unsignedTx(b.deployments, encodeFunctionData({ abi: LEDGER_DELEGATE_ABI, functionName: "setDelegate", args: [vault, allow] }), 0n,
        `EnclaveDeployments.setDelegate(your session vault ${vault.slice(0, 10)}…, ${allow})`)],
      next: `sign+send with ${o}` };
  },
  // shared builders with one independent rule: share minimums need hardware sizes, which are not on chain
  plan_deploy: async (B, a, ctx, api, original) => {
    if (!(await B.pricing()) && (a.gpuShare === undefined || a.cpuShare === undefined))
      throw new IndependentError("shares", "independent mode: hardware sizes are not on chain and no verified host capacity record names them, so the version's minimum shares cannot be computed - pass gpuShare and cpuShare explicitly (as `enclave deploy --independent` requires); the serving host refuses a size its app does not fit");
    return original(a, ctx);
  },
  build_upgrade: async (B, a, ctx, api, original) => {
    const out = await original(a, ctx);
    return (await B.pricing()) ? out : { ...out, notice: "independent mode: no verified hardware sizes, so the version's share floors were not checked here; the serving host refuses a version that does not fit" };
  },
  build_resize: async (B, a, ctx, api, original) => {
    const out = await original(a, ctx);
    return (await B.pricing()) ? out : { ...out, notice: "independent mode: no verified hardware sizes, so the version's share floors were not checked here; the serving host refuses a size its app does not fit" };
  },
};

// optional independent-mode arguments (the original arguments, names and descriptions are unchanged)
const signed = (extra = {}) => ({ properties: { ...SIGNED, ...extra }, description: "Independent mode: signed per request by a wallet session's key in two steps (session, then publicKey+signature+ts+n)." });
export const extend = {
  get_deployment: signed(),
  deployment_logs: signed(),
  deployment_attestation: signed({ nonce: { type: "string", description: "Independent mode: the freshness nonce (default random)" } }),
  restart_deployment: signed(),
  terminate_hosted: signed(),
  claim_hint: signed(),
  gpu_capacity: signed({ id: { type: "string", description: "Independent mode: a deployment id whose current host reports its GPU state (needs session)" } }),
  account: { properties: { owner: { type: "string", description: "Independent mode: the wallet (there is no token service)" } } },
  upload_token: { properties: { address: { type: "string", description: "Independent mode: the uploading wallet" }, size: { type: "number", description: "Independent mode: exact byte length" },
    kind: { type: "string", enum: ["wasm", "json", "image", "file"] }, signatures: { type: "array", items: { type: "string" }, description: "Independent mode, step 2: personal_sign of each prepared replica message, in order" } },
    relaxRequired: ["expiry", "signature"] },
  session_request: { properties: { grantRequest: { type: "string", description: "Independent mode, step 2: the grantRequest from step 1" },
    ownerSignature: { type: "string", description: "Independent mode, step 2: the owner's eth_signTypedData_v4 signature over step 1's typedData" } },
    relaxRequired: ["label"] },
};

/** remote: this server is a remote adapter (never the owner's own client): secrets take only plaintext-free operations */
export function independentExtras({ remote = false } = {}) {
  // a remote adapter advertises its own ciphertext-only secrets schemas (remoteSchemas); a local one extends the originals
  return { overrides: { ...overrides, ...secretsOverrides({ remote }) }, extend: remote ? extend : { ...extend, ...secretsExtend },
    ...(remote ? { schemas: remoteSchemas } : {}), prepareSessionCalls, availability, pricing, enclaves };
}
export { hostsAt, admittedLive, deploymentView, managementCall };
