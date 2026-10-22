// gate-proof.mjs - ROOT ONLY, READ-ONLY. Would THIS Windows node's platform host policy gate admit it, with the EXACT installed
// host-admission bundle and the EXACT environment the activation appends to node-config.local.cmd, BEFORE anything is changed?
// It makes the node's own call (windows/node/host.mjs:148, host 9634cb40): createHostServiceGate({ env, chainId: 8453, book: null,
// hostId, stateDir, log }) with env = { ENCLAVE_PLATFORM_HOST_POLICY [, ENCLAVE_PLATFORM_HOST_POLICY_RPCS] } only (never
// process.env), runs ONE bounded check, then reads the registry row at an agreed block through the same runtime (decide()).
// stateDir is null: nothing is persisted (the node's own NODE_DIR state is read separately by the PowerShell wrapper).
// Public chain reads only (the gate's own RPC quorum); no key, no signature, no write, no listener. Prints ONE JSON line of
// ids, addresses, hosts, booleans, statuses and short reasons. Exit 0 ADMISSIBLE, 1 NOT_ADMISSIBLE/REFUSED, 3 UNKNOWN.
// Parameters arrive in the child environment (the wrapper sets them): GATE_BUNDLE (absolute path), GATE_HOST (registry id),
// GATE_ENDPOINT (registered endpoint), GATE_POLICY, GATE_RPCS (comma list or empty), GATE_OPTION (label).
// This text is fed to node.exe on stdin (--input-type=module) and pinned by sha256; keep it ASCII.
import { pathToFileURL } from "node:url";
const E = process.env;
const short = (v) => (v === null || v === undefined ? null : String(v).slice(0, 200));
const msg = (e) => short(e && e.message ? e.message : e);
const json = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const out = (o, code) => { process.stdout.write(json(o) + "\n"); process.exit(code); };
const r = { what: "gate", option: short(E.GATE_OPTION), hostId: String(E.GATE_HOST || "").toLowerCase(), endpoint: short(E.GATE_ENDPOINT) };
// referenced on purpose: every path ends in out() -> process.exit, and a check that leaves nothing pending must still hit the bound
setTimeout(() => out({ ...r, verdict: "UNKNOWN", why: "the bounded check did not finish within 45 s (never treated as admitted)" }, 3), 45000);
let m;
try { m = await import(pathToFileURL(String(E.GATE_BUNDLE || "")).href); }
catch (e) { out({ ...r, verdict: "REFUSED", why: "the installed bundle could not be imported: " + msg(e) }, 1); }
if (typeof m.createHostServiceGate !== "function" || typeof m.hostIdOfEndpoint !== "function") out({ ...r, verdict: "REFUSED", why: "the bundle exports no createHostServiceGate/hostIdOfEndpoint" }, 1);
r.idMatchesEndpoint = /^0x[0-9a-f]{64}$/.test(r.hostId) && m.hostIdOfEndpoint(String(E.GATE_ENDPOINT || "")) === r.hostId;
if (!r.idMatchesEndpoint) out({ ...r, verdict: "REFUSED", why: "the host id is not keccak256 of the registered endpoint" }, 1);
const env = { ENCLAVE_PLATFORM_HOST_POLICY: String(E.GATE_POLICY || "") };
if (E.GATE_RPCS) env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS = String(E.GATE_RPCS);
let gate;
try { gate = m.createHostServiceGate({ env, chainId: 8453, book: null, hostId: r.hostId, stateDir: null, log: () => {} }); }
catch (e) { out({ ...r, verdict: "REFUSED", why: "the policy configuration is refused by the bundle: " + msg(e) }, 1); }
r.enabled = gate.enabled === true;
if (!r.enabled) out({ ...r, reason: short(gate.reason), verdict: "NOT_ADMISSIBLE", why: "the gate is OFF with this configuration (unset/off never enforces admin policy)" }, 1);
const c = gate.runtime.config;
r.config = { book: c.book, hostOwnership: c.hostOwnership, rpcHosts: (c.rpcs || []).map((u) => new URL(u).host),
  minAgree: c.minAgree ?? Math.floor((c.rpcs || []).length / 2) + 1, activation: c.activation, mirrors: (c.mirrors || []).length };
r.relayPolicy = typeof gate.runtime?.gate?.decideOperators === "function" ? "gate" : "none";
let checkError = null;
await gate.check().catch((e) => { checkError = msg(e); });
const st = gate.status(), rt = st.runtime || {};
r.gate = { serving: st.serving === true, status: short(st.status), banned: st.banned === true, reason: short(st.reason),
  refusal: short(gate.serviceRefusal()), newWorkRefusal: short(gate.newWorkRefusal()), anchor: short(rt.anchor), block: short(rt.block),
  accepted: rt.accepted ? { sequence: short(rt.accepted.sequence), digest: short(rt.accepted.digest) } : null,
  problems: Array.isArray(rt.problems) ? rt.problems.length : rt.problems ? 1 : 0, checkError };
let row = null, registryError = null;
try {
  const d = await gate.runtime.gate.decide({ registryIds: [r.hostId] }), x = d.decisions[r.hostId];
  r.decide = { admit: x?.admit === true, status: short(x?.status), anchor: short(d.anchor), block: short(d.block) };
  row = x?.host || null;
} catch (e) { registryError = msg(e); }
const norm = (s) => String(s || "").replace(/\/+$/, "");
r.registry = row ? { present: true, active: row.active === true, endpointMatches: norm(row.endpoint) === norm(E.GATE_ENDPOINT),
  operator: String(row.operator || "").toLowerCase() || null } : { present: false, error: registryError };
const ok = r.gate.serving && !r.gate.refusal && r.decide?.admit === true && row && row.active === true && r.registry.endpointMatches
  && /^0x[0-9a-f]{40}$/.test(r.registry.operator || "");
const unknown = !ok && !r.gate.banned && !!(checkError || registryError || /unreadable|undecided|unchecked|behind|authority-unread/.test(String(r.gate.status)));
r.verdict = ok ? "ADMISSIBLE" : unknown ? "UNKNOWN" : "NOT_ADMISSIBLE";
r.why = ok ? `the gate admits this host (${r.gate.status}) and its registry row is active with this endpoint`
  : unknown ? "policy or registry not readable now (transient): never treated as admitted"
  : (r.gate.refusal || (!row ? "no registry row" : !row.active ? "registry entry not active" : !r.registry.endpointMatches ? "registry endpoint differs" : "not admitted"));
out(r, ok ? 0 : unknown ? 3 : 1);
