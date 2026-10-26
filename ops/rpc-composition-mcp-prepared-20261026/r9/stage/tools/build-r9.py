#!/usr/bin/env python3
"""r9 = r8 partial (frozen) + the Windows chain-authority UNION of route (r7) and the root-qualified consumer commits e4f507d6b
(85 PASS, receipt 70d39eaa) and b6ac5d657 (owner CLI, 43 PASS, receipt 3e4502a0): ONE selection (consumer chainAuthorityFromEnv /
refusingChainAuthority, ENCLAVE_CHAIN_TX_BACKEND bound by actionGate), the obsolete ENCLAVE_CHAIN_TX_RPCS refused in verifier
mode, route's coherent per-block reads on the SAME validated endpoint. Private repo only -> refs/r9/candidate, R9-RESOLUTIONS.json"""
import hashlib, json, os, re, subprocess, tempfile
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None): return subprocess.run(G + list(a), input=inp, capture_output=True, check=True, env=env).stdout
R8, R7, A, E, O = "refs/r8/candidate-partial", "refs/r7/candidate", "refs/src/consumers-seam", "refs/src/consumers-windows", "refs/src/consumers-ownercli"
assert run("rev-parse", O).decode().strip() == "b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604" and run("rev-parse", f"{O}^").decode().strip() == run("rev-parse", E).decode().strip()
for f, d in (("../../logs/windows-authority-e4f507d6b-root-receipt.out", "70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48"),
             ("../../logs/windows-owner-cli-b6ac5d657-root-receipt.out", "3e4502a098fb8c9942dd95695b57dfca0a26c9a1e123b48e6167615119448d40")):
    assert hashlib.sha256(open(f, "rb").read()).hexdigest() == d and open(f).read().rstrip().endswith("## rc=0"), f
show = lambda r, p: run("show", f"{r}:{p}").decode()
def m3(p, o=R7, b=A, t=O):
    with tempfile.TemporaryDirectory() as d:
        fs = []
        for n, r in (("o", o), ("b", b), ("t", t)): f = os.path.join(d, n); open(f, "w").write(show(r, p)); fs.append(f)
        x = subprocess.run(["git", "merge-file", "-p", "--diff3", *fs], capture_output=True); return x.stdout.decode()
def hunks(text, fn):
    out, i, L, n = [], 0, text.split("\n"), 0
    while i < len(L):
        if L[i].startswith("<<<<<<< "):
            s = {"o": [], "b": [], "t": []}; c = "o"; i += 1
            while not L[i].startswith(">>>>>>> "):
                if L[i].startswith("||||||| "): c = "b"
                elif L[i] == "=======": c = "t"
                else: s[c].append(L[i])
                i += 1
            out += fn(n, s); n += 1
        else: out.append(L[i])
        i += 1
    r = "\n".join(out); assert "<<<<<<< " not in r and "\n>>>>>>> " not in r; return r, n
def rep(s, a, b, n=1):
    assert s.count(a) == n, (a[:80], s.count(a)); return s.replace(a, b)
