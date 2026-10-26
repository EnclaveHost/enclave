// The relay's chain-authority SELECTION (no chain needed): exactly one of the provider quorum (LEASE_RELAY_RPCS +
// LEASE_RELAY_QUORUM) or the operator's local verifier (ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER +
// ENCLAVE_CHAIN_TX_BACKEND); mixed, incomplete, unknown or non-local selections are refused - by the service before it
// reads its key or contacts anything, by the unit's dependency-free ExecStartPre check, and by the hosted relay role's
// configuration. Nothing falls back to the other authority. Fixture keys and records only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { relayChainMode, startRelayService } from "../network/lease-relay-service.mjs";
import { checkRelayConfig } from "../network/lease-relay-check.mjs";
import { validateHostRelayConfig } from "../network/host-services/lease-relay-host.mjs";

let dir, rec, digest, keyFile, stateFile;
const addr = () => "0x" + crypto.randomBytes(20).toString("hex");
const hash = () => "0x" + crypto.randomBytes(32).toString("hex");
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-verifier-config-"));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: addr(), executor: addr(), ledger: addr(), registry: addr(),
    reserveCodeHash: hash(), executorCodeHash: hash() }));
  rec = path.join(dir, "deployment.json"); fs.writeFileSync(rec, bytes);
  digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  keyFile = path.join(dir, "relay.key"); fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  stateFile = path.join(dir, "relay-send.json");
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const V = { ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:28590/", ENCLAVE_CHAIN_TX_BACKEND: "http://127.0.0.1:28545/" };
const RPCS = ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"];

test("relayChainMode: exactly one authority; mixed, incomplete and unknown selections refuse (no fallback)", () => {
  assert.equal(relayChainMode({ chainEnv: V }), "verifier");
  assert.equal(relayChainMode({ chainEnv: {}, rpcs: RPCS, quorum: 2 }), "quorum");
  assert.equal(relayChainMode({ chainEnv: { ENCLAVE_CHAIN_AUTHORITY: "quorum" }, rpcs: RPCS }), "quorum");
  assert.equal(relayChainMode({ rpcs: RPCS }), "quorum", "the legacy call shape (no chainEnv) is unchanged");
  assert.throws(() => relayChainMode({ chainEnv: V, rpcs: RPCS }), /must not be set with it/);
  assert.throws(() => relayChainMode({ chainEnv: V, quorum: 2 }), /must not be set with it/);
  assert.throws(() => relayChainMode({ chainEnv: { ...V, ENCLAVE_CHAIN_TX_BACKEND: "" } }), /needs ENCLAVE_CHAIN_TX_BACKEND/);
  assert.throws(() => relayChainMode({ chainEnv: { ...V, ENCLAVE_CHAIN_VERIFIER: " " } }), /needs ENCLAVE_CHAIN_VERIFIER/);
  assert.throws(() => relayChainMode({ chainEnv: { ENCLAVE_CHAIN_VERIFIER: V.ENCLAVE_CHAIN_VERIFIER }, rpcs: RPCS }), /ENCLAVE_CHAIN_VERIFIER is set but/);
  assert.throws(() => relayChainMode({ chainEnv: { ENCLAVE_CHAIN_AUTHORITY: "quorum", ENCLAVE_CHAIN_TX_BACKEND: V.ENCLAVE_CHAIN_TX_BACKEND }, rpcs: RPCS }), /ENCLAVE_CHAIN_TX_BACKEND is set but/);
  assert.throws(() => relayChainMode({ chainEnv: { ENCLAVE_CHAIN_AUTHORITY: "Verifier" }, rpcs: RPCS }), /must be quorum or verifier/);
  assert.throws(() => relayChainMode({ chainEnv: {} }), /needs its chain access/);
});

test("startRelayService refuses a mixed or non-local selection before reading its record or key or contacting anything", async () => {
  let reads = 0;
  const readFile = (f) => { reads++; return fs.readFileSync(f); };
  const fetchSpy = async () => { throw new Error("no network may be contacted"); };
  const base = { recordFile: rec, digest, keyFile: path.join(dir, "absent.key"), maxFloatEth: "0.02", stateFile, readFile, log: () => {}, authorityOptions: { fetch: fetchSpy } };
  await assert.rejects(startRelayService({ ...base, chainEnv: V, rpcs: RPCS, quorum: 2 }), /must not be set with it/);
  await assert.rejects(startRelayService({ ...base, chainEnv: V, quorum: 1 }), /must not be set with it/);
  await assert.rejects(startRelayService({ ...base, chainEnv: { ...V, ENCLAVE_CHAIN_TX_BACKEND: undefined } }), /needs ENCLAVE_CHAIN_TX_BACKEND/);
  assert.equal(reads, 0, "refused before the record was read");
  // past the record (chain known), still before the key: the verifier must be local, the backend the operator's own literal
  await assert.rejects(startRelayService({ ...base, chainEnv: { ...V, ENCLAVE_CHAIN_VERIFIER: "https://verifier.example/" } }), /must be a local endpoint/);
  await assert.rejects(startRelayService({ ...base, chainEnv: { ...V, ENCLAVE_CHAIN_TX_BACKEND: "https://mainnet.base.org/" } }), /loopback or private IPv4 address literal/);
  await assert.rejects(startRelayService({ ...base, chainEnv: { ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://8.8.8.8:8545/" } }), /public address is not the operator's own backend/);
  await assert.rejects(startRelayService({ ...base, chainEnv: { ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://user:pw@127.0.0.1:8545/" } }), /no credentials/);
});

test("startRelayService under the verifier reads its balance through the verifier only: an unreachable verifier refuses the start (never a provider)", async () => {
  const seen = [];
  const fetchSpy = async (url) => { seen.push(String(url)); throw new Error("connection refused"); };
  await assert.rejects(startRelayService({ recordFile: rec, digest, keyFile, maxFloatEth: "0.02", stateFile, log: () => {}, chainEnv: V, authorityOptions: { fetch: fetchSpy } }),
    /quorum cannot read the configured chain/);
  assert.ok(seen.length > 0 && seen.every((u) => u === V.ENCLAVE_CHAIN_VERIFIER), `only the verifier was asked: ${seen.join(", ")}`);
});

const env = (o = {}) => ({ LEASE_RELAY_RECORD: rec, LEASE_RELAY_DIGEST: digest, LEASE_RELAY_MAX_FLOAT_ETH: "0.02", LEASE_RELAY_MIN_FLOAT_ETH: "0.001",
  LEASE_RELAY_LISTEN: "127.0.0.1:8549", LEASE_RELAY_KEY_FILE: keyFile, LEASE_RELAY_STATE: stateFile, LEASE_RELAY_ARTIFACT_SHA256: "0".repeat(64), ...o });

test("the unit's ExecStartPre check: the verifier selection is accepted alone and refused mixed, incomplete or non-local", () => {
  const ok = checkRelayConfig(env(V));
  assert.deepEqual(ok.problems, []);
  assert.match(ok.summary, /local verifier 127\.0\.0\.1:28590, own backend 127\.0\.0\.1:28545/);
  assert.ok(checkRelayConfig(env({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://10.0.2.2:8545/" })).ok, "the guest's host link is a private literal");
  assert.ok(checkRelayConfig(env({ ...V, ENCLAVE_CHAIN_VERIFIER: "http://[::1]:28590/" })).ok);
  const bad = (o, re) => { const r = checkRelayConfig(env(o)); assert.equal(r.ok, false, JSON.stringify(o)); assert.ok(r.problems.some((p) => re.test(p)), r.problems.join("; ")); };
  bad({ ...V, LEASE_RELAY_RPCS: RPCS.join(",") }, /LEASE_RELAY_RPCS is set with ENCLAVE_CHAIN_AUTHORITY=verifier/);
  bad({ ...V, LEASE_RELAY_QUORUM: "2" }, /LEASE_RELAY_QUORUM is set with ENCLAVE_CHAIN_AUTHORITY=verifier/);
  bad({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "" }, /ENCLAVE_CHAIN_TX_BACKEND is not set/);
  bad({ ...V, ENCLAVE_CHAIN_VERIFIER: "" }, /ENCLAVE_CHAIN_VERIFIER is not set/);
  bad({ ...V, ENCLAVE_CHAIN_VERIFIER: "http://10.0.2.2:28590/" }, /ENCLAVE_CHAIN_VERIFIER must be 127\.0\.0\.1/);
  bad({ ...V, ENCLAVE_CHAIN_VERIFIER: "https://verifier.example/" }, /ENCLAVE_CHAIN_VERIFIER must be a loopback/);
  bad({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://node.example:8545/" }, /ENCLAVE_CHAIN_TX_BACKEND must be a loopback or private/);
  bad({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://8.8.8.8:8545/" }, /public address/);
  bad({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "http://127.0.0.1:8545/?key=x" }, /no credentials, query or fragment/);
  bad({ ...V, ENCLAVE_CHAIN_TX_BACKEND: "ftp://127.0.0.1/" }, /must be http\(s\)/);
  bad({ ENCLAVE_CHAIN_AUTHORITY: "local", LEASE_RELAY_RPCS: RPCS.join(","), LEASE_RELAY_QUORUM: "2" }, /must be quorum or verifier/);
  bad({ ENCLAVE_CHAIN_VERIFIER: V.ENCLAVE_CHAIN_VERIFIER, LEASE_RELAY_RPCS: RPCS.join(","), LEASE_RELAY_QUORUM: "2" }, /ENCLAVE_CHAIN_VERIFIER is set but ENCLAVE_CHAIN_AUTHORITY is not verifier/);
  bad({}, /LEASE_RELAY_RPCS is not set/);                                  // nothing selected: the legacy requirements, as before
  // the legacy provider quorum is unchanged (explicitly or implicitly selected)
  for (const o of [{}, { ENCLAVE_CHAIN_AUTHORITY: "quorum" }]) {
    const r = checkRelayConfig(env({ ...o, LEASE_RELAY_RPCS: RPCS.join(","), LEASE_RELAY_QUORUM: "2" }));
    assert.deepEqual(r.problems, []); assert.match(r.summary, /3 RPCs \(quorum 2\)/);
  }
});

const hostCfg = (relay) => ({ format: "enclave-host-relay/v1", host: { endpoint: "https://api.example/t/h1" }, platformHostPolicy: "off", packagesDir: "/srv/p", stateRoot: "/srv/s",
  relay: { package: "sha256:" + "1".repeat(64), port: 8549, bind: "127.0.0.1", record: "/srv/r.json", digest: "sha256:" + "2".repeat(64), maxFloatEth: "0.02", minFloatEth: "0.001", ...relay } });

test("the hosted relay role: relay.chainVerifier + relay.txBackend is its own authority, never mixed with relay.rpc/quorum", () => {
  const c = validateHostRelayConfig(hostCfg({ chainVerifier: "http://127.0.0.1:28590/", txBackend: "http://10.0.2.2:28545/" }));
  assert.equal(c.relay.chainVerifier, "http://127.0.0.1:28590/");
  assert.ok(validateHostRelayConfig(hostCfg({ rpc: RPCS, quorum: 2 })), "the provider quorum is unchanged");
  assert.throws(() => validateHostRelayConfig(hostCfg({ chainVerifier: "http://127.0.0.1:28590/", txBackend: "http://127.0.0.1:28545/", rpc: RPCS, quorum: 2 })), /never both/);
  assert.throws(() => validateHostRelayConfig(hostCfg({ chainVerifier: "http://127.0.0.1:28590/", txBackend: "http://127.0.0.1:28545/", quorum: 2 })), /never both/);
  assert.throws(() => validateHostRelayConfig(hostCfg({ chainVerifier: "http://127.0.0.1:28590/" })), /relay\.txBackend must be a URL/);
  assert.throws(() => validateHostRelayConfig(hostCfg({ txBackend: "http://127.0.0.1:28545/" })), /relay\.chainVerifier/);
  assert.throws(() => validateHostRelayConfig(hostCfg({ chainVerifier: "https://verifier.example/", txBackend: "http://127.0.0.1:28545/" })), /local verifier/);
  assert.throws(() => validateHostRelayConfig(hostCfg({ chainVerifier: "http://127.0.0.1:28590/", txBackend: "https://node.example/" })), /loopback or private IPv4/);
  assert.throws(() => validateHostRelayConfig(hostCfg({})), /relay\.rpc: 2 to 8/);
});
