// The client side of a HOSTED independent MCP adapter: the one a measured control guest serves at its /mcp route
// (metal/guest/measured-control.mjs directMcpLaunch, docs/network/hosted-mcp.md).
//
// Nothing is sent until the endpoint is proved to BE that guest, running that adapter under the expected configuration:
//   1. verifyMeasuredControl (metal/measured-control-verify.mjs), unchanged. It checks, in order:
//      - the SEV-SNP report chains to the pinned AMD root and meets the TCB floor;
//      - the measurement is one the client expects (it covers the image, /opt/metal/mcp-server.bundle.mjs included);
//      - HOST_DATA binds EXACTLY the expected direct config, so the mcp member, pins, RPC quorum and directories are part
//        of the binding;
//      - the TLS peer is the attested control key;
//      - the supervisor holds the minted keys;
//      - the registry names the bound operator.
//   2. The attested statement must name the expected adapter bundle (runtime.mcpSha256), and the expected config must
//      carry an mcp member.
//   3. Every MCP request then goes over a TLS socket whose peer key is checked BEFORE a request byte is written.
// Secrets: attestation proves the adapter's code and configuration, NOT the recipient of a seal (a plain --remote adapter
// has no attestation at all, and the adapter's RPC set is the host's choice). So the recipient comes only from the
// owner's own local independent server: its reviewed profile and quorum. remoteSetSecrets compares the adapter's
// prepare with that read, seals here to the owner's facts, and checks the returned update before the owner signs it.
// Reads and merges need the committee's owner read, which only the owner's own client performs (the local server).
import tls from "node:tls";
import http from "node:http";
import { createHash, X509Certificate } from "node:crypto";
import { verifyMeasuredControl, tlsGet } from "../metal/measured-control-verify.mjs";
import { parseStatement, canonicalDirectConfig, EVIDENCE_PATH, MCP_ROUTE } from "../metal/guest/measured-control.mjs";
import { sealForRemote, verifyRemoteUpdate, verifyRemoteClear } from "./remote-secrets-client.mjs";

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
export class HostedMcpError extends Error { constructor(message, detail = {}) { super(message); this.name = "HostedMcpError"; Object.assign(this, detail); } }

/** One HTTPS POST over a socket whose peer SPKI is checked before the request is written. */
function pinnedPost(origin, path, body, { pinSha256, timeoutMs = 120000, maxBytes = 8 << 20 }) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 443), rejectUnauthorized: false,
      servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname, checkServerIdentity: () => undefined });
    const timer = setTimeout(() => { sock.destroy(); reject(new HostedMcpError(`no answer within ${timeoutMs} ms`)); }, timeoutMs);
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    sock.once("secureConnect", () => {
      let spki;
      try { spki = new X509Certificate(sock.getPeerCertificate(true).raw).publicKey.export({ type: "spki", format: "der" }); }
      catch (e) { clearTimeout(timer); sock.destroy(); return reject(new HostedMcpError(`no peer certificate: ${e.message}`)); }
      if (sha256Hex(spki) !== pinSha256) { clearTimeout(timer); sock.destroy(); return reject(new HostedMcpError("the endpoint presented a key other than the attested control key; nothing was sent")); }
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ createConnection: () => sock, method: "POST", path, headers: { host: u.host, "content-type": "application/json", "content-length": data.length, accept: "application/json" } }, (res) => {
        const chunks = []; let n = 0;
        res.on("data", (c) => { n += c.length; if (n > maxBytes) { res.destroy(); reject(new HostedMcpError("answer too large")); } else chunks.push(c); });
        res.on("end", () => { clearTimeout(timer); sock.end(); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }); });
      });
      req.once("error", (e) => { clearTimeout(timer); reject(e); });
      req.end(data);
    });
  });
}

/**
 * connectHostedMcp({ url, expect, collateral, registry, mcpSha256, allowPending })
 *   url         the guest's control front origin (https, the forwarded control port)
 *   expect      verifyMeasuredControl's expectation: { config (with its mcp member), measurements, minTcb, roots?, ... }
 *   mcpSha256   the reviewed adapter bundle the statement must name (metal/guest/mcp-server.bundle.mjs.manifest.json)
 *   allowPending  accept "pending" (registry not yet republished), never "rejected" or "unknown"
 * -> { verification, statement, call(method, params), tools(), callTool(name, args) }
 */