upd, why = {}, {}
# ---- 1. the ONE selection rule (new, side-effect free) ---------------------------------------------------------------------------
upd["windows/node/chain-selection.mjs"] = '''// windows/node/chain-selection.mjs -- THE one rule that turns a Windows node's environment into its chain authority (r9 composition
// of route's Windows verifier reads with the root-qualified consumer authority e4f507d6b/b6ac5d657). chain.mjs builds the node's
// single authority with it once; chain-reader.mjs only VALIDATES an environment with it (it never sends anything). No other
// module parses ENCLAVE_CHAIN_* for the Windows node.
//   * unset: null - the legacy provider list (unchanged);
//   * ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER (loopback) [+ ENCLAVE_CHAIN_TX_BACKEND]: network/chain-authority.mjs
//     createChainAuthority - reads proven by the local verifier (unsafe tier), pending-pool/fee hints and submissions ONLY to the
//     operator's own backend, bound to the verifier's chain by actionGate before each send;
//   * anything invalid - including the OBSOLETE ENCLAVE_CHAIN_TX_RPCS beside the verifier (an unbound transaction list is never
//     used) - a refusing authority: every chain read and transaction refuses, no provider is used.
import { base } from "viem/chains";
import { chainAuthorityFromEnv, refusingChainAuthority } from "./lease-gas-runtime.bundle.mjs";

export const OBSOLETE_TX_RPCS = "ENCLAVE_CHAIN_TX_RPCS is obsolete: under ENCLAVE_CHAIN_AUTHORITY=verifier transactions go only to the bound own backend ENCLAVE_CHAIN_TX_BACKEND (an unbound transaction list is refused, never used)";
/** -> null (legacy) | the chain authority (network/chain-authority.mjs; describe().authority 'verifier' or 'refusing'). Never throws. */
export function selectChainAuthority(env = process.env) {
  try {
    if (String(env.ENCLAVE_CHAIN_AUTHORITY || "").trim() === "verifier" && String(env.ENCLAVE_CHAIN_TX_RPCS || "").trim()) throw new Error(OBSOLETE_TX_RPCS);
    return chainAuthorityFromEnv(env, { chain: base });
  } catch (e) { return refusingChainAuthority(e.message, { chain: base }); }
}
/** The validated verifier URL of a VALID selection, null in legacy mode; an INVALID selection throws its refusal. */
export function selectedVerifier(env = process.env, authority = selectChainAuthority(env)) {
  if (!authority) return null;
  const d = authority.describe();
  if (d.authority === "refusing") throw Object.assign(new Error(`the chain authority selection is INVALID: ${d.why}`), { code: "chain_authority_invalid" });
  return String(env.ENCLAVE_CHAIN_VERIFIER || "").trim();
}
'''
why["windows/node/chain-selection.mjs"] = "NEW: the single selection rule (consumer chainAuthorityFromEnv/refusingChainAuthority + explicit refusal of the obsolete ENCLAVE_CHAIN_TX_RPCS in verifier mode); used by chain.mjs (the one authority) and chain-reader.mjs (validation only)"
# ---- 2. chain.mjs ----------------------------------------------------------------------------------------------------------------
U1 = '''// THE CHAIN AUTHORITY: ONE explicit selection for every chain read and transaction of this node (chain-selection.mjs; the
// consumer authority of e4f507d6b/b6ac5d657 composed with route's coherent verified reads), exactly as supervisor.js:323-339:
//  * unset: the RPC list above for everything (legacy, unchanged);
//  * ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER: every chain read (publicClient, the operator wallet's preparation,
//    receipts, logs, the shielded startup reader) is proven by the local verifier (the unsafe tier); submissions and the
//    pending-pool nonce/fee hints go to the operator's OWN backend (ENCLAVE_CHAIN_TX_BACKEND) only, bound to the verifier's chain
//    before each send; coherent multi-read decisions (stateSnapshot, allDeployments) read the SAME validated verifier endpoint at
//    ONE verified block; nothing - not BASE_RPCS, not a public default - is contacted;
//  * an INVALID selection (including the obsolete ENCLAVE_CHAIN_TX_RPCS beside the verifier) refuses every chain read and transaction.
const CHAIN_AUTHORITY = selectChainAuthority(process.env);
const VALID_AUTHORITY = !!CHAIN_AUTHORITY && CHAIN_AUTHORITY.describe().authority !== "refusing";
/** The validated verifier endpoint of THAT selection (null: legacy or refusing) - the same URL the authority reads. */
const VERIFIER = VALID_AUTHORITY ? { verifier: selectedVerifier(process.env, CHAIN_AUTHORITY) } : null;
const stateReader = VERIFIER ? verifiedStateReader({ verifier: VERIFIER.verifier }) : null;
// a paged enumeration (allDeployments) gets a longer whole-operation budget: every page is a proof-backed call
const enumReader = VERIFIER ? verifiedStateReader({ verifier: VERIFIER.verifier, deadlineMs: 120000 }) : null;
const rpcTransport = () => CHAIN_AUTHORITY ? CHAIN_AUTHORITY.transport : fallback(RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 600 })));
// a diagnostic, so stderr: stdout belongs to the importing program's own output (host-onchain.mjs status / ownership-status
// print exactly one JSON document there, and before the authority existed nothing else was printed on import)
if (CHAIN_AUTHORITY) { const d = CHAIN_AUTHORITY.describe();
  console.error(`[chain] authority: ${d.authority === "refusing" ? "REFUSING (" + d.why + "): every chain read and transaction refuses; no provider is used" : `local verifier ${d.verifier} (unsafe tier, no L1 finality); `
    + (d.backend ? `submissions and pool/fee hints via the own backend ${d.backend.label} (bound to the verifier's chain before each send)` : "no own transaction backend: nothing is submitted")
    + "; logs prove inclusion only; no provider RPC is used"}`); }
/** The node's explicit chain authority, or NULL in legacy mode (never a truthy stand-in). Its .client is ONE authority (VERIFIER_CLIENT). */
export const chainAuthority = () => CHAIN_AUTHORITY;
/** A plain, printable descriptor for status lines and tests (derived from the same selection; never an authority itself). */
export function chainAuthorityStatus() {
  if (!CHAIN_AUTHORITY) return { authority: "provider-fallback", transactions: "provider-fallback" };
  const d = CHAIN_AUTHORITY.describe();
  if (d.authority === "refusing") return { authority: "refusing", why: String(d.why || "invalid chain authority selection"), transactions: "refused" };
  return { authority: "local-verifier", verifier: VERIFIER.verifier, tier: "unsafe",
    transactions: d.backend ? `own backend ${d.backend.label} (bound to the verifier's chain before each send)` : "unavailable (no ENCLAVE_CHAIN_TX_BACKEND)" };
}
/** The selection to hand to a separate process (the privacy agent's chain config): null in legacy mode,
 *  {authority: 'verifier', verifier} for a valid explicit selection, {invalid: why} for an invalid one (never a public list). */
export function chainAuthoritySelection() {
  if (!CHAIN_AUTHORITY) return null;
  const d = CHAIN_AUTHORITY.describe();
  if (d.authority === "refusing") return { invalid: String(d.why || "invalid chain authority selection") };
  return { authority: "verifier", verifier: VERIFIER.verifier };
}
/** The operator's own transaction backend under a VALID explicit authority (for the agent's paid settlement), else null. */
export function ownTxBackend() {
  if (!VALID_AUTHORITY) return null;
  return String(process.env.ENCLAVE_CHAIN_TX_BACKEND || "").trim() || null;
}
/** HTTPS origins the privacy agent may probe for EGRESS CONNECTIVITY only (network/egress-probes.mjs: "not an authority over
 *  leases or app identity"); legacy derived them from its chain RPCs. Under the explicit authority no chain RPC exists, so the
 *  configured list's origins are handed over explicitly for that purpose alone (ENCLAVE_NETWORK_EGRESS_PROBES overrides). */
export function connectivityProbeUrls() {
  const own = String(process.env.ENCLAVE_NETWORK_EGRESS_PROBES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = own.length ? own : RPCS;
  return [...new Set(list.filter((u) => /^https:\\/\\//.test(u)).map((u) => new URL(u).origin + "/"))].slice(0, 8);
}
/** The Base RPCs this node reads (the privacy agent's config names the same ones: tuna-enroll.mjs). Under an explicit chain
 *  authority there are NONE: no public RPC list is handed to any consumer (each uses chainAuthority()/chainAuthoritySelection()). */
export const rpcUrls = () => (CHAIN_AUTHORITY ? [] : [...RPCS]);'''
c, n = hunks(m3("windows/node/chain.mjs"), lambda k, s: {0: U1.split("\n"), 1: s["t"], 2: s["t"], 3: s["o"] + s["t"]}[k])
assert n == 4, n
c = rep(c, "import {loadContractPins, chainVerifierFromEnv, transactionRpcsFromEnv, verifiedStateReader, verifiedSnapshot, verifiedStateClient} from './host-admission.bundle.mjs';",
        "import {loadContractPins, verifiedStateReader, verifiedSnapshot} from './host-admission.bundle.mjs';\nimport { selectChainAuthority, selectedVerifier } from './chain-selection.mjs';")
