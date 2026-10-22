#!/usr/bin/env node
// Independent host capacity (docs/network/independent-capacity.md): what `enclave availability` answers through the
// Enclave relay, read instead from hosts' own signed capacity records, verified against an explicitly pinned, reviewed
// registry at one agreed RPC-quorum block. No Enclave endpoint is used or defaulted.
//
//   node cli/independent-capacity.mjs availability --profile FILE --profile-digest sha256:… --rpc A --rpc B
//        [--directory ORIGIN]… [--host ENDPOINT|HOSTID]… [--cold] [--max-hosts N] [--state FILE] [--json]
//   node cli/independent-capacity.mjs record --key-file FILE --endpoint URL --availability FILE|- --profile FILE --profile-digest sha256:…
//        [--lifetime-sec N]                      (print a signed record: for a host without the producer hook)
//   node cli/independent-capacity.mjs publish --file ENVELOPE --directory ORIGIN…
//   node cli/independent-capacity.mjs serve-directory --port N [--bind ADDR] --profile FILE --profile-digest sha256:… --rpc A --rpc B
//
// What the numbers are: each host operator's own report, signed by the registry's active operator for that host. A
// signature is not proof that the hardware exists or is free; claims and attestation decide that. Posted registry
// prices are shown beside, and are never capacity.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage:
  independent-capacity availability --profile FILE --profile-digest sha256:<hex> --rpc URL --rpc URL [--directory ORIGIN]... [--host ENDPOINT|ID]... [--cold] [--max-hosts N] [--state FILE] [--json]
  independent-capacity record --key-file FILE --endpoint URL --availability FILE|- --profile FILE --profile-digest sha256:<hex> [--lifetime-sec N]
  independent-capacity publish --file ENVELOPE --directory ORIGIN...
  independent-capacity serve-directory --port N [--bind ADDR] --profile FILE --profile-digest sha256:<hex> --rpc URL --rpc URL`;

function parse(argv) {
  const multi = new Set(["--rpc", "--directory", "--host"]), bool = new Set(["--cold", "--json"]);
  const vals = new Set(["--profile", "--profile-digest", "--max-hosts", "--state", "--key-file", "--endpoint", "--availability", "--lifetime-sec", "--file", "--port", "--bind"]);
  const o = { _: [], rpc: [], directory: [], host: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bool.has(a)) o[a.slice(2)] = true;
    else if (multi.has(a) || vals.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = argv[++i], k = a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      if (multi.has(a)) o[k].push(...v.split(",").map((x) => x.trim()).filter(Boolean)); else o[k] = v;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else o._.push(a);
  }
  return o;
}
const int = (v, what, lo, hi) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new Error(`${what} must be an integer ${lo}..${hi}`); return n; };

async function trust(o, deps) {
  if (!o.profile || !o.profileDigest) throw new Error("an explicit reviewed authority profile is required: --profile FILE --profile-digest sha256:<hex> (there is no default)");
  const { parseProfile } = await import("../network/authority-profile.mjs");
  const { capacityRegistryBinding } = await import("../network/host-capacity-http.mjs");
  const { profile, digest } = parseProfile(fs.readFileSync(o.profile), { expectedDigest: o.profileDigest });
  return { binding: capacityRegistryBinding(profile), profile, digest };
}
async function quorum(o, deps) {
  if (deps.reader) return deps.reader;
  if (o.rpc.length < 2) throw new Error("two or more RPCs on distinct hosts are required: --rpc A --rpc B (there is no default set)");
  const { quorumReader, rpcClients } = await import("../windows/node/host-identity.mjs");
  return quorumReader({ clients: await rpcClients(o.rpc) });
}

/**
 * The read `enclave availability --independent` and this CLI share: hosts' signed records from the named sources,
 * verified against the reviewed profile's registry at one agreed block of `reader` (host-identity quorumReader or
 * cli/independent.mjs QuorumChain). state: optional file of replay floors, kept across runs.
 */
export async function readCapacity({ reader, profile, directories = [], hosts = [], cold = false, maxHosts, state, now = Date.now, fetchHost, fetchDirectory }) {
  const H = await import("../network/host-capacity-http.mjs"), { CapacityFloors } = await import("../network/host-capacity.mjs");
  const binding = H.capacityRegistryBinding(profile);
  let floors = new CapacityFloors();
  if (state && fs.existsSync(state)) floors = CapacityFloors.from(JSON.parse(fs.readFileSync(state, "utf8")));
  const r = await H.discoverHostCapacity({ reader, binding, directories, hosts, cold: !!cold, now, floors,
    maxHosts: maxHosts !== undefined && maxHosts !== null ? int(maxHosts, "--max-hosts", 1, 4096) : 256,
    ...(fetchHost ? { fetchHost } : {}), ...(fetchDirectory ? { fetchDirectory } : {}) });
  if (state) { fs.writeFileSync(state + ".tmp", JSON.stringify(floors)); fs.renameSync(state + ".tmp", state); }
  return r;
}

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
/** Print a readCapacity result for a person: out(line). */
export function renderCapacity(r, digest, out) {
  const a = r.aggregate, line = (k, v) => out(`${k.padEnd(18)} ${v}`);
  line("registry", `${r.quorum.registry} (reviewed profile ${digest}), block ${r.quorum.blockNumber} (${r.quorum.blockHash.slice(0, 10)}…) agreed`);
  line("hosts", `${a.enclaves} verified record(s), ${a.claiming} claiming, ${a.unknown} without a verified record`);
  line("best gpu slice", a.gpu ? `${pct(a.gpuShareFree)} of a card (${a.vramFreeGb} GB vram, ${a.smFree} SMs)` : "none");
  line("best cpu pool", a.claiming ? `${pct(a.cpuShareFree)} of a node (${a.vcpusFree} vcpus, ${a.ramGbFree} GB)` : "none");
  if (a.gpu) line("gpu-node cpu", `${pct(a.gpuEnclaveCpuShareFree)} (rides with gpu work)`);
  if (a.shielded) line("enclave shield", `${pct(a.shielded.gpuShareFree)} of a card (T0-hv: the host is not excluded)`);
  line("free, all hosts", `${a.totals.vcpusFree} vcpus, ${a.totals.ramGbFree} GB ram, ${a.totals.vramFreeGb} GB vram (each host once)`);
  out("");
  for (const h of r.hosts) {
    const c = h.capacity, av = c.availability;
    const what = c.status === "verified"
      ? `${av.type || (av.gpu ? "gpu" : "cpu")}${av.isolation ? " " + av.isolation : ""} cpu ${pct(av.cpuShareFree)}${av.gpu ? ` gpu ${pct(av.gpuShareFree)}` : ""}${av.shielded ? ` shield ${pct(av.gpuShareFree)}` : ""} claim ${av.claimEnabled === true ? "on" : "off"}, until ${new Date(c.expiresAt).toISOString()}`
      : `${c.status}${c.reasons.length ? ": " + c.reasons[0] : ""}`;
    out(`${(h.endpoint || h.hostId).slice(0, 48).padEnd(48)} ${what}${h.registry ? `  [posted cpu ${h.registry.cpuPricePerSec6}/s]` : ""}`);
  }
  for (const s of r.sources.filter((x) => !x.ok)) out(`! ${s.kind} ${s.source}: ${s.error}`);
  out("self-reported by each host's registry operator; a signature is not proof of free hardware. Posted prices are registry facts, not capacity.");
}

export async function main(argv, deps = {}) {
  const out = deps.stdout || ((s) => process.stdout.write(s + "\n"));
  const o = parse(argv), cmd = o._[0];
  const { now = Date.now } = deps;
  if (cmd === "availability") {
    const t = await trust(o, deps), reader = await quorum(o, deps);
    const r = await readCapacity({ reader, profile: t.profile, directories: o.directory, hosts: o.host, cold: o.cold, maxHosts: o.maxHosts, state: o.state, now,
      fetchHost: deps.fetchHost, fetchDirectory: deps.fetchDirectory });
    if (o.json) out(JSON.stringify({ ...r, profileDigest: t.digest }, null, 2)); else renderCapacity(r, t.digest, out);
    return r;
  }
  if (cmd === "record") {
    for (const k of ["keyFile", "endpoint", "availability"]) if (!o[k]) throw new Error(`record needs --${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}\n${USAGE}`);
    const t = await trust(o, deps);
    const { privateKeyToAccount } = await import("viem/accounts");
    const key = fs.readFileSync(o.keyFile, "utf8").trim();
    const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
    const text = o.availability === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(o.availability, "utf8");
    const { buildHostCapacityRecord, signHostCapacity } = await import("../network/host-capacity.mjs");
    const env = await signHostCapacity(account, buildHostCapacityRecord({ availability: JSON.stringify(JSON.parse(text)), chainId: t.binding.chainId, registry: t.binding.address,
      endpoint: o.endpoint.replace(/\/+$/, ""), operator: account.address, now: now(), lifetimeMs: (o.lifetimeSec ? int(o.lifetimeSec, "--lifetime-sec", 30, 900) : 300) * 1000 }));
    out(JSON.stringify(env));
    return env;
  }
  if (cmd === "publish") {
    if (!o.file || !o.directory.length) throw new Error(`publish needs --file and --directory\n${USAGE}`);
    const { directoryOrigins } = await import("../network/directory-client.mjs");
    const { directoryJsonFetch, DIRECTORY_CAPACITY_PATH } = await import("../network/host-capacity-http.mjs");
    const body = fs.readFileSync(o.file, "utf8"), f = deps.fetchDirectory || directoryJsonFetch();
    const results = await Promise.all(directoryOrigins(o.directory).map(async (origin) => {
      try { const r = await f(origin + DIRECTORY_CAPACITY_PATH, { method: "POST", body }); return { origin, ok: r.status === 200, status: r.status, error: r.json?.error }; }
      catch (e) { return { origin, ok: false, error: e.message }; }
    }));
    out(JSON.stringify({ published: results }));
    if (!results.some((r) => r.ok)) throw new Error("no directory accepted the record");
    return results;
  }
  if (cmd === "serve-directory") {
    const t = await trust(o, deps), reader = await quorum(o, deps);
    const { createHostCapacityDirectory } = await import("../network/host-capacity-http.mjs");
    const d = createHostCapacityDirectory({ reader, binding: t.binding, now, log: (m) => out(m) });
    const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
      if (!(await d.handle(req, res))) { req.resume(); res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); }
    });
    const port = int(o.port ?? "0", "--port", 0, 65535);
    await new Promise((r) => server.listen(port, o.bind || "127.0.0.1", r));
    out(`host capacity directory on ${o.bind || "127.0.0.1"}:${server.address().port} for registry ${t.binding.address} (profile ${t.digest})`);
    return server;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`independent-capacity: ${e.shortMessage || e.message}\n`); process.exit(1); });
