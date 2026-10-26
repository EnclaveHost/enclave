// lease-consumer-seams (PREPARED; run only by the root job): the REAL conduit (network/lease-gas-conduit.mjs and the rebuilt
// metal/guest/lease-gas-conduit.bundle.mjs) and the REAL runtime (network/lease-gas-runtime.mjs loadLeaseGasConfig) with the
// REAL chain-authority constructor. No network: the verifier URL is never contacted by configuration loading.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { base } from "viem/chains";
import * as LG from "../network/lease-gas-conduit.mjs";
import * as BUNDLE from "../metal/guest/lease-gas-conduit.bundle.mjs";
import { loadLeaseGasConfig } from "../network/lease-gas-runtime.mjs";
import { chainAuthorityFromEnv } from "../network/chain-authority.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-seams-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
// the same reviewed public record the existing conduit test uses (test/metal-lease-gas-conduit.test.mjs)
const RECORD = Buffer.from('{"format":"enclave-lease-gas-deployment/v1","chainId":8453,"reserve":"0x12A3f873041Dec436DaA0085B766a399A6fA3639","executor":"0x8900BACA2167873BA2F8a8bAE8b4876E6396d343","reserveCodeHash":"0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979","executorCodeHash":"0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2","ledger":"0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B","registry":"0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC"}');
const DIGEST = "sha256:" + createHash("sha256").update(RECORD).digest("hex");
const RECORD_FILE = path.join(tmp, "deployment.json");
fs.writeFileSync(RECORD_FILE, RECORD);
const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], RELAYS = ["https://relay-a.example.org", "https://relay-b.example.net"];
const read = (f) => fs.readFileSync(f);
const BINDING = { chain: base, ledger: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B", registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC" };
const LEGACY = () => ({ recordFile: RECORD_FILE, digest: DIGEST, rpcs: [...RPCS], relays: [...RELAYS] });
const BOUND = () => ({ recordFile: RECORD_FILE, digest: DIGEST, relays: [...RELAYS] });
const authority = () => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:9/" }, { chain: base });

for (const [name, M] of [["source", LG], ["bundle", BUNDLE]]) {
  test(`${name}: legacy (no verifier) is unchanged: public rpcs required, transited and installed`, () => {
    const t = M.leaseGasTransit(LEGACY(), { readFile: read });
    assert.deepEqual([...t.rpcs], RPCS);
    const g = M.leaseGasGuest(JSON.parse(JSON.stringify(t)), { recordFile: path.join(tmp, `${name}-legacy.json`) });
    assert.equal(g.ok, true, g.reason);
    assert.equal(g.env.ENCLAVE_LEASE_GAS_RPCS, RPCS.join(","));
    assert.throws(() => M.leaseGasTransit(BOUND(), { readFile: read }), /rpcs/, "legacy still refuses a configuration without rpcs");
  });

  test(`${name}: verifier-bound leaseGas without public rpcs is accepted and installs NO public RPC name`, () => {
    const t = M.leaseGasTransit(BOUND(), { readFile: read, verifierBound: true });
    assert.deepEqual([...t.rpcs], []);
    assert.equal(t.quorum, null);
    const g = M.leaseGasGuest(JSON.parse(JSON.stringify(t)), { recordFile: path.join(tmp, `${name}-bound.json`), verifierBound: true });
    assert.equal(g.ok, true, g.reason);
    assert.equal("ENCLAVE_LEASE_GAS_RPCS" in g.env, false);
    assert.equal("ENCLAVE_LEASE_GAS_QUORUM" in g.env, false);
    assert.equal(g.env.ENCLAVE_LEASE_GAS_RELAYS, RELAYS.join(","), "relays (funding route) preserved");
    assert.equal(g.env.ENCLAVE_LEASE_GAS_DIGEST, DIGEST);
  });

  test(`${name}: a mixed provider + verifier configuration is refused (host, transit and guest)`, () => {
    assert.throws(() => M.leaseGasTransit(LEGACY(), { readFile: read, verifierBound: true }), /mixed/);
    assert.throws(() => M.leaseGasTransit({ ...BOUND(), quorum: 2 }, { readFile: read, verifierBound: true }), /mixed/);
    const legacyTransit = JSON.parse(JSON.stringify(M.leaseGasTransit(LEGACY(), { readFile: read })));
    assert.throws(() => M.checkTransit(legacyTransit, { verifierBound: true }), /mixed/);
    const g = M.leaseGasGuest(legacyTransit, { verifierBound: true });
    assert.equal(g.ok, false);
    assert.equal(g.env.ENCLAVE_LEASE_GAS_FILE, M.REFUSED_RECORD_FILE, "configured but unloadable: every lease operation refuses");
  });

  test(`${name}: a verifier-bound transit in a guest WITHOUT a bound verifier refuses (no silent public fallback)`, () => {
    const bound = JSON.parse(JSON.stringify(M.leaseGasTransit(BOUND(), { readFile: read, verifierBound: true })));
    const g = M.leaseGasGuest(bound, {});
    assert.equal(g.ok, false);
    assert.match(g.reason, /rpcs/);
  });
}

test("runtime: the bound guest env loads ONLY the verifier authority as its single lease client; without it, it refuses", () => {
  const t = LG.leaseGasTransit(BOUND(), { readFile: read, verifierBound: true });
  const g = LG.leaseGasGuest(JSON.parse(JSON.stringify(t)), { recordFile: RECORD_FILE, verifierBound: true });
  assert.equal(g.ok, true, g.reason);
  const a = authority();
  const cfg = loadLeaseGasConfig({ env: g.env, ...BINDING, readFile: read, chainAuthority: a });
  assert.equal(cfg.clients.length, 1);
  assert.equal(cfg.clients[0], a.client, "the lease client IS the authority's client");
  assert.equal(cfg.quorum, 1);
  assert.throws(() => loadLeaseGasConfig({ env: g.env, ...BINDING, readFile: read, chainAuthority: null }), /RPCS/,
    "without the authority, a verifier-bound env has no RPC list and refuses (never a default provider)");
});

test("runtime: legacy env with no authority keeps its public quorum (compatibility)", () => {
  const t = LG.leaseGasTransit(LEGACY(), { readFile: read });
  const g = LG.leaseGasGuest(JSON.parse(JSON.stringify(t)), { recordFile: RECORD_FILE });
  const cfg = loadLeaseGasConfig({ env: g.env, ...BINDING, readFile: read, chainAuthority: null });
  assert.equal(cfg.clients.length, RPCS.length);
});
