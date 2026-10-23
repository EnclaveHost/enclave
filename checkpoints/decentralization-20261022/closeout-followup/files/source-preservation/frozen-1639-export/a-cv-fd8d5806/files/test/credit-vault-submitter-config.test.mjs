// The credit-vault submitter role's configuration intake, offline: the legacy provider quorum (unchanged, labelled as
// provider agreement), the opt-in local verifier (no public provider list; the rpc list is only the transaction transport),
// the inline receipt source (worker E's adapters through network/receipt-source.mjs) whose test-fixture identities are
// refused outside a test harness - and therefore always through the host-service runner, which passes no environment.
// The real-chain counterpart is test/credit-vault-submitter-verifier.e2e.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { validateSubmitterConfig, CREDIT_VAULT_SUBMITTER_ROLE } from "../network/host-services/credit-vault-submitter.mjs";
import { relayAuthority, parseArgs } from "../cli/credit-vault.mjs";
import { validateHostServicesConfig } from "../network/host-services/runner.mjs";
import { FIXTURE_ENV } from "../network/receipt-source.mjs";

const base = { port: 8788, bind: "127.0.0.1", stateDir: "/var/lib/enclave/cvs", signer: "http://127.0.0.1:8550", from: "0x" + "11".repeat(20), chainId: 8453 };
const legacy = { ...base, rpc: ["https://a.example", "https://b.example"] };
const verifier = { ...base, chainVerifier: "http://127.0.0.1:8545/", rpc: ["http://127.0.0.1:9545"] };
const source = { format: "enclave-receipt-source/v1", l1: { execution: { url: "http://127.0.0.1:18645" }, consensus: { url: "http://127.0.0.1:15052" } },
  base: { execution: { url: "http://127.0.0.1:8547" }, rollup: { url: "http://127.0.0.1:9545" } } };
const fixture = { ...source, testFixture: { label: "TEST FIXTURE x", l1Identity: { chainIdHex: "0x1", elGenesisHash: "0x" + "01".repeat(32), clGenesisValidatorsRoot: "0x" + "02".repeat(32) },
  l2Identity: { chainIdHex: "0x2105", genesisHash: "0x" + "03".repeat(32) } } };

test("legacy provider quorum: accepted as before (2 to 8 distinct providers, quorum), and labelled as agreement, not proof", () => {
  const c = validateSubmitterConfig(legacy, { env: {} });
  assert.equal(c.quorum, 2); assert.equal(c.chainVerifier, undefined); assert.equal(c.outcomeTimeoutSec, 180);
  assert.deepEqual(validateSubmitterConfig(c, { env: {} }), c, "the normalized config the runner writes validates again unchanged");
  assert.throws(() => validateSubmitterConfig({ ...legacy, rpc: ["https://a.example"] }, { env: {} }), /2 to 8 Base RPC URLs .* or set chainVerifier/);
  assert.throws(() => validateSubmitterConfig({ ...legacy, receiptSource: source }, { env: {} }), /receiptSource needs chainVerifier/);
  const a = relayAuthority(parseArgs(["--rpc", legacy.rpc.join(","), "--quorum", "2", "--confirmations", "2"]));
  assert.equal(a.mode, "provider-quorum"); assert.match(a.state, /2 of 2 RPC providers agreeing .*\(agreement between providers, not proof\)/);
  assert.match(a.receipts, /agreement \(not proof\)/);
});