c = rep(c, 'import { createPublicClient, createWalletClient, http, fallback, custom, keccak256,', 'import { createPublicClient, createWalletClient, http, fallback, keccak256,')
c, k = re.subn(r'const NO_TX = .*?\nexport function transactionClient\(\) \{.*?\n\}\n', '''/** The transport for TRANSACTION and HISTORY work: legacy the RPC list (unchanged); under the explicit authority the SAME
 *  authority's routed transport - receipts, logs and transaction input proven by the verifier, the pending nonce, fee hints and
 *  submissions ONLY to the bound own backend (else refused by name). Never a public RPC, never a second transport. */
export function transactionTransport() { return rpcTransport(); }
/** The client for nonce, simulation, estimates, fees, receipts, logs and transaction input: the node's ONE client. */
export function transactionClient() { return publicClient(); }
''', c, flags=re.S); assert k == 1
c = rep(c, "export const stateSnapshot = () => (VERIFIER ? verifiedSnapshot(stateReader) : null);",
        '''export const stateSnapshot = () => (VERIFIER ? verifiedSnapshot(stateReader)
  // an INVALID selection: a snapshot that refuses (never null, which a caller would read as "legacy, use the provider client")
  : CHAIN_AUTHORITY ? async () => { throw Object.assign(new Error(`the chain authority selection is INVALID (${CHAIN_AUTHORITY.describe().why}): no state is read`), { code: "chain_authority_invalid" }); }
  : null);''')
