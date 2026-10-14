// `enclave custody` (cli/custody.mjs): the explicit migration path for existing relay-held secrets, run as the real CLI
// against a real chain (anvil, chain id 8453 so the CLI's Base signing applies) and a stand-in relay. After `migrate`:
// the vault holds the bundle, the relay's copy is cleared ONLY once the relay reports the deployment custody-held, and an
// attested recipient (simulated attestation, test/helpers/custody-rig.mjs) gets exactly the env the relay held.
//   run: node --test test/custody-cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_MIN_TCB, rulesFromPrediction } from "../cli/custody.mjs";
import { TCB_FLOORS } from "../verifier/metal-box.mjs";
import { custodyRig, anvilAvailable, snpAttester, RUNTIME, MEASUREMENT, FLOOR } from "./helpers/custody-rig.mjs";
import { obtainSecrets } from "../custody/recipient.mjs";
import * as P from "../custody/protocol.mjs";
import { runtimeId } from "../isolation/contract/runtime.mjs";

const pexec = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "enclave.mjs");

test("the CLI's default TCB floors are the verifier's", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_MIN_TCB)), JSON.parse(JSON.stringify(TCB_FLOORS)));
});

test("rules from the relay's prediction admit only the releases the relay itself admits", () => {
  const r = rulesFromPrediction({ appId: "ab".repeat(32), images: [
    { release: "x", runtimeId: "cd".repeat(32), measurement: "77".repeat(48), releaseAdmitted: true },
    { release: "y", runtimeId: "ef".repeat(32), measurement: "66".repeat(48), releaseAdmitted: false }] });
  assert.deepEqual(r.images, [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }]);
  assert.throws(() => rulesFromPrediction({ appId: "ab".repeat(32), images: [{ releaseAdmitted: false }] }), /admits no image/);
});

