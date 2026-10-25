#!/usr/bin/env node
// A coding agent's LOCAL connector to a hosted independent MCP adapter (docs/network/hosted-mcp.md): an MCP stdio server on
// the user's machine. Each step:
//   1. At start it proves the endpoint is the expected measured control guest running the reviewed adapter
//      (mcp/hosted-client.mjs connectHostedMcp: SEV-SNP report, HOST_DATA binding the expected config, TLS key, registry,
//      runtime.mcpSha256). It serves nothing until that passes.
//   2. Every tool is forwarded unchanged over the attested, pinned TLS connection: reads, unsigned builders, session
//      calls and client-signed host requests. The adapter holds no key and signs nothing.
//   3. set_secrets and get_secrets never reach the hosted adapter. They run in the owner's OWN local independent server,
//      in this process (`authority`: the owner's reviewed independent profile and RPC quorum, mcp/server.mjs's local
//      tool set). Every existing operation stays available exactly as the local server offers it:
//        - replace, clear, the sealed-bundle form;
//        - merge and per-key removal, after the owner read (two steps; the owner's wallet signs the OwnerRead);
//        - get_secrets (the same owner read);
//        - prepare (the owner's own sealing facts).
//      The recipient (committee key, label fields, revisions) is read from that quorum, never from the adapter. Without a
//      configured `authority`, both tools are refused here and nothing is sent.
//
//   node mcp/hosted-connector.mjs --config connector.json
//     connector.json: { "url": "https://<forwarded control port>", "expect": { "config": {…the guest's direct config…},
//       "measurements": ["<96 hex>"], "minTcb": {…} }, "mcpSha256": "<64 hex>", "collateral": "amd" | { "dir": "PATH" },
//       "registry": { "rpcs": [...], "quorum": 2 } | null, "allowPending": false,
//       "authority": { "config": "local-mcp.json", "profile": "base" } }
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { connectHostedMcp } from "./hosted-client.mjs";

const SECRETS = new Set(["set_secrets", "get_secrets"]);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const NO_AUTHORITY = "Error: secrets run only in the owner's own client: configure `authority` (the owner's reviewed independent profile: { config, profile }) in connector.json. The hosted adapter is never asked for secrets or for the key they are sealed to. Nothing was sent.";

/**
 * The owner's LOCAL independent server in this process, over its own reviewed profile (mcp/independent.mjs loadConfig):
 * -> { tools: () => tools, call(name, args) -> MCP tool result }
 */
export async function openLocalAuthority({ config, profile }, deps = {}) {
  const { loadConfig } = await import("./independent.mjs");
  const { createIndependentServer } = await import("./server.mjs");
  const cfg = loadConfig(config);
  const p = profile !== undefined ? cfg.profiles.get(profile) : cfg.profiles.size === 1 ? [...cfg.profiles.values()][0] : null;
  if (!p) throw new Error(`authority: name one of the profiles in ${config} (${[...cfg.profiles.keys()].join(", ")})`);
  const server = createIndependentServer(p, deps);
  let seq = 0;
  return { name: p.name, tools: async () => server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: async (name, args) => { const r = await server.dispatch({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } });
      return r.error ? text(`Error: ${r.error.message}`, true) : r.result; } };
}

export async function startConnector(client, { input = process.stdin, output = process.stdout, local = null } = {}) {
  const hostedTools = await client.tools();
  // the secrets tools are the owner's LOCAL server's own definitions (or a refusal stub without one)
  const localTools = local ? new Map((await local.tools()).filter((t) => SECRETS.has(t.name)).map((t) => [t.name, t])) : new Map();
  const tools = hostedTools.map((t) => !SECRETS.has(t.name) ? t : localTools.get(t.name)
    || { name: t.name, description: NO_AUTHORITY.slice(7), inputSchema: { type: "object", properties: {} } });
  const handle = async (m) => {
    if (!m || m.jsonrpc !== "2.0" || m.method === undefined || m.id === undefined || m.id === null) return null;
    const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") return ok({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "enclave", title: "Enclave (hosted, verified connector)", version: "1.0.0" },
      instructions: `Connected to the hosted independent MCP adapter at ${client.url}, verified as the expected measured control guest (TLS key sha256:${client.pin.slice(0, 16)}…). ${local ? `Secrets run in the owner's own local client (profile ${local.name}): the hosted adapter never sees them or chooses their recipient.` : "Secrets are unavailable until a local authority is configured; nothing about them is sent to the hosted adapter."}` });
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") return ok({ tools });
    if (m.method === "tools/call") {
      const name = m.params?.name, args = m.params?.arguments || {};
      if (SECRETS.has(name)) return ok(local ? await local.call(name, args) : text(NO_AUTHORITY, true));
      try { return ok(await client.callTool(name, args)); } catch (e) { return ok(text(`Error: ${String(e.message).slice(0, 300)}`, true)); }
    }
    return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  };
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
    const out = await handle(m);
    if (out) output.write(JSON.stringify(out) + "\n");
  });
  return new Promise((r) => rl.on("close", r));
}

async function main(argv) {
  const i = argv.indexOf("--config");
  if (i < 0) throw new Error("usage: hosted-connector.mjs --config connector.json");
  const cfg = JSON.parse(fs.readFileSync(argv[i + 1], "utf8"));
  const C = await import("../verifier/collateral.mjs");
  const collateral = cfg.collateral === "amd" ? C.httpCollateral() : cfg.collateral?.dir ? C.fileCollateral(path.resolve(path.dirname(argv[i + 1]), cfg.collateral.dir)) : null;
  if (!collateral) throw new Error('collateral: "amd" (AMD KDS) or { "dir": PATH }');
  let registry = null;
  if (cfg.registry) {
    const { QuorumChain, readHost, requireSchema4 } = await import("../cli/independent.mjs");
    const chain = new QuorumChain({ rpcs: cfg.registry.rpcs, quorum: cfg.registry.quorum || 2, confirmations: 1 });
    const reg = cfg.expect.config.contracts.registry;
    registry = async (rid) => { const s = await chain.snapshot((c, b) => readHost(c, reg, rid, b)); if (s.value.schema !== undefined && s.value.host === undefined) requireSchema4(s.value.schema);
      const h = s.value.host; return h ? { operator: h.operator, proofKey: h.proofKey, active: h.active } : null; };
  }
  const local = cfg.authority ? await openLocalAuthority({ config: path.resolve(path.dirname(argv[i + 1]), cfg.authority.config), profile: cfg.authority.profile }) : null;
  const client = await connectHostedMcp({ url: cfg.url, expect: cfg.expect, collateral, registry, mcpSha256: cfg.mcpSha256, allowPending: cfg.allowPending === true });
  process.stderr.write(`hosted MCP verified: ${client.verification.status}; TLS sha256:${client.pin.slice(0, 16)}…; adapter ${cfg.mcpSha256.slice(0, 16)}…\n`);
  await startConnector(client, { local });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`hosted-connector: ${e.message}\n`); process.exit(1); });