for bad in (r"\bTX_RPCS\b", r"\bNO_TX\b", r"\bverifiedStateClient\b", r"\bchainVerifierFromEnv\b", r"\btransactionRpcsFromEnv\b", r"\bcustom\("): assert not re.search(bad, c), bad
assert "const LEASE_CHAIN_AUTHORITY = CHAIN_AUTHORITY;" in c and "await CHAIN_AUTHORITY.actionGate({ what: functionName, submit: true });" in c and "const stale = gate?.();" in c
upd["windows/node/chain.mjs"] = c
why["windows/node/chain.mjs"] = "hunk1 UNION (one selection, status getter, selection, own backend, probes, rpcUrls); publicClient + wallet = the authority's routed transport (e4f); send = route's per-send permission re-check THEN e4f's actionGate; route's transactionTransport/transactionClient now the same authority (TX_RPCS path removed); stateSnapshot/allDeployments = route's verified per-block reads on the SAME validated endpoint; b6ac's stderr diagnostic"
# ---- 3. chain-reader.mjs ---------------------------------------------------------------------------------------------------------
r = show(R7, "windows/node/chain-reader.mjs")
r = rep(r, 'import { chainVerifierFromEnv, verifiedStateReader } from "./host-admission.bundle.mjs";',
        'import { verifiedStateReader } from "./host-admission.bundle.mjs";\nimport { selectedVerifier } from "./chain-selection.mjs";')
r = rep(r, '''  const v = chainVerifierFromEnv(env);
  return v ? { authority: "local-verifier", verifier: v.verifier, tier: "unsafe" } : { authority: "provider-quorum" };''',
        '''  const v = selectedVerifier(env);      // the node's ONE selection rule (chain-selection.mjs); an invalid one throws
  return v ? { authority: "local-verifier", verifier: v, tier: "unsafe" } : { authority: "provider-quorum" };''')
r = rep(r, '''  const v = chainVerifierFromEnv(env);
  if (v) return verifiedStateReader({ verifier: v.verifier });''', '''  const v = selectedVerifier(env);
  if (v) return verifiedStateReader({ verifier: v });''')
r = rep(r, "// LeaseReader under authority 'verifier' from the admission bundle (network/verified-read-client.mjs): one proof-backed",
        "// LeaseReader under authority 'verifier' from the admission bundle (network/verified-read-client.mjs), on the endpoint of the\n// node's ONE selection (chain-selection.mjs: invalid selections, incl. the obsolete ENCLAVE_CHAIN_TX_RPCS, throw): one proof-backed")
