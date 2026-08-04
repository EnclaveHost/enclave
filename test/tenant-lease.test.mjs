// Dead-man lease on every tenant (wasm_manager._lease_expired + the supervisor's
// vouchesForLease). Teardown used to be purely INSTRUCTED, so every link failed
// open: a lost DELETE, an unreachable manager, a supervisor that crashed between
// stopping and releasing, all left the tenant running forever holding its whole
// slice. That stranded 17.6 GB of resident ggml weights on kryptos TWICE
// (2026-08-03) - the second time with an instructed reclaimer already deployed,
// because a reclaimer reclaims over the same channel that failed.
//
// The invariant here is the inversion: the default on silence is RELEASE, not
// HOLD. The supervisor never has to successfully instruct a teardown; it only
// has to stop vouching, which is also what a crashed supervisor does for free.
//
// The two ways this could be WORSE than the leak, both pinned below:
//   - reaping when no heartbeat was ever heard (an older supervisor -> mass reap)
//   - reaping on silence (a manager-API blip -> fleet outage, while the data
//     path, which does not run through that API, was serving perfectly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const SUPERVISOR = path.join(REPO, "supervisor.js");

// Drive _lease_expired directly: set the module's lease state + a tenant table,
// ask which ids it would reap. The module guards its server behind __main__, so
// importing is side-effect free (same trick as vmmgr-token-derivation).
function expired({ apps, lastBeatAgo, now = 1_000_000, ttl = 300, silence = 180 }) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
m._lease_last_beat = ${lastBeatAgo === null ? "None" : `${now} - ${lastBeatAgo}`}
m.TENANT_LEASE_SILENCE = ${silence}
m._apps = {a["id"]: a for a in json.loads(${JSON.stringify(JSON.stringify(apps))})}
print(json.dumps(m._lease_expired(${now})))
`;
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim().split("\n").pop());
}

// a tenant whose lease lapsed `ago` seconds before `now`
const lapsed = (id, ago = 10, now = 1_000_000) => ({ id, name: id, status: "running", leaseUntil: now - ago });
const fresh = (id, ahead = 200, now = 1_000_000) => ({ id, name: id, status: "running", leaseUntil: now + ahead });

test("a lapsed lease is reaped while the supervisor is talking", () => {
  assert.deepEqual(expired({ apps: [lapsed("app_orphan")], lastBeatAgo: 5 }), ["app_orphan"]);
});

test("a renewed lease is never touched", () => {
  assert.deepEqual(expired({ apps: [fresh("app_live")], lastBeatAgo: 5 }), []);
});

test("INERT until the first heartbeat: an older supervisor cannot mass-reap", () => {
  // the rollout case — a manager running the lease against a supervisor that
  // has never heard of it. Every tenant looks lapsed; none may be touched.
  const apps = [lapsed("app_a"), lapsed("app_b"), lapsed("app_c")];
  assert.deepEqual(expired({ apps, lastBeatAgo: null }), []);
});

test("SILENCE suspends enforcement: a control-plane blip is not an outage", () => {
  // the data path does not run through the manager's API, so these tenants are
  // serving fine. Silence is not evidence about any of them.
  const apps = [lapsed("app_a"), lapsed("app_b")];
  assert.deepEqual(expired({ apps, lastBeatAgo: 600, silence: 180 }), []);
  // ...and enforcement resumes the moment we hear from it again
  assert.deepEqual(expired({ apps, lastBeatAgo: 5, silence: 180 }).sort(), ["app_a", "app_b"]);
});

test("only live tenants are candidates", () => {
  const apps = ["failed", "stopped", "exited"].map((s, i) =>
    ({ id: `app_${i}`, name: `app_${i}`, status: s, leaseUntil: 0 }));
  assert.deepEqual(expired({ apps, lastBeatAgo: 5 }), []);
});

test("a tenant with no lease field at all is reapable (it predates the field)", () => {
  assert.deepEqual(expired({ apps: [{ id: "app_old", name: "0xold", status: "running" }], lastBeatAgo: 5 }),
                   ["app_old"]);
});

// ---- the supervisor half: WHICH records may vouch --------------------------

async function vouches(records, env = {}) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", VOUCH_SELFTEST: JSON.stringify({ records }),
           POOL_SELFTEST: "", INSTANCE_SELFTEST: "", INSTANCE_SWEEP_SELFTEST: "", SWEEP_SELFTEST: "",
           REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
           CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
           ...env } });
  return JSON.parse(stdout.trim().split("\n").pop());
}

test("terminal records never vouch - that is the original leak", () => {
  return vouches([
    { id: "0xrunning", status: "running", _onchain: true },
    { id: "0xterminated", status: "terminated", _onchain: true },
    { id: "0xexpired", status: "expired", _onchain: true },
    { id: "0xfailed", status: "failed", _onchain: true },
  ]).then((v) => assert.deepEqual(v, ["0xrunning"]));
});

test("an OFF-LEDGER record does not vouch on a claiming box", async () => {
  // the one shape the instance sweep also cannot catch: it sees an instance a
  // live record owns, so it leaves it alone forever. Nothing backs this tenant,
  // so it stops being vouched for and the manager reaps it.
  assert.deepEqual(await vouches([
    { id: "0xchain", status: "running", _onchain: true },
    { id: "0xlocal", status: "running", _onchain: false },
  ]), ["0xchain"]);
});

test("AUTO_PROVISION is the deliberate exception: a pilot box has no chain to appeal to", async () => {
  assert.deepEqual(await vouches([{ id: "0xlocal", status: "running", _onchain: false }],
                                 { AUTO_PROVISION: "1" }), ["0xlocal"]);
});