test("chainVerifier: no public provider list; the rpc list is only the transaction transport (1 to 8); local verifier only", () => {
  const c = validateSubmitterConfig(verifier, { env: {} });
  assert.equal(c.chainVerifier, "http://127.0.0.1:8545/"); assert.equal(c.quorum, undefined); assert.deepEqual(c.rpc, ["http://127.0.0.1:9545"]);
  assert.deepEqual(validateSubmitterConfig(c, { env: {} }), c);
  assert.throws(() => validateSubmitterConfig({ ...verifier, chainVerifier: "https://verifier.example.org/" }, { env: {} }), /local endpoint|loopback|local/);
  assert.throws(() => validateSubmitterConfig({ ...verifier, rpc: [] }, { env: {} }), /1 to 8 transaction-transport endpoints/);
  assert.throws(() => validateSubmitterConfig({ ...verifier, quorum: 2 }, { env: {} }), /quorum applies to the provider-quorum mode/);
  assert.throws(() => validateSubmitterConfig({ ...verifier, outcomeTimeoutSec: 5 }, { env: {} }), /outcomeTimeoutSec: 10 to 600/);
  const a = relayAuthority(parseArgs(["--rpc", verifier.rpc[0], "--chain-verifier", verifier.chainVerifier, "--confirmations", "1"]));
  assert.equal(a.mode, "local-verifier"); assert.match(a.state, /local proof-backed verifier http:\/\/127\.0\.0\.1:8545\//);
  assert.match(a.transactions, /explicit transaction transport: 1 endpoint\(s\), never a state authority/);
  assert.match(a.receipts, /transport-reported and UNVERIFIED/);
});

test("receiptSource: the inline config is checked by the same glue; test-fixture identities only inside a test harness", () => {
  const c = validateSubmitterConfig({ ...verifier, receiptSource: source }, { env: {} });
  assert.deepEqual(c.receiptSource, source, "the operator's own object is kept verbatim (and written to the role's 0600 config)");
  assert.throws(() => validateSubmitterConfig({ ...verifier, receiptSource: { ...source, l1: { ...source.l1, execution: { url: "https://eth.example.org" } } } }, { env: {} }),
    /receiptSource: .*not-local|receiptSource: .*loopback/, "E's adapters refuse a remote node at the runner's intake");
  assert.throws(() => validateSubmitterConfig({ ...verifier, receiptSource: { ...source, base: { ...source.base, rollup: { url: "https://base.example.org" } } } }, { env: {} }), /receiptSource: /);
  assert.throws(() => validateSubmitterConfig({ ...verifier, receiptSource: { ...source, extra: 1 } }, { env: {} }), /unknown key config\.extra/);
  assert.throws(() => validateSubmitterConfig({ ...verifier, receiptSource: fixture }, { env: {} }), /refused outside a test harness/);
  assert.ok(validateSubmitterConfig({ ...verifier, receiptSource: fixture }, { env: { [FIXTURE_ENV]: "1" } }).receiptSource.testFixture);
  assert.equal(CREDIT_VAULT_SUBMITTER_ROLE.validate, validateSubmitterConfig);
  assert.deepEqual(CREDIT_VAULT_SUBMITTER_ROLE.launch({ x: 1 }).env, {}, "the runner launches the role with no environment of its own");
});

test("through the host-service runner's validator: the verifier config needs no provider list; a fixture source is refused (the runner process has no harness switch)", () => {
  assert.equal(process.env[FIXTURE_ENV], undefined, "this suite runs without the harness switch");
  const cfg = (config) => ({ format: "enclave-host-services/v1", host: { endpoint: "https://host.example.net" }, platformHostPolicy: "production",
    packagesDir: "/opt/enclave/packages", stateRoot: "/var/lib/enclave/hs", services: [{ role: "credit-vault-submitter", package: "sha256:" + "a".repeat(64), heapMiB: 128, config }] });
  const ok = validateHostServicesConfig(cfg({ ...verifier, receiptSource: source }));
  assert.equal(ok.services[0].config.chainVerifier, verifier.chainVerifier); assert.deepEqual(ok.services[0].config.receiptSource, source);
  assert.equal(ok.platformHostPolicy, "production", "the platform host policy gate still governs the role");
  assert.throws(() => validateHostServicesConfig(cfg({ ...verifier, receiptSource: fixture })), /refused outside a test harness/);
  assert.throws(() => validateHostServicesConfig(cfg({ ...verifier, privateKey: "0x01" })), /holds no secret/);
});
