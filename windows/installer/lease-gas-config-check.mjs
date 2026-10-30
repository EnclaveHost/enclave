// lease-gas-config-check.mjs - READ-ONLY: does a lease-gas-config.cmd (the `@set "NAME=value"` lines the node's run loop
// calls) load in a GIVEN lease-gas runtime bundle exactly as the node agent loads it (windows/node/chain.mjs:
// loadLeaseGasConfig over the ENCLAVE_/LEASE_GAS_ names, no RPC, no signing), and is it the reviewed shape?
//   node lease-gas-config-check.mjs --bundle <lease-gas-runtime.bundle.mjs> --config <lease-gas-config.cmd>
//        [--expect-local <origin>|none] [--expect-relays <origin,origin>|none] [--expect-pinned <origin,payee,operator[;...]>|none]
// The config holds public values only (record path and digest, RPC and relay origins, quorum, reserve). The deployment
// record it names is read and checked against its digest. Prints one JSON line; exit 0 ok, 1 refused, 2 usage.
// The host's own binding (its AddressBook ledger/registry) is checked again by the agent before every send; here the
// record's own ledger/registry stand in for it, so this proves the file's syntax, digest and relay rules, not the binding.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) { if (!/^--[a-z-]+$/.test(args[i]) || args[i + 1] === undefined) { console.error("usage: --bundle B --config C [--expect-local X|none] [--expect-relays X,Y|none] [--expect-pinned O,P,R[;...]|none]"); process.exit(2); } opt[args[i].slice(2)] = args[i + 1]; }
if (!opt.bundle || !opt.config) { console.error("usage: --bundle B --config C [--expect-local X|none] [--expect-relays X,Y|none] [--expect-pinned O,P,R[;...]|none]"); process.exit(2); }

/** `@set "NAME=value"` (or `set NAME=value`) lines -> { NAME: value }; only lease-gas names; anything else is refused */
export function parseLeaseGasCmd(text) {
  const env = {}, problems = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^@?rem(\s|$)/i.test(line) || /^@?echo\s+off$/i.test(line)) continue;
    const m = /^@?set\s+"([A-Z_]+)=([^"]*)"$/i.exec(line) || /^@?set\s+([A-Z_]+)=(.*)$/i.exec(line);
    if (!m) { problems.push(`not a set line: ${line.slice(0, 60)}`); continue; }
    if (!/^(ENCLAVE_)?LEASE_GAS_[A-Z_]+$/.test(m[1])) { problems.push(`not a lease-gas name: ${m[1]}`); continue; }
    if (m[1] in env) problems.push(`${m[1]} is set twice`);
    env[m[1]] = m[2];
  }
  return { env, problems };
}

const out = { config: path.resolve(opt.config), bundle: path.resolve(opt.bundle) };
try {
  const { env, problems } = parseLeaseGasCmd(fs.readFileSync(opt.config, "utf8"));
  if (problems.length) throw new Error(problems.join("; "));
  const rt = await import(pathToFileURL(path.resolve(opt.bundle)).href);
  if (!rt.leaseGasConfigured(env)) throw new Error("the file configures no lease-gas setting (that is operator-paid, never acceptable here)");
  const file = env.ENCLAVE_LEASE_GAS_FILE || env.LEASE_GAS_FILE;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = rt.loadLeaseGasConfig({ env, chain: { id: record.chainId }, ledger: record.ledger, registry: record.registry });
  Object.assign(out, { ok: true, chainId: cfg.deployment.chainId, reserve: cfg.reserve, quorum: cfg.quorum, rpcs: cfg.clients.length,
    localRelays: [...(cfg.localRelays || [])], relays: [...cfg.relays], pinnedRelays: (cfg.pinnedRelays || []).map((r) => `${r.origin},${r.payee},${r.operator}`), discovery: !!cfg.relayDiscovery });
  const want = (x) => (x === "none" ? [] : String(x).split(",").map((s) => s.trim()).filter(Boolean));
  if (opt["expect-local"] !== undefined && JSON.stringify(out.localRelays) !== JSON.stringify(want(opt["expect-local"]))) throw new Error(`local relays ${JSON.stringify(out.localRelays)}, not ${JSON.stringify(want(opt["expect-local"]))}`);
  if (opt["expect-relays"] !== undefined && JSON.stringify(out.relays) !== JSON.stringify(want(opt["expect-relays"]))) throw new Error(`relays ${JSON.stringify(out.relays)}, not ${JSON.stringify(want(opt["expect-relays"]))}`);
  // pinned host-local relays (each origin,payee,operator), compared case-insensitively on the addresses
  const pinnedWant = (x) => (x === "none" ? [] : String(x).split(";").map((s) => s.trim()).filter(Boolean)).map((e) => e.split(",").map((f, i) => (i ? f.trim().toLowerCase() : f.trim())).join(","));
  if (opt["expect-pinned"] !== undefined && JSON.stringify(out.pinnedRelays.map((e) => pinnedWant(e)[0])) !== JSON.stringify(pinnedWant(opt["expect-pinned"])))
    throw new Error(`pinned relays ${JSON.stringify(out.pinnedRelays)}, not ${JSON.stringify(opt["expect-pinned"])}`);
  if (out.discovery) throw new Error("this rollout configures no relay discovery (SERVICE_INDEX)");
} catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 400); }
console.log(JSON.stringify(out));
process.exitCode = out.ok ? 0 : 1;