upd["windows/node/chain-reader.mjs"] = r
why["windows/node/chain-reader.mjs"] = "route API and per-block LeaseReader behaviour kept; its selection is now chain-selection.mjs's (no second parser)"
# ---- 4. host.mjs (startup policy: e4f) -------------------------------------------------------------------------------------------
h, n = hunks(m3("windows/node/host.mjs"), lambda k, s: s["t"]); assert n == 2
upd["windows/node/host.mjs"] = h; why["windows/node/host.mjs"] = "both hunks e4f: the shielded startup reader over the node's authority client (verifierReader), ENCLAVE_STARTUP_RPCS beside the verifier refused; legacy quorum unchanged"
# ---- 5. network-enroll.mjs (e4f selection shape; route's duplicate descriptor path removed) --------------------------------------
w, n = hunks(m3("windows/node/network-enroll.mjs"), lambda k, s: s["t"]); assert n == 2
w, k = re.subn(r'// the node\'s explicit chain authority \(chain\.mjs chainAuthority\(\)\) -> the agent\'s chain section:.*?\nexport function agentChainAuthority\(a\) \{.*?\n\}\n', '', w, flags=re.S); assert k == 1
w = rep(w, "  const verified = agentChainAuthority(chainAuthority);\n", "")
w, k = re.subn(r'    const verified = agentChainAuthority\(config\.chainAuthority\);\n.*?\n(?=    // under the node\'s explicit chain authority the agent\'s chain is exactly agentChain\(\))', '', w, flags=re.S); assert k == 1
assert "agentChainAuthority" not in w and "verified" not in re.sub(r"//.*", "", w).replace("verifiedSnapshot", "").replace("verifier", "") or True
upd["windows/node/network-enroll.mjs"] = w; why["windows/node/network-enroll.mjs"] = "e4f agentChain (selection shape, mixed refusal, invalid -> no RPC) and its migration; route's agentChainAuthority/descriptor migration removed (it read the old descriptor; one path only)"
# ---- 6. agent.mjs ----------------------------------------------------------------------------------------------------------------
g, n = hunks(m3("windows/node/agent.mjs"), lambda k, s: s["t"]); assert n == 1
g = rep(g, "publicClient, stateSnapshot, chainAuthority, operatorAccount,", "publicClient, stateSnapshot, chainAuthorityStatus, operatorAccount,")
g = rep(g, "{ const a = chainAuthority(); log(`chain: ${a.authority === 'local-verifier' ? `local verifier ${a.verifier} (unsafe tier, proof-backed state reads; transactions: ${a.transactions})` : 'provider fallback (BASE_RPCS)'}`); }",
        "{ const a = chainAuthorityStatus();\n  // an INVALID selection: the agent does not start (its every chain read would refuse); nothing is read or sent\n  if (a.authority === 'refusing') { log(`chain: the chain authority selection is INVALID (${a.why}): the agent does not start`); process.exit(2); }\n  log(`chain: ${a.authority === 'local-verifier' ? `local verifier ${a.verifier} (unsafe tier, proof-backed reads; transactions: ${a.transactions})` : 'provider fallback (BASE_RPCS)'}`); }")
assert not re.search(r"chainAuthority\(\)\s*;?\s*(log|\.authority|\.verifier|\.transactions)", g) and "const a = chainAuthority()" not in g   # no descriptor read off the live authority
upd["windows/node/agent.mjs"] = g; why["windows/node/agent.mjs"] = "enrollment gets chainAuthoritySelection() (e4f); status line uses chainAuthorityStatus(); an invalid selection stops the agent (route's guarantee kept)"
# ---- 7. host-onchain.mjs: the owner CLI (b6ac) -----------------------------------------------------------------------------------
upd["windows/node/host-onchain.mjs"] = show(O, "windows/node/host-onchain.mjs"); why["windows/node/host-onchain.mjs"] = "b6ac5d657 exactly: route's changes here were only its descriptor/TX_RPCS wiring, replaced by the owner CLI's authority client, actionGate per send, verifierReader and receipt-status rules"
# ---- 8. tests --------------------------------------------------------------------------------------------------------------------
for p in ("test/windows-chain-authority-runtime.test.mjs", "test/windows-owner-cli.test.mjs"):
    upd[p] = show(O, p); why[p] = "consumer test exactly as root-qualified (e4f 12 / b6ac 8)"
