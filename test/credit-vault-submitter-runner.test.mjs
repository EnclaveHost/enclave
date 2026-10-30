// The credit-vault submitter as a REGISTERED host-service role, launched by the SHARED runner (network/host-services/runner.mjs)
// from its PINNED package (scripts/build-host-service-packages.mjs; bundle entry network/host-services/entries/
// credit-vault-submitter.mjs behind the argv guard) - not standalone. On anvil (test/credit-vault-fixture.mjs: the PRODUCTION
// credit-vault factory bytecode, the live rev-16d ledger, the real address book), with anvil's own eth_signTransaction as
// the operator's loopback external signer:
//   - configuration through the runner: no secret field, loopback signer only, heapMiB (the old memoryMiB is refused);
//   - the process inherits NO environment (PATH only, read from /proc), its config file is 0600 and names no secret;
//   - receipt path: a passkey-signed vault request submitted through the runner-launched role executes exactly once and is
//     reconciled from the chain;
//   - admission: a refused host STOPS the role (a request sent meanwhile is held, never lost or doubled); admitted again,
//     the role restarts and the SAME signed bytes execute once;
//   - cold: the role starts with only its loopback RPC quorum and signer (network namespace: no Enclave API, discovery,
//     storage or lease relay is reachable);
//   - the advertisement is kind 8 "credit-vault-submitter", outside the default service-index listing like policy (6).
// The DigitalOcean placement refusal reads the REAL machine's DMI here (the runner passes no environment), so this run only
// shows the role starting on a non-DigitalOcean machine; the refusal itself is tested with a fixture DMI directory in
// test/credit-vault-reserve.test.mjs, which is not evidence of behaviour on a real DigitalOcean droplet.
//   node --test test/credit-vault-submitter-runner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(REPO, "network/host-services/packages");
const ROLE = "credit-vault-submitter";
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = process.env.INJECT_FAILURE ? "negative-control run" : !haveAnvil ? "needs Foundry's anvil"
  : !fs.existsSync(path.join(PKG, `${ROLE}.package.json`)) ? "needs the built packages (scripts/build-host-service-packages.mjs)" : false;
const lc = (a) => String(a).toLowerCase();
const pin = () => "sha256:" + createHash("sha256").update(fs.readFileSync(path.join(PKG, `${ROLE}.package.json`))).digest("hex");

if (process.env.INJECT_FAILURE) test("INJECTED FAILURE (negative control: the suite must exit nonzero)", () => assert.fail("injected"));