export async function connectHostedMcp({ url, expect, collateral, registry, mcpSha256, allowPending = false, timeoutMs = 15000 }) {
  if (!expect?.config) throw new HostedMcpError("name the expected direct config: its digest binds the hosted adapter's configuration");
  const cfg = canonicalDirectConfig(expect.config);
  if (!cfg.mcp) throw new HostedMcpError("the expected config has no mcp member: that guest serves no hosted MCP");
  if (!/^[0-9a-f]{64}$/.test(String(mcpSha256 || ""))) throw new HostedMcpError("mcpSha256: the reviewed adapter bundle's sha256");
  const v = await verifyMeasuredControl({ url, expect, collateral, registry, timeoutMs });
  if (!(v.status === "verified" || (allowPending && v.status === "pending")))
    throw new HostedMcpError(`the endpoint is not the expected measured control guest (${v.status}): ${(v.reasons || []).slice(0, 4).join("; ")}`, { verification: v });
  const pin = v.identity.controlTlsSpkiSha256;
  // the statement again, pinned: the same boot, and the adapter bundle it names
  const nonce = createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex");
  const ev = await tlsGet(url, `${EVIDENCE_PATH}?nonce=${nonce}`, { timeoutMs, pinSha256: pin });
  if (ev.status !== 200) throw new HostedMcpError(`evidence answered HTTP ${ev.status}`);
  const st = parseStatement(JSON.parse(ev.body.toString("utf8")).statement);
  if (st.bootId !== v.identity.bootId || st.keys.controlTls.spkiSha256 !== pin) throw new HostedMcpError("the guest restarted between verification and use: verify again");
  if (st.runtime?.mcpSha256 !== mcpSha256) throw new HostedMcpError(`the attested statement names adapter bundle ${st.runtime?.mcpSha256 || "none"}, not the reviewed ${mcpSha256}`);
  let seq = 0;
  const call = async (method, params = {}) => {
    const r = await pinnedPost(url, MCP_ROUTE, { jsonrpc: "2.0", id: ++seq, method, params }, { pinSha256: pin });
    if (r.status !== 200) throw new HostedMcpError(`the hosted adapter answered HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const j = JSON.parse(r.text);
    if (j.error) throw new HostedMcpError(`${method}: ${j.error.message}`);
    return j.result;
  };
  return { verification: v, statement: st, url, pin, call,
    tools: async () => (await call("tools/list")).tools,
    callTool: (name, args = {}) => call("tools/call", { name, arguments: args }) };
}

/**
 * The owner's own sealing facts: `local` is the owner's LOCAL independent server ({ call(name, args) } over its reviewed
 * profile and RPC quorum; mcp/hosted-connector.mjs openLocalAuthority). Nothing is asked of the hosted adapter.
 */
export async function localSealingFacts(local, { id, configText } = {}) {
  if (!local?.call) throw new HostedMcpError("secrets need the owner's local authority (a local independent profile): the hosted adapter never names the recipient");
  const r = await local.call("set_secrets", { id, action: "prepare", ...(configText !== undefined ? { configText } : {}) });
  if (r.isError) throw new HostedMcpError(`the owner's own quorum read failed, so nothing was sealed or sent: ${r.content[0].text}`);
  return r.structuredContent;
}

/**
 * Write a WHOLE secrets map through the hosted adapter:
 *   1. the owner's own read (local, first: when it fails, nothing is sent);
 *   2. the adapter's prepare, a hint compared field by field;
 *   3. seal here to the owner's own facts;
 *   4. write;
 *   5. the returned update checked before it is handed to the owner.
 * -> the adapter's write answer (the vault update for the policy owner to send). `env` never leaves this process.
 */
export async function remoteSetSecrets(client, { id, env, local, configText, configSha256 } = {}) {
  const expected = await localSealingFacts(local, { id, configText });
  const prep = await client.callTool("set_secrets", { id, action: "prepare" });
  if (prep.isError) throw new HostedMcpError(prep.content[0].text);
  const sealed = sealForRemote(prep.structuredContent, env, { expected, id, ...(configSha256 ? { configSha256 } : {}) });
  const w = await client.callTool("set_secrets", { id, action: "write", ...sealed });
  if (w.isError) throw new HostedMcpError(w.content[0].text);
  verifyRemoteUpdate(w.structuredContent, { expected, sealedBundle: sealed.sealedBundle });
  return w.structuredContent;
}
/**
 * Clear every value through the hosted adapter. No recipient is involved, so the owner's own CLEAR PLAN is the anchor:
 * the local server's clear, read first from the owner's quorum (an exact guarded update, or a verified no-op when
 * nothing is stored). The adapter's answer must match it (verifyRemoteClear), so a false no-op is refused.
 */
export async function remoteClearSecrets(client, { id, local }) {
  if (!local?.call) throw new HostedMcpError("secrets need the owner's local authority (a local independent profile): the hosted adapter's clear is checked against the owner's own read");
  const plan = await local.call("set_secrets", { id, payload: JSON.stringify({ clear: true }) });
  if (plan.isError) throw new HostedMcpError(`the owner's own read failed, so nothing was sent: ${plan.content[0].text}`);
  const w = await client.callTool("set_secrets", { id, action: "clear" });
  if (w.isError) throw new HostedMcpError(w.content[0].text);
  verifyRemoteClear(w.structuredContent, plan.structuredContent);
  return w.structuredContent;
}