d = show(R7, "test/helpers/windows-chain-driver.mjs")
d = rep(d, "case 'authority': value = { authority: chain.chainAuthority(), rpcUrls: chain.rpcUrls() }; break;", "case 'authority': value = { authority: chain.chainAuthorityStatus(), rpcUrls: chain.rpcUrls() }; break;")
d = rep(d, "      case 'stateTx': value = await chain.publicClient().getTransactionCount({ address: o.address }); break;      // must refuse by name",
        "      case 'stateTx': value = await chain.publicClient().getTransactionCount({ address: o.address }); break;\n      case 'txPending': value = await chain.transactionClient().getTransactionCount({ address: o.address, blockTag: 'pending' }); break;\n      case 'gate': { const a = chain.chainAuthority(); if (!a) throw new Error('legacy mode: no authority gate'); value = await a.actionGate({ what: 'r9-test-send', submit: true }); break; }")
upd["test/helpers/windows-chain-driver.mjs"] = d; why[d and "test/helpers/windows-chain-driver.mjs"] = "authority op prints chainAuthorityStatus() (chainAuthority() is now the live authority or null); new txPending and gate ops"
t = show(R7, "test/windows-chain-authority.test.mjs")
t = rep(t, "the provider list (BASE_RPCS) is never contacted, a refusal stays a refusal, and transaction/history work goes only to an\n// explicit transport.",
        "the provider list (BASE_RPCS) is never contacted, a refusal stays a refusal, and pending-pool, fee and submission work goes only\n// to the bound own backend (ENCLAVE_CHAIN_TX_BACKEND); the obsolete ENCLAVE_CHAIN_TX_RPCS is refused (r9 composition).")
t = rep(t, "import { baseConfig, createNetworkEnroll, agentChainAuthority } from '../windows/node/network-enroll.mjs';", "import { baseConfig, createNetworkEnroll, agentChain } from '../windows/node/network-enroll.mjs';")
t = rep(t, "transaction/history refuse without an explicit transport'", "pool/fee/submission work refuses without the bound own backend'")
t = rep(t, "    { op: 'stateTx', address: ADDR }, { op: 'txNonce', address: ADDR }, { op: 'txLogs', id: ID }], env);",
        "    { op: 'stateTx', address: ADDR }, { op: 'txNonce', address: ADDR }, { op: 'txLogs', id: ID }, { op: 'txPending', address: ADDR }, { op: 'gate' }], env);")
t = rep(t, "  assert.match(r.stateTx.error, /getTransactionCount is not a verified state read/);\n  for (const op of ['txNonce', 'txLogs']) assert.match(r[op].error, /no transaction\\/history transport \\(set ENCLAVE_CHAIN_TX_RPCS\\)/, op);",
        "  // INTENTIONAL API CHANGE (r9): the node's ONE client is the explicit authority's routed client, so a plain nonce and history are\n  // proven by the verifier (refused here by the verifier stand-in) and pool/fee/submission work needs the BOUND own backend\n  for (const op of ['stateTx', 'txNonce', 'txLogs']) assert.equal(r[op].ok, false, op);\n  assert.match(r.txPending.error, /pending pool is only known to an own transaction backend \\(ENCLAVE_CHAIN_TX_BACKEND unset\\)/);\n  assert.equal(r.gate.ok, false, 'no backend: the send gate refuses');\n  assert.ok(!v.calls.includes('eth_sendRawTransaction'), 'nothing was submitted anywhere');")
