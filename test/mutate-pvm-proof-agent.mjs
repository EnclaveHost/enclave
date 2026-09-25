#!/usr/bin/env node
// mutate-pvm-proof-agent.mjs -- the mutation check behind the posting agent (shielded/anchor/avf/runner/proof-agent.mjs): each
// mutation below breaks ONE property the agent claims, and the test it names in test/pvm-proof-agent.test.mjs must fail on it.
// From the repo root:
//   node test/mutate-pvm-proof-agent.mjs            (all)       node test/mutate-pvm-proof-agent.mjs A04 A12   (some)
// Same shape as test/mutate-pvm-serving.mjs: it works on a COPY of the tree in a temp directory, never on the checkout; first a
// CONTROL (the unmutated copy must pass the suite); a mutation whose text is not found exactly once fails the run. Exit 0 only
// when the control passes and every mutation is caught by the test it names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "test/pvm-proof-agent.test.mjs", PA = "shielded/anchor/avf/runner/proof-agent.mjs";
const T = {   // the tests, by a distinctive part of their titles
  full: "the full path on a local lease", pins: "pins must agree before anything is asked", lease: "the lease and the key decide",
  cap: "the owner's fee cap", hostile: "a hostile carrier", idem: "idempotency:", replace: "a transaction that does not mine is replaced",
  stuck: "a nonce left stuck past its anchor's age", reorg: "reorganizations:",
};
const MUTATIONS = [
  ["A01", "a replayed or crossed answer is accepted (no equality with the request)", [["if (c.upto !== upto || c.anchorBlock !== anchorBlock || c.anchorHash !== anchorHash)", "if (false)"]], T.hostile],
  ["A02", "no simulation before sending (a fixed gas limit instead)", [["      await publicClient.simulateContract({ account: me, address: addrs.proofOfTime, abi: POT_ABI, functionName: \"checkpoint\", args: txArgs(cp) });\n", ""],
                                                                    ["gas = await publicClient.estimateContractGas({ account: me, address: addrs.proofOfTime, abi: POT_ABI, functionName: \"checkpoint\", args: txArgs(cp) });", "gas = 400000n;"]], T.idem],
  ["A03", "the transaction is journaled AFTER it is broadcast", [["    note({ ev: \"tx\", digest: c.digest, nonce: p.nonce, ...t, replacement: !!replacement });   // journaled BEFORE it can reach any node\n    p.txs.push(t); if (replacement) p.replacements++;\n    return broadcast(t);",
                                                                 "    p.txs.push(t); if (replacement) p.replacements++;\n    const b0 = await broadcast(t);\n    note({ ev: \"tx\", digest: c.digest, nonce: p.nonce, ...t, replacement: !!replacement });\n    return b0;"]], T.idem],
  ["A04", "a replacement bids no more than what it replaces", [["const bump = (x) => x + (x * BigInt(P.feeBumpPct) + 99n) / 100n;", "const bump = (x) => x;"]], T.replace],
  ["A05", "a never-mined proof whose anchor was reorganized away is not recognized", [["if (!anc || anc.hash !== p.checkpoint.anchorHash)", "if (false)"]], T.reorg],
  ["A06", "the ledger's runner and operator are not checked", [["if (L.runner !== E || L.runnerOperator !== me) return out(", "if (false) return out("]], T.lease],
  ["A07", "the registered proof key is not compared with the attested one", [["if (L.regProofKey !== attested.claims.proofKey)", "if (false)"]], T.lease],
  ["A08", "a stuck nonce is never cancelled", [["if (carry && pending === carry) {", "if (false) {"]], T.stuck],
  ["A09", "confirmations are not waited for", [["if (n >= r.blockNumber + BigInt(P.confirmations - 1)) break;", "break;"]], T.full],
  ["A10", "a receipt is not re-checked for a reorganization", [["if (!r2 || r2.blockHash !== r.blockHash || !blk || blk.hash !== r.blockHash) {", "if (false) {"]], T.reorg],
  ["A11", "two agents may share a state directory", [["if (alive) throw new Error(", "if (false) throw new Error("]], T.pins],
  ["A12", "the owner's fee cap is ignored", [["if (L.head.baseFeePerGas != null && L.head.baseFeePerGas > cap()) return out(", "if (false) return out("]], T.cap],
  ["A13", "the VM's 60 s rate is not honoured by the agent", [["if (now() - lastCheckpointAskAt < P.vmGapSec * 1000) return out(", "if (false) return out("]], T.full],
  ["A14", "the attested pins are not compared with this lease", [["for (const [k, x] of Object.entries(want)) if (v.claims[k] !== x) {", "for (const [k, x] of Object.entries(want)) if (false) {"]], T.lease],
  ["A15", "the config's address is not checked against the address book", [["if (a[k] && a[k] !== book[k]) throw", "if (false) throw"]], T.pins],
  ["A16", "the prover's own registry binding is not checked", [["if (lc(potRegistry) !== a.registry) throw", "if (false) throw"]], T.pins],
  ["A17", "the RPC's chain id is not checked", [["if (String(rpcChain) !== cfg.chainId) throw", "if (false) throw"]], T.pins],
  ["A18", "an aged-out anchor is replaced with the same aged proof", [["if (age >= P.maxAnchorAgeBlocks) return keep(", "if (false) return keep("]], T.stuck],
  ["A19", "recovery does not rebroadcast the journaled bytes", [["< P.maxAnchorAgeBlocks) for (const t of pending.txs) await broadcast(t);", "< P.maxAnchorAgeBlocks) {}"]], T.idem],
];