test("the shared host-service runner launches the packaged credit-vault submitter: no secret, no env, receipts, admission, kind 8", { skip, timeout: 300000 }, async (t) => {
  const CV = await import(path.join(REPO, "site/js/core/credit-vault-independent.js"));
  const { createQuorumReader, jsonRpc } = await import(path.join(REPO, "site/js/core/quorum.js"));
  const { lib } = await import(path.join(REPO, "cli/credit-vault.mjs"));
  const F = await import(path.join(REPO, "test/credit-vault-fixture.mjs"));
  const si = await import(path.join(REPO, "network/service-index.mjs"));
  const { planHostServices, runHostServices, advertisements, loadPackage, validateHostServicesConfig } = await import(path.join(REPO, "network/host-services/runner.mjs"));
  const { ROLES } = await import(path.join(REPO, "network/host-services/roles.mjs"));
  const stops = [];
  t.after(async () => { for (const s of stops.reverse()) try { await s(); } catch {} });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "credit-runner-")); stops.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const A = await F.startChain(8453, stops);
  const S = await F.deployStack(A);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const reader = CV.withTxReads(createQuorumReader({ rpcs: A.rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 3600, chainId: 8453 }), jsonRpc());
  const opts = { reader, pins: PINS };
  // the customer's vault and a vault-owned deployment (the production bytecode, a real P-256 passkey)
  const K = F.passkey();
  await F.send(A, "admin", S.current.address, CV.ABI.factory, "createVault", [BigInt(K.x), BigInt(K.y)]);
  const vault = CV.deriveVault(lib, K.x, K.y, S.current);
  await F.send(A, "admin", S.usdc, F.CHAIN_FX.MockUSDC.abi, "mint", [vault, 40_000000n]);
  const profile = CV.makeProfile({ factory: S.current.address, vault, key: { x: K.x, y: K.y } }, { credentialId: K.credentialId }, PINS);
  const spec = { appRef: "catalog://app/0", gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: "", isPublic: true, configCid: "", maxRate6: "1000" };
  const dp = await CV.prepareVaultOp(lib, profile, "deploy", { spec, fundUsd: "10" }, opts);
  const dreq = await CV.signPrepared(lib, dp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op: "deploy", params: { spec, fundUsd: "10" } } });
  const dj = F.memJournal();
  const ds = await CV.submitRequest(lib, dreq, CV.walletTransport(F.eip1193(A), F.ACCT.payer.address), { journal: dj, reader, pins: PINS });
  const id = (await A.pub.getTransactionReceipt({ hash: ds.txHash })).logs.find((l) => lc(l.address) === lc(S.ledger)).topics[1];

  const port = await F.freePort();
  const config = { port, bind: "127.0.0.1", stateDir: path.join(tmp, "submitter-state"), rpc: A.rpcs, confirmations: 0, signer: A.url, from: F.ACCT.relay.address, chainId: 8453, pins: PINS };
  const cfg = { format: "enclave-host-services/v1", host: { endpoint: "https://host-c.credit-test.net", publicEndpoints: { [ROLE]: ["https://submit.host-c.credit-test.net/"] } },
    platformHostPolicy: "production", serviceIndex: { chainId: 8453, address: "0x00000000000000000000000000000000000005e1", codeHash: "0x" + "ab".repeat(32) },
    packagesDir: PKG, stateRoot: path.join(tmp, "state"), services: [{ role: ROLE, package: pin(), heapMiB: 128, config }] };

  await t.test("registered in ROLES, packaged behind the argv guard, configured only through the runner's validators", async () => {
    assert.ok(ROLES[ROLE]); assert.equal(ROLES[ROLE].kind, ROLE); assert.equal(ROLES[ROLE].bundleEntry, "network/host-services/entries/credit-vault-submitter.mjs");
    const p = loadPackage(PKG, ROLE, pin());
    assert.equal(p.manifest.entry, "network/credit-vault-submitter.mjs"); assert.equal(p.manifest.bundleEntry, ROLES[ROLE].bundleEntry);
    assert.ok(p.manifest.secrets.startsWith("none"));
    assert.ok(Object.keys(p.manifest.inputs).includes("network/host-services/argv-guard.mjs"));
    for (const f of Object.keys(p.manifest.inputs)) assert.doesNotMatch(f, /(^|\/)(custody|lease-relay-service|lease-gas-runtime|sdk\/storage|relay\/billing|vaultsvc)/, f);
    const svc = (c, extra = {}) => ({ ...cfg, services: [{ role: ROLE, package: pin(), heapMiB: 128, config: c, ...extra }] });
    assert.throws(() => validateHostServicesConfig(svc({ ...config, privateKey: "0x01" })), /holds no secret/);
    assert.throws(() => validateHostServicesConfig(svc({ ...config, signer: "https://wallet.example.com" })), /loopback JSON-RPC wallet/);
    assert.throws(() => validateHostServicesConfig(svc({ ...config, signer: "http://user:pw@127.0.0.1:8545" })), /loopback JSON-RPC wallet/);
    assert.throws(() => validateHostServicesConfig(svc(config, { heapMiB: undefined, memoryMiB: 128 })), /memoryMiB is now heapMiB/);
    assert.throws(() => validateHostServicesConfig(svc(config, { heapMiB: 32 })), /heapMiB: 64 to 2048/);
    const plan = planHostServices(cfg);
    assert.deepEqual(plan.services[0].launch.env, {}, "the role's process gets no environment names of its own");
    assert.equal(plan.services[0].kind, ROLE);
  });

  let running; const logs = [];
  const gate = { refusal: null };
  const gateOf = { check: async () => {}, start() {}, stop() {}, serviceRefusal: () => gate.refusal, status: () => ({ platformHostPolicy: "test", refusal: gate.refusal }) };
  const url = `http://127.0.0.1:${port}`;
  const healthy = () => fetch(url + "/health", { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  const wait = async (f, ms, what) => { const end = Date.now() + ms; for (;;) { if (await f()) return; if (Date.now() > end) throw new Error(`timed out: ${what}\n${logs.slice(-20).join("\n")}`); await F.sleep(200); } };

  await t.test("cold start: the runner launches the packaged role with no inherited environment and a 0600 secret-free config", async () => {
    running = await runHostServices(cfg, { gate: gateOf, log: (m) => logs.push(m), intervalMs: 200, backoffMs: 200 });
    stops.push(() => running.stop());
    await wait(healthy, 30000, "the role's /health");
    const st = running.status().services[0];
    assert.equal(st.running, true); assert.equal(st.kind, ROLE);
    assert.ok(logs.some((l) => l.startsWith(`[${ROLE}] {"submitter":"http://127.0.0.1:${port}"}`)), logs.join("\n"));
    assert.ok(logs.some((l) => /V8 heap cap 128 MiB/.test(l)));
    // /proc: the process environment is exactly the runner's PATH; argv carries the heap cap, the pinned bundle and its config
    const env = fs.readFileSync(`/proc/${st.pid}/environ`, "utf8").split("\0").filter(Boolean);
    assert.deepEqual(env.map((e) => e.split("=")[0]), ["PATH"]);
    const argv = fs.readFileSync(`/proc/${st.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    assert.equal(argv[1], "--max-old-space-size=128"); assert.equal(argv[2], path.join(PKG, `${ROLE}.mjs`));
    const cfgFile = argv[3];
    assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
    const written = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    assert.ok(!Object.keys(written).some((k) => /(secret|token|password|private|mnemonic|seed|key$)/i.test(k)), Object.keys(written).join(","));
    assert.equal(written.signer, A.url); assert.equal(lc(written.from), lc(F.ACCT.relay.address));
    const h = await (await fetch(url + "/health")).json();
    assert.equal(lc(h.payer), lc(F.ACCT.relay.address)); assert.equal(h.reserve, null, "no reviewed reserve record: reserve requests are off");
  });

  await t.test("receipt path: a passkey-signed request through the runner-launched role executes once, gas paid by the operator's signer", async () => {
    const bal = await F.usdcOf(A, S, vault), eth0 = await A.pub.getBalance({ address: F.ACCT.relay.address });
    const fp = await CV.prepareVaultOp(lib, profile, "fund", { id, amountUsd: "2" }, opts);
    const req = await CV.signPrepared(lib, fp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op: "fund", params: { id, amountUsd: "2" } } });
    const j = F.memJournal();
    const s = await CV.submitRequest(lib, req, CV.relayTransport(url), { journal: j, pins: PINS });
    assert.equal(s.status, "broadcast");
    const r = await CV.reconcile(lib, await j.get(vault), { reader, journal: j });
    assert.equal(r.status, "executed"); assert.equal(r.txHash, s.txHash);
    assert.equal((await A.pub.getTransactionReceipt({ hash: s.txHash })).status, "success");
    assert.equal(await F.usdcOf(A, S, vault), bal - 2_000000n);
    assert.ok((await A.pub.getBalance({ address: F.ACCT.relay.address })) < eth0, "the operator's signer paid the gas");
    // a non-vault target is refused by the role before any gas is spent
    const bad = { ...req, to: S.ledger, vault: S.ledger };
    const rr = await fetch(url + "/v1/credit-vault/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    assert.equal(rr.status >= 400, true);
  });

  await t.test("admission: a refused host stops the role and a request sent meanwhile is held; admitted again, the same bytes execute once", async () => {
    gate.refusal = "platform host policy: banned by platform policy #9 (host)";
    await wait(async () => !running.status().services[0].running && !(await healthy()), 15000, "the role stopped on refusal");
    assert.equal(running.status().refusal, gate.refusal);
    assert.ok(logs.some((l) => /STOPPING every role: platform host policy: banned/.test(l)));
    const bal = await F.usdcOf(A, S, vault);
    const fp = await CV.prepareVaultOp(lib, profile, "fund", { id, amountUsd: "1" }, opts);
    const req = await CV.signPrepared(lib, fp, profile, { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op: "fund", params: { id, amountUsd: "1" } } });
    const j = F.memJournal();
    assert.equal((await CV.submitRequest(lib, req, CV.relayTransport(url, { timeoutMs: 2000 }), { journal: j, pins: PINS })).status, "unknown");
    assert.equal((await CV.reconcile(lib, await j.get(vault), { reader, journal: j })).status, "pending");
    assert.equal(await F.usdcOf(A, S, vault), bal, "nothing moved while the host was refused");
    gate.refusal = null;
    await wait(healthy, 30000, "the role restarted after admission");
    assert.ok(logs.some((l) => /admitted again: starting roles/.test(l)));
    assert.equal((await CV.submitRequest(lib, req, CV.relayTransport(url), { journal: j, pins: PINS })).status, "broadcast");
    assert.equal((await CV.reconcile(lib, await j.get(vault), { reader, journal: j })).status, "executed");
    assert.equal(await F.usdcOf(A, S, vault), bal - 1_000000n, "exactly once");
  });

  await t.test("advertisement: kind 8 credit-vault-submitter, prepared unsigned by the runner; outside the default listing", async () => {
    assert.equal(si.SERVICE_KINDS[ROLE], 8); assert.equal(si.KIND_NAMES[8], ROLE);
    assert.equal(si.SERVICE_KINDS.policy, 6); assert.equal(si.SERVICE_KINDS.relay, 7);
    const ads = await advertisements(cfg, { operator: F.ACCT.relay.address, slot: 0, sequence: 1 });
    assert.equal(ads.length, 1); assert.equal(ads[0].kind, ROLE); assert.equal(ads[0].signed, false);
    assert.equal(ads[0].typedData.message.kind, 8);
    const d = JSON.parse(ads[0].descriptor);
    assert.equal(d.kind, ROLE); assert.equal(d.role, ROLE); assert.equal(d.package, pin());
    // a reader that names no kinds lists the defaults only (directory, checker, storage, dns, replica, relay)
    assert.ok(/'policy' && k !== 'credit-vault-submitter'/.test(fs.readFileSync(path.join(REPO, "network/service-index.mjs"), "utf8")));
  });
});