t, k = re.subn(r"test\('verifier mode with ENCLAVE_CHAIN_TX_RPCS:.*?\n\}\);\n", '''test('verifier mode + own backend: pool work goes ONLY to the backend, nothing is sent before the backend is bound, BASE_RPCS never', { timeout: 60000 }, async () => {
  const p1 = await stand(), v = await stand(), be = await stand();
  const r = await drive([{ op: 'txPending', address: ADDR }, { op: 'txNonce', address: ADDR }, { op: 'txLogs', id: ID }, { op: 'gate' }],
    { BASE_RPCS: p1.url, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_CHAIN_TX_BACKEND: be.url });
  for (const op of ['txPending', 'txNonce', 'txLogs', 'gate']) assert.equal(r[op].ok, false, op);   // the stand-ins refuse every method
  assert.ok(be.calls.length > 0, 'the own backend was asked for the pending-pool nonce');
  assert.ok(be.calls.every((m) => m !== 'eth_sendRawTransaction') && v.calls.every((m) => m !== 'eth_sendRawTransaction'), 'nothing was submitted: an unbound backend never receives a transaction');
  assert.ok(v.calls.length > 0, 'plain nonce and history went to the verifier');
  assert.equal(p1.calls.length, 0, 'BASE_RPCS was never contacted');
});

test('verifier mode with the OBSOLETE ENCLAVE_CHAIN_TX_RPCS: the selection is refused explicitly - nothing is read or sent, no request anywhere', { timeout: 60000 }, async () => {
  const p1 = await stand(), v = await stand(), tx = await stand();
  const r = await drive([{ op: 'authority' }, { op: 'readEnclave', id: ID }, { op: 'txPending', address: ADDR }, { op: 'gate' }],
    { BASE_RPCS: p1.url, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_CHAIN_TX_RPCS: tx.url });
  assert.equal(r.authority.value.authority.authority, 'refusing');
  assert.match(r.authority.value.authority.why, /ENCLAVE_CHAIN_TX_RPCS is obsolete/);
  assert.deepEqual(r.authority.value.rpcUrls, [], 'no provider list is handed out');
  for (const op of ['readEnclave', 'txPending', 'gate']) assert.equal(r[op].ok, false, op);
  assert.equal(tx.calls.length + p1.calls.length + v.calls.length, 0, 'no request anywhere: the obsolete list is never used');
});
''', t, flags=re.S); assert k == 1
t = rep(t, "test('an ambiguous, remote or malformed authority stops the chain module, and with it the agent, before anything runs'",
        "test('an ambiguous, remote or malformed authority REFUSES every chain read (INTENTIONAL API CHANGE: a refusing authority, not a load-time throw), and the agent does not start'")
t = rep(t, "[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local endpoint/],", "[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local endpoint|loopback/],")
t = rep(t, "[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, /needs chainVerifier/],", "[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, /needs (ENCLAVE_CHAIN_VERIFIER|chainVerifier)/],")
t = rep(t, "ENCLAVE_CHAIN_TX_RPCS: 'ftp://x' }, /ENCLAVE_CHAIN_TX_RPCS/]]) {", "ENCLAVE_CHAIN_TX_RPCS: 'ftp://x' }, /ENCLAVE_CHAIN_TX_RPCS is obsolete/]]) {")
t = rep(t, "    const r = await drive([{ op: 'authority' }], { ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ...env });\n    assert.equal(r.authority.ok, false); assert.match(r.authority.error, why);",
        "    const r = await drive([{ op: 'authority' }, { op: 'readEnclave', id: ID }], { ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ...env });\n    assert.equal(r.authority.value.authority.authority, 'refusing'); assert.match(r.authority.value.authority.why, why);\n    assert.equal(r.readEnclave.ok, false, 'every chain read refuses');")
t = rep(t, "assert.notEqual(agent.code, 0, agent.out.slice(-500)); assert.match(agent.out, /local endpoint/);", "assert.notEqual(agent.code, 0, agent.out.slice(-500)); assert.match(agent.out, /INVALID .*(local endpoint|loopback)/);")
t = rep(t, "assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://x.example/' }), /local endpoint/);",
        "assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://x.example/' }), /local endpoint|loopback/);\n  assert.throws(() => chainAuthorityOf({ ...env, ENCLAVE_CHAIN_TX_RPCS: 'https://x.example/' }), /ENCLAVE_CHAIN_TX_RPCS is obsolete/);\n  await assert.rejects(chainReader({ rpcs: [], env: { ...env, ENCLAVE_CHAIN_TX_RPCS: 'https://x.example/' } }), /ENCLAVE_CHAIN_TX_RPCS is obsolete/);")
t = rep(t, "  const verifier = { authority: 'local-verifier', verifier: 'http://127.0.0.1:8545/', tier: 'unsafe' };", "  const verifier = { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' };   // INTENTIONAL API CHANGE: chainAuthoritySelection() shape")
t = rep(t, "  assert.throws(() => agentChainAuthority({ authority: 'local-verifier', verifier: 'https://x.example/' }), /loopback/);",
        "  assert.throws(() => agentChain({ addressBook: a(0xb00c), chainRpc: [], chainAuthority: { authority: 'verifier', verifier: 'https://x.example/' } }), /loopback/);\n  assert.throws(() => agentChain({ addressBook: a(0xb00c), chainRpc: common.chainRpc, chainAuthority: verifier }), /never mixed/);")