const SKIP = anvilAvailable() ? false : "anvil (Foundry) is not installed";
test("migrate: relay copy -> vault bundle -> attested recipient, and the relay copy is cleared only when the relay is custody-aware", { skip: SKIP }, async () => {
  const R = await custodyRig({ n: 5, t: 3, chainId: 8453 });
  const ENV = { DB_PASSWORD: "synthetic-migrated-pass", API_KEY: "synthetic-migrated-key" };
  const relay = { held: { ...ENV }, rev: 4, custodyAware: false, cleared: 0 };
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      res.setHeader("content-type", "application/json");
      if (/^\/v1\/secrets\/0x[0-9a-f]{64}\/get$/.test(req.url)) return res.end(JSON.stringify({ rev: relay.rev, names: Object.keys(relay.held), env: relay.held }));
      if (req.url.startsWith("/v1/expected-guest?")) return res.end(JSON.stringify({ appId: "ef".repeat(32), images: [{ release: "r1", runtimeId: "cd".repeat(32), measurement: "66".repeat(48), releaseAdmitted: true }] }));
      if (req.url === "/v1/secrets/exists") return res.end(JSON.stringify({ id: body.id, exists: true, ...(relay.custodyAware ? { custody: true } : {}) }));
      if (/^\/v1\/secrets\/0x[0-9a-f]{64}$/.test(req.url) && body.payload === '{"clear":true}') { relay.cleared++; relay.held = {}; return res.end(JSON.stringify({ rev: 5, names: [] })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-custody-cli-"));
  try {
    const owner = await R.account(), host = await R.account();
    const EP = "https://api.enclave.host/t/host-a";
    await R.registerHost(EP, host.address);
    const id = "0x" + randomBytes(32).toString("hex");
    // the owner's key, as the CLI holds it
    const ownerPk = "0x" + randomBytes(32).toString("hex");
    const { privateKeyToAccount } = await import("viem/accounts");
    const ownerAcct = privateKeyToAccount(ownerPk);
    await R.pub.request({ method: "anvil_setBalance", params: [ownerAcct.address, "0x56bc75e2d63100000"] });
    await R.setDeployment(id, { owner: ownerAcct.address, endpoint: EP, operator: host.address });
    const rules = { v: 1, appId: createHash("sha256").update("the migrated app").digest("hex"),
                    images: [{ platform: "sev-snp", measurement: MEASUREMENT, runtimeId: runtimeId(RUNTIME).toString("hex") }], minTcb: FLOOR, vmpl: 0 };
    const rulesFile = path.join(conf, "rules.json");
    fs.writeFileSync(rulesFile, JSON.stringify(rules));
    const config = { db: { password: "$DB_PASSWORD" }, key: "${API_KEY}" };
    const configFile = path.join(conf, "app-config.json");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));   // pretty-printed on disk: the CLI commits the delivered form
    const cli = (args) => pexec(process.execPath, [CLI, ...args], { env: { ...process.env, ENCLAVE_KEY: ownerPk, ENCLAVE_RPC: R.anvil.url,
      ENCLAVE_SECRET_VAULT: R.vault, ENCLAVE_ADDRESS_BOOK: "", ENCLAVE_API_BASE: `http://127.0.0.1:${server.address().port}`, XDG_CONFIG_HOME: conf } });

    // 1. a relay that is not custody-aware yet: the vault gets the bundle, the relay keeps its copy
    const a = await cli(["custody", "migrate", id, "--rules", rulesFile, "--committee", R.committeeId, "--config-file", configFile]);
    assert.match(a.stdout, /migrating 2 secret/);
    assert.match(a.stdout, /NOT cleared/);
    assert.equal(relay.cleared, 0);
    // 2. the relay reports custody: a second migrate writes revision 2 and clears the relay's copy
    relay.custodyAware = true;
    const b = await cli(["custody", "migrate", id, "--committee", R.committeeId, "--config-file", configFile]);
    assert.match(b.stdout, /deleted/);
    assert.match(b.stdout, /ROTATE/);
    assert.equal(relay.cleared, 1);
    // 3. the attested app gets exactly what the relay held, from the custodians, with the owner offline
    const st = await R.reader().readState({ id });
    assert.equal(st.policy.secretRev, 2n);
    const out = await obtainSecrets({ chainId: R.chainId, vault: R.vault, id, endpoint: EP, state: st, post: R.post, configText: JSON.stringify(config),
      attester: snpAttester(R.S, { appId: Buffer.from(rules.appId, "hex"), hostData: P.id32(id) }),
      authorize: async ({ messageFor }) => { const expiry = Math.floor(Date.now() / 1000) + 300; return { sig: await host.signMessage({ message: messageFor(expiry) }), expiry }; } });
    assert.deepEqual(out.env, ENV);
    // 4. status reads it back; pause and resume are policy revisions
    const s = await cli(["custody", "status", id, "--json"]);
    const j = JSON.parse(s.stdout);
    assert.equal(j.secretRev, "2"); assert.equal(j.threshold, 3); assert.equal(j.custodians.length, 5); assert.deepEqual(j.rules, rules);
    // without --config-file, a deployment whose config is not inline in its envelope is refused (the owner must name it)
    await assert.rejects(cli(["custody", "set", id, "X=1"]), (e) => /catalog version|--config-file/.test(e.stderr));
    // and --rules-from-relay never admits the relay's prediction without --admit
    await assert.rejects(cli(["custody", "set", id, "X=1", "--no-config", "--rules-from-relay"]),
      (e) => /not admitted: re-run with --admit/.test(e.stderr) && e.stdout.includes("66".repeat(48)));   // shown, not admitted
    assert.equal((await R.reader().readState({ id })).policy.secretRev, 2n, "nothing was written");
    await cli(["custody", "pause", id]);
    assert.equal((await R.reader().readState({ id })).policy.paused, true);
    await cli(["custody", "resume", id]);
    assert.equal((await R.reader().readState({ id })).policy.paused, false);
    // 5. no plaintext value in anything the CLI printed
    for (const v of Object.values(ENV)) for (const o of [a, b, s]) assert.ok(!o.stdout.includes(v) && !o.stderr.includes(v));
  } finally { server.close(); await R.stop(); fs.rmSync(conf, { recursive: true, force: true }); }
});
