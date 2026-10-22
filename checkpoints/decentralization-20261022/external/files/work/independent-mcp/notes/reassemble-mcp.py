# Rebuilds src/relay/mcp.js from base/mcp.js (main's file) by moving unchanged pieces: pure parts stay module-level
# (keeping every export), chain/gateway-dependent logic moves into createTools(B). Every substitution is counted.
import sys
s=open('base/mcp.js').read()
marks=["// ---- chain plumbing","// ---- contract shapes","let _depRev = { at: 0, rev: 2 };","// keccak256(\"Created(bytes32","let _catRev = { at: 0, rev: 2 };","async function readVersions(appId, count) {",
"// ---- EnclaveReviews","async function reviewsAddress() {","// [publisher/]slug[:version] -> the on-chain version RECORD","// ---- unsigned-transaction encoders","// ---- self-calls","const isB32 = ","async function depGet(id) {",
"// ---- upgrade / resize","// ---- guides","// ---- tools ----","const TOOLS = [","// ---- wallet sessions","const sessionsConfig = (() =>","// a P-256 coordinate / scalar","async function vaultOwnerOf(vault)","function decodeSessionState(st)",
"// Translate the unsigned wallet transactions","// Validate each step against what the session may reach","const SESSION_CAPABLE = ","TOOLS.push(","// ---- MCP protocol"]
pos=[s.index(m) for m in marks]+[len(s)]
head=s[:pos[0]]
P=[s[pos[i]:pos[i+1]] for i in range(len(marks))]
def sub(t, a, b, n):
    c=t.count(a)
    if c!=n: sys.exit(f"expected {n} of {a!r}, found {c}")
    return t.replace(a,b)
inner_ids=[5,7,8,12,13,16,20,23,24,25]
outer_ids=[0,1,2,3,4,6,9,10,11,14,15,17,18,19,21,22]
inner="".join(P[i] for i in inner_ids)
inner=sub(inner,"export async function publisherFee6(appRef) {","async function publisherFee6(appRef) {",1)
inner=sub(inner,'self("GET", "/availability").catch(() => null)',"B.availability()",6)
inner=sub(inner,'self("GET", "/v1/pricing").catch(() => null)',"B.pricing()",2)
inner=sub(inner,'self("GET", "/enclaves").then((j) => j?.enclaves || []).catch(() => [])',"B.enclaves()",2)
inner=sub(inner,'const v = await self("GET", `/v1/deployments/0x${hex}`);','const v = await B.resolvePrefix(hex);',1)
inner=sub(inner,'await self("GET", `/v1/deployments?owner=${reviewer}`).catch(() => [])','await B.ownerDeployments(reviewer).catch(() => [])',1)
legacy_state_def='''async function sessionState(vault, sid) {
  const v = await self("GET", `/v1/sessions/session/${getAddress(vault)}/${sid}`);
  return v.state || {};
}
'''
inner=sub(inner,legacy_state_def,"const sessionState = (vault, sid) => B.sessionState(vault, sid);\n",1)
inner=sub(inner,"await sessionsConfig()","await B.sessionsConfig()",2)
inner=sub(inner,"...(await prepareSessionCalls(session, steps))","...(await (B.prepareSessionCalls ? B.prepareSessionCalls(session, steps, api) : prepareSessionCalls(session, steps)))",1)
n_self=inner.count("self(")-inner.count("B.self(")
inner=inner.replace("await self(","await B.self(").replace("return self(","return B.self(").replace("=> self(","=> B.self(").replace('\n      self("POST", `/v1/secrets','\n      B.self("POST", `/v1/secrets')
left=[l for l in inner.split("\n") if "self(" in l and "B.self(" not in l]
if left: sys.exit("unconverted self calls: "+repr(left))
print("gateway self-calls routed through the backend:", n_self)
legacy_state=legacy_state_def
outer="".join(P[i] for i in outer_ids)
protocol=P[26]
body_head='''// ---- the tool set, over a backend ---------------------------------------------
// Every chain read, address binding, schema revision, catalog page and gateway call a tool makes goes through B, so the
// same validation code (approval gates, share minimums, fee snapshots, caps, session reach) runs over either backend:
//   legacy       - the hosted relay's own gateway (loopback self-calls) and first-answer public RPCs, as before;
//   independent  - mcp/independent.mjs: explicit reviewed authorities, the admin AddressBook read at one agreed block of
//                  an RPC quorum, and direct host/provider components; it never reaches the Enclave gateway.
// B: { read, addresses, depRev, catRev, catalogApps, availability, pricing, enclaves, resolvePrefix, ownerDeployments,
//      sessionState, sessionsConfig, self, prepareSessionCalls?, overrides?, extend? }
export function createTools(B) {
  const { read, addresses, depRev, catRev, catalogApps } = B;
'''
body_tail='''
  const api = { read, addresses, depRev, catRev, catalogApps, readVersions, reviewsAddress, versionFee6, publisherFee6, resolveApp,
    resolveAppRef, minShares, livePrices, hostPricing, depGet, resolveFullId, upgradeOrResize, vaultOwnerOf };
  // backend-specific tools: a backend replaces a handler outright (overrides) or adds optional arguments (extend); the
  // name, description and every original argument stay those above
  for (const t of TOOLS) {
    const original = t.handler;
    if (B.overrides?.[t.name]) t.handler = (a, ctx) => B.overrides[t.name](a, ctx, api, original);
    if (B.extend?.[t.name]) {
      const { properties = {}, description = "" } = B.extend[t.name];
      for (const k of Object.keys(properties)) if (k in t.inputSchema.properties) throw new Error(`${t.name}.${k} would replace an original argument`);
      t.inputSchema = { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...properties } };
      if (description) t.description += " " + description;
    }
  }
  return { tools: TOOLS, api, publisherFee6 };
}

// ---- the hosted (legacy) backend: the relay's own gateway, as before -------------
'''
legacy_backend='''const LEGACY_BACKEND = {
  kind: "legacy", read, addresses, depRev, catRev, catalogApps, self, sessionState: legacySessionState,
  sessionsConfig,
  availability: () => self("GET", "/availability").catch(() => null),
  pricing: () => self("GET", "/v1/pricing").catch(() => null),
  enclaves: () => self("GET", "/enclaves").then((j) => j?.enclaves || []).catch(() => []),
  resolvePrefix: (hex) => self("GET", `/v1/deployments/0x${hex}`),
  ownerDeployments: (owner) => self("GET", `/v1/deployments?owner=${owner}`),
  run: (_ctx, fn) => fn(),
};
const LEGACY = createTools(LEGACY_BACKEND);
const TOOLS = LEGACY.tools;
export async function publisherFee6(appRef) { return LEGACY.publisherFee6(appRef); }

'''
legacy_state=legacy_state.replace("async function sessionState(","async function legacySessionState(")
inner_ind="\n".join(("  "+l if l.strip() else l) for l in inner.split("\n"))
out=head+outer+legacy_state+"\n"+body_head+inner_ind+body_tail+legacy_backend+protocol
open('src/relay/mcp.js','w').write(out)
print("written", len(out))
