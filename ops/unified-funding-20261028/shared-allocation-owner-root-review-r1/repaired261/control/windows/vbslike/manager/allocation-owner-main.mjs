#!/usr/bin/env node
/* Shared allocation r1: the ONE local owner process (SOURCE ONLY - authored, not run; not installed anywhere).

   ENCLAVE_ALLOCATION_OWNER_CONFIG + ENCLAVE_ALLOCATION_OWNER_CONFIG_SHA256 (pinned like the permit config):
     { domainId, port, keyFiles: { general, native }, ledger, coverage, domain? }
     ledger: { kind: "owned-log", file, storage: { sddl, parentSddl }, exclusion: "named" | { qualificationFile, qualificationSha256 } }
           | { kind: "owned-durable-state", file }                    (Linux flock store)
     coverage: { physical: {COVERAGE_TERMS}, commit: {COVERAGE_TERMS}, source }   OWNER-DECLARED bounds, every term required
   `--establish-isolated-domain` creates a NEW domain from config.domain and exits; it refuses any existing ledger. A normal
   start never creates one. The owner binds loopback only. Its sampler reads the OS (Windows Win32_OperatingSystem free
   physical/virtual memory; Linux /proc/meminfo); neither reading is qualified as a commit bound here. */
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { readPinnedJson } from "./compose.mjs";
import { openOwnedLog, WINDOWS_EXCLUSION, checkWindowsStorage } from "./win-durable.mjs";
import { windowsNumericExclusion, execSha256 } from "./win-exclusion.mjs";
import { powershellRunner } from "./psrun.mjs";
import { parseKey } from "./control.mjs";
import { LEDGER_PURPOSE, COVERAGE_TERMS, logStore, openDurableAllocationStore, establishLogDomain, establishDurableDomain, openAllocationOwner } from "./allocation-owner.mjs";
import { createAllocationService } from "./allocation-service.mjs";

const env = (k) => (process.env[k] || "").trim();
const die = (m) => { console.error(`[allocowner] REFUSING TO START: ${m}`); process.exit(2); };
let cfg;
try { cfg = readPinnedJson(env("ENCLAVE_ALLOCATION_OWNER_CONFIG"), env("ENCLAVE_ALLOCATION_OWNER_CONFIG_SHA256").toLowerCase(), "allocation owner configuration"); }
catch (e) { die(e.message); }
if (!Number.isSafeInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) die("port must be 1024..65535");
for (const side of ["physical", "commit"]) for (const k of COVERAGE_TERMS)
  if (!Number.isSafeInteger(cfg.coverage?.[side]?.[k]) || cfg.coverage[side][k] < 0) die(`coverage.${side}.${k} must be stated (MiB); no term defaults to zero`);
const coverageTerms = Object.freeze({ physical: { ...cfg.coverage.physical }, commit: { ...cfg.coverage.commit }, source: `owner-declared:${String(cfg.coverage.source || "unstated")}` });

const windows = process.platform === "win32";
const run = windows ? powershellRunner({ timeoutMs: 15_000 }) : null;
async function exclusionOf(l) {
  if (l.exclusion === "named") return WINDOWS_EXCLUSION;
  const q = readPinnedJson(l.exclusion?.qualificationFile, l.exclusion?.qualificationSha256, "EXLOCK qualification");
  return windowsNumericExclusion({ qualification: q, runtime: { platform: process.platform, version: process.version, execPath: process.execPath, execSha256: execSha256() } });
}
const SAMPLE_PS = "$o = Get-CimInstance Win32_OperatingSystem; @{freePhysKB=[int64]$o.FreePhysicalMemory; freeVirtKB=[int64]$o.FreeVirtualMemory} | ConvertTo-Json -Compress";
async function sampler() {
  const at = performance.now();                           // the START of the reading: conservative against later reflection
  if (windows) {
    const r = await run(SAMPLE_PS);
    if (r.code !== 0) throw Error(`sample failed (${r.code})`);
    const j = JSON.parse(String(r.stdout).trim());
    return { availablePhysicalMiB: Math.floor(Number(j.freePhysKB) / 1024), availableCommitMiB: Math.floor(Number(j.freeVirtKB) / 1024), at, source: "Win32_OperatingSystem (unqualified)" };
  }
  const m = Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => { const [k, v] = l.split(":"); return [k, parseInt(v, 10)]; }));
  return { availablePhysicalMiB: Math.floor(m.MemAvailable / 1024), availableCommitMiB: Math.floor((m.CommitLimit - m.Committed_AS) / 1024), at, source: "/proc/meminfo (unqualified)" };
}

const l = cfg.ledger || {};
if (process.argv.includes("--establish-isolated-domain")) {
  try {
    if (l.kind === "owned-log") establishLogDomain(l.file, { domain: cfg.domain, exclusion: await exclusionOf(l) });
    else if (l.kind === "owned-durable-state") await establishDurableDomain(l.file, { domain: cfg.domain });
    else throw Error("unknown ledger kind");
    console.log(`[allocowner] established isolated allocation domain ${cfg.domain?.id} at ${l.file}`); process.exit(0);
  } catch (e) { console.error(`[allocowner] establishment refused: ${e.message}`); process.exit(2); }
}

let store;
try {
  if (l.kind === "owned-log") {
    if (!windows) throw Error("the owned-log ledger needs Windows exclusion");
    await checkWindowsStorage(run, l.file, l.storage);
    store = logStore(openOwnedLog(l.file, { purpose: LEDGER_PURPOSE, exclusion: await exclusionOf(l) }));
  } else if (l.kind === "owned-durable-state") store = await openDurableAllocationStore(l.file);
  else throw Error("unknown ledger kind");
} catch (e) { die(`allocation ledger: ${e.message}`); }
let owner, keys;
try {
  owner = openAllocationOwner({ store, domainId: cfg.domainId, sampler, coverage: async () => coverageTerms });
  keys = Object.fromEntries(owner.domain.roles.map((r) => [r, parseKey(fs.readFileSync(cfg.keyFiles?.[r], "utf8"))]));
} catch (e) { die(e.message); }
const server = createAllocationService(owner, { keys });
server.listen(cfg.port, "127.0.0.1", () => {
  const s = owner.status();
  console.log(`[allocowner] domain ${s.domain} owner ${s.ownerIncarnation} (generation ${s.ownerGeneration}) on 127.0.0.1:${cfg.port}; `
    + `${s.active} unresolved reservation(s) retained; storage ${s.storage}/${s.exclusion}; ${s.qualification}`);
});
setInterval(() => { owner.sweep().catch((e) => console.error(`[allocowner] ${e.message}`)); }, 30_000).unref();
