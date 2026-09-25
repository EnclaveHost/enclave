#!/usr/bin/env node
// mutate-pvm-runner-agent.mjs -- the mutation check behind the runner lifecycle agent (shielded/anchor/avf/runner/
// runner-agent.mjs; RUNNER-AGENT.md): each mutation breaks ONE rule the design states, and the test it names in
// test/pvm-runner-agent.test.mjs must fail on it. Same shape as test/mutate-pvm-proof-agent.mjs: a COPY of the tree in a temp
// directory, a CONTROL first, and a mutation whose text is not found exactly once fails the run. From the repo root:
//   node test/mutate-pvm-runner-agent.mjs            (all)       node test/mutate-pvm-runner-agent.mjs R03 R09   (some)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "test/pvm-runner-agent.test.mjs";
const RA = "shielded/anchor/avf/runner/runner-agent.mjs", PA = "shielded/anchor/avf/runner/proof-agent.mjs";
const T = { life: "the whole lifecycle on a local chain", entry: "the entry:", event: "a mined lifecycle call WITHOUT the event", claim: "the claim:",
            proven: "renew only what is proven", intr: "interrupted and restarted", fresh: "a key goes on-chain only from a FRESH statement", config: "runner config:",
            fresh2: "setProofKey carries the FRESH statement's key", meas: "the registered measurement is EXACTLY the attested build" };
const MUTATIONS = [
  ["R01", "a lease is renewed whether or not its app is serving", [[RA, "if (!serving) note(", "if (false) note("]], T.proven],
  ["R02", "\"serving\" judged from provenUntil (which trails for the rest of a lease after an outage)", [[RA, "const serving = s.lastProofAt + 2n", "const serving = s.provenUntil + 2n"]], T.intr],
  ["R03", "an entry the owner deactivated is revived (by the heartbeat)", [[RA, "if (!s.regActive) return L.register ?", "if (false) return L.register ?"]], T.entry],
  ["R04", "another operator's endpoint is not recognized", [[RA, "if (s.regOperator !== me) return {", "if (false) return {"]], T.entry],
  ["R05", "an old registered key is not replaced by the attested one", [[RA, "if (s.regProofKey !== key) {", "if (false) {"]], T.entry],
  ["R06", "a bond the owner did not authorize is not checked", [[RA, "if (bond > 0n) {", "if (false) {"]], T.claim],
  ["R07", "release without a final proof", [[RA, "      proof = await agent.tick();\n", "      proof = { kind: \"skipped\" };\n"]], T.life],
  ["R08", "a new transaction while one is in flight (both guards removed)", [[RA, "    if (agent.pending) {\n      const s = await agent.settlePending();", "    if (false) {\n      const s = await agent.settlePending();"],
                                                                              [PA, "if (pending) return { kind: \"busy\", op: c.op,", "if (false) return { kind: \"busy\", op: c.op,"]], T.intr],
  ["R09", "a mined call without its event counts as landed", [[PA, "if (!evs.length) return done(\"reverted\", { hash: t.hash, reason: `mined without its ${want} event` });", ""]], T.event],
  // enclave-99's review of e4ecc4aa
  ["R11", "register writes the earlier (possibly stale) attested key, not a fresh statement's", [[RA, "      const c = await fresh();\n      const k = c ? c.proofKey : null;", "      const c = await fresh();\n      const k = key;"]], T.fresh],
  ["R12", "the registered measurement is not tied to the attested build's pinned code hashes", [[RA, "if (!pinned.includes(r.measurement.slice(2))) bad(", "if (false) bad("]], T.config],
  ["R13", "setProofKey writes the earlier attestation's key, not the fresh statement's (enclave-99's Q2)", [[RA, "args: [E, k], event: \"ProofKeySet\"", "args: [E, key], event: \"ProofKey"+"Set\""]], T.fresh2],
  ["R14", "the config's measurement is published instead of the attested build", [[RA, "      if (measurement !== L.register.measurement)\n", "      if (false)\n"], [RA, "args: [cfg.endpoint, L.register.repo, measurement,", "args: [cfg.endpoint, L.register.repo, L.register.measurement,"]], T.meas],
  ["R10", "a renew decided from remembered state (the lease re-read skipped after a landing)", [[RA, "    const s = await agent.lease();\n    if (!agent.attested)", "    const s = globalThis.__lastLease || (globalThis.__lastLease = await agent.lease());\n    if (!agent.attested)"]], T.life],
];

const pick = process.argv.slice(2);
const todo = pick.length ? MUTATIONS.filter((m) => pick.includes(m[0])) : MUTATIONS;
if (pick.length && todo.length !== pick.length) { console.error(`unknown mutation id in ${pick.join(" ")}`); process.exit(2); }
const nm = path.join(ROOT, "node_modules");
if (!fs.existsSync(nm)) { console.error("the tests need node_modules at the repo root (a worktree: symlink the main checkout's)"); process.exit(2); }
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), "mutate-pvm-runner-agent-"));
const cleanup = () => fs.rmSync(COPY, { recursive: true, force: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
for (const d of ["relay", "test", "contracts", "shielded/anchor/avf/runner", "shielded/anchor/avf/web", "package.json"])
  fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
fs.symlinkSync(fs.realpathSync(nm), path.join(COPY, "node_modules"));
function run() {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=240000", SUITE], { cwd: COPY, encoding: "utf8", timeout: 900000 });
  const out = r.stdout || "";
  return { failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]), ran: /^# tests [1-9]/m.test(out), skipped: /^# skipped [1-9]/m.test(out) };
}
let bad = 0;
try {
  const c = run();
  const ok = c.ran && !c.skipped && c.failed.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} control: ${SUITE} passes unmutated, nothing skipped${ok ? "" : ` -- failing: ${c.failed.join(" | ") || "(did not run or skipped)"}`}`);
  if (!ok) throw new Error("the control failed: no mutation result would mean anything");
  for (const [id, what, edits, expect] of todo) {
    const origs = new Map(); let missing = null;
    for (const [file, from, to] of edits) {
      const f = path.join(COPY, file), src = origs.has(f) ? fs.readFileSync(f, "utf8") : (origs.set(f, fs.readFileSync(f, "utf8")), fs.readFileSync(f, "utf8"));
      const n = src.split(from).length - 1;
      if (n !== 1) { missing = `its text occurs ${n} times in ${file}, not once: ${JSON.stringify(from.slice(0, 60))}`; break; }
      fs.writeFileSync(f, src.replace(from, to));
    }
    if (missing) { for (const [f, o] of origs) fs.writeFileSync(f, o); console.log(`FAIL ${id} ${what}: ${missing}`); bad++; continue; }
    const r = run();
    for (const [f, o] of origs) fs.writeFileSync(f, o);
    const caught = r.failed.some((t) => t.includes(expect));
    console.log(`${caught ? "ok  " : "FAIL"} ${id} ${what}: ${caught ? `caught by "${expect}…"` : `NOT caught by "${expect}…" (failing: ${r.failed.join(" | ") || "none"})`}`);
    if (!caught) bad++;
  }
} catch (e) { console.log(`FAIL ${e.message}`); bad++; }
finally { cleanup(); }
console.log(bad ? `FAIL: ${bad} problem(s)` : `PASS: control clean, ${todo.length} of ${todo.length} mutations caught`);
process.exitCode = bad ? 1 : 0;