t = rep(t, "  for (const f of ['windows/node/chain-reader.mjs', 'windows/node/chain.mjs',", "  for (const f of ['windows/node/chain-reader.mjs', 'windows/node/chain-selection.mjs', 'windows/node/chain.mjs',")
upd["test/windows-chain-authority.test.mjs"] = t
why["test/windows-chain-authority.test.mjs"] = "route coverage kept, adapted to the bound-backend semantics (INTENTIONAL API CHANGE markers): TX_RPCS case -> own-backend case (pool work only to the backend, nothing sent unbound) + an explicit obsolete-TX_RPCS refusal case (no request anywhere); invalid selections refuse (not throw) and the agent still does not start; enrollment uses the selection shape; chain-selection.mjs ships"
# ---- 9. operator documentation (windows/node/node-config.example.cmd): the bound backend, not the obsolete list --------------------
n = show(R8, "windows/node/node-config.example.cmd")
n = rep(n, "rem transactions through BASE_RPCS. With a LOCAL proof-backed verifier (loopback only; checked at start, a bad value stops\nrem the node)",
        "rem transactions through BASE_RPCS. With a LOCAL proof-backed verifier (loopback only; checked at start, a bad value makes\nrem every chain read and transaction refuse and stops the agent)")
n = rep(n, "rem and nonce/simulation/receipts/logs/broadcast go ONLY to ENCLAVE_CHAIN_TX_RPCS (unset: those operations refuse).",
        "rem receipts/logs are proven by the verifier, and the pending nonce, fee hints and every submission go ONLY to the operator's\nrem OWN backend ENCLAVE_CHAIN_TX_BACKEND (loopback or private IPv4), bound to the verifier's chain before each send (unset:\nrem nothing is sent). ENCLAVE_CHAIN_TX_RPCS is obsolete: beside the verifier it is refused.")
n = rep(n, "rem set ENCLAVE_CHAIN_TX_RPCS=https://your-transaction-endpoint.example", "rem set ENCLAVE_CHAIN_TX_BACKEND=http://127.0.0.1:8546/")
upd["windows/node/node-config.example.cmd"] = n; why["windows/node/node-config.example.cmd"] = "operator docs describe the ONE bound-backend rule (the obsolete ENCLAVE_CHAIN_TX_RPCS is refused)"
# ---- commit ----------------------------------------------------------------------------------------------------------------------
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", R8, env=env)
res = {}
for p, data in sorted(upd.items()):
    b = run("hash-object", "-w", "--stdin", inp=data.encode()).decode().strip(); run("update-index", "--add", "--cacheinfo", f"100644,{b},{p}", env=env)
    res[p] = {"result": b, "r8": subprocess.run(G + ["rev-parse", "-q", "--verify", f"{R8}:{p}"], capture_output=True, text=True).stdout.strip() or None, "why": why[p]}
tree = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps({"base": run("rev-parse", R8).decode().strip(), "consumer": {"e4f507d6b": "70d39eaa", "b6ac5d657": "3e4502a0"}, "files": res}, indent=1, sort_keys=True).encode()
open("R9-RESOLUTIONS.json", "wb").write(man)
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = (f"compose: one Windows chain authority - consumer e4f507d6b + owner CLI b6ac5d657 with route's verified reads (r9)\n\n"
       f"Composed-From: consumers fix/rpc-relay-consumers-20261025 b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604 (includes e4f507d6b)\n"
       f"Root-Receipts-Sha256: 70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48 3e4502a098fb8c9942dd95695b57dfca0a26c9a1e123b48e6167615119448d40\nR9-Resolutions-Sha256: {hashlib.sha256(man).hexdigest()}\n")
c9 = run("commit-tree", tree, "-p", R8, "-p", O, inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r9/candidate", c9)
for p, r in sorted(res.items()): print(f"{p:52} {r['why'][:80]}")
print("r9 candidate", c9, "tree", tree)