const pick = process.argv.slice(2);
const todo = pick.length ? MUTATIONS.filter((m) => pick.includes(m[0])) : MUTATIONS;
if (pick.length && todo.length !== pick.length) { console.error(`unknown mutation id in ${pick.join(" ")}`); process.exit(2); }
const nm = path.join(ROOT, "node_modules");
if (!fs.existsSync(nm)) { console.error("the tests need node_modules at the repo root (a worktree: symlink the main checkout's)"); process.exit(2); }

const COPY = fs.mkdtempSync(path.join(os.tmpdir(), "mutate-pvm-proof-agent-"));
const cleanup = () => fs.rmSync(COPY, { recursive: true, force: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const noModules = (src) => path.basename(src) !== "node_modules";
for (const d of ["relay", "test", "contracts", "shielded/anchor/avf/runner", "shielded/anchor/avf/web", "package.json"])
  fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true, filter: noModules });
fs.symlinkSync(fs.realpathSync(nm), path.join(COPY, "node_modules"));

function run() {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", SUITE], { cwd: COPY, encoding: "utf8", timeout: 600000 });
  const out = r.stdout || "";
  return { failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]), ran: /^# tests [1-9]/m.test(out), skipped: /^# skipped [1-9]/m.test(out) };
}

let bad = 0;
try {
  const c = run();
  const ok = c.ran && !c.skipped && c.failed.length === 0;
  console.log(`${ok ? "ok  " : "FAIL"} control: ${SUITE} passes unmutated, nothing skipped${ok ? "" : ` -- failing: ${c.failed.join(" | ") || (c.skipped ? "(skipped: no anvil or openssl)" : "(did not run)")}`}`);
  if (!ok) throw new Error("the control failed: no mutation result would mean anything");
  for (const [id, what, edits, expect] of todo) {
    const f = path.join(COPY, PA), orig = fs.readFileSync(f, "utf8");
    let src = orig, missing = null;
    for (const [from, to] of edits) {
      const n = src.split(from).length - 1;
      if (n !== 1) { missing = `its text occurs ${n} times, not once: ${JSON.stringify(from.slice(0, 60))}`; break; }
      src = src.replace(from, to);
    }
    if (missing) { console.log(`FAIL ${id} ${what}: ${missing}`); bad++; continue; }
    fs.writeFileSync(f, src);
    const r = run();
    fs.writeFileSync(f, orig);
    const caught = r.failed.some((t) => t.includes(expect));
    console.log(`${caught ? "ok  " : "FAIL"} ${id} ${what}: ${caught ? `caught by "${expect}…"` : `NOT caught by "${expect}…" (failing: ${r.failed.join(" | ") || "none"})`}`);
    if (!caught) bad++;
  }
} catch (e) { console.log(`FAIL ${e.message}`); bad++; }
finally { cleanup(); }
console.log(bad ? `FAIL: ${bad} problem(s)` : `PASS: control clean, ${todo.length} of ${todo.length} mutations caught`);
process.exitCode = bad ? 1 : 0;
