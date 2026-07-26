// site/js/core/pay.js + fund.js — the EIP-712 domain is not the server's to choose.
//
// Both signing paths take their payment instructions from the relay: pay.js from
// GET /billing/orders/:id/usdc, fund.js from /pricing. That is deliberate for
// token, router, amount and orderRef - a local anvil order then pays the same
// way. But a domain is what SCOPES a signature: verifyingContract and chainId
// decide which contract, on which chain, will accept it. A relay that names some
// other contract or chain there is asking for a signature that is valid
// somewhere the user never agreed to, which is the same shape as blind-signing a
// digest the server computed.
//
// So those two fields are pinned locally - to the token actually being paid, and
// to the chain the transaction actually goes to (ensureBaseChain forces Base or
// throws). A disagreeing relay gets a refusal, not a signature.
//
//   run: node --test test/pay-domain-pinning.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_CHAIN_HEX = "0x2105", BASE_CHAIN = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const EVIL_TOKEN = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";

// the module graph reads these at import; config.js also reads `location`
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { hostname: "enclave.host", href: "https://enclave.host/", origin: "https://enclave.host" };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = (o || {}).detail; } };
globalThis.document = { dispatchEvent() {}, addEventListener() {} };
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });

const { Enclave } = await import(pathToFileURL(path.join(REPO, "site/js/core/api.js")).href);
const { payOrderWithUsdc } = await import(pathToFileURL(path.join(REPO, "site/js/core/pay.js")).href);

const SIGNED = Symbol("signed");

// A wallet that answers the reads pay.js makes on the bare-EOA path, then hands
// back whatever typed data it was asked to sign instead of signing it.
function stubWallet() {
  const seen = {};
  Enclave.address = WALLET;
  Enclave.provider = {
    request: async ({ method, params }) => {
      switch (method) {
        case "eth_chainId": return BASE_CHAIN_HEX;      // ensureBaseChain passes
        case "eth_getCode": return "0x";                // bare EOA -> permit path
        case "eth_call":    return "0x" + "0".repeat(64); // nonces() = 0
        case "eth_signTypedData_v4":
          seen.typed = JSON.parse(params[1]);
          throw Object.assign(new Error("stop before sendTx"), { [SIGNED]: true });
        default: throw new Error("unexpected rpc " + method);
      }
    },
  };
  return seen;
}

async function sign(usdcDomain) {
  const seen = stubWallet();
  const pay = { amount6: "1803600", orderRef: "0x" + "ab".repeat(32), router: ROUTER, usdc: USDC, usdcDomain };
  let err = null;
  try { await payOrderWithUsdc(pay); } catch (e) { err = e; }
  // pay.js wraps the wallet call and rethrows its own EnclaveError, so the
  // sentinel does not survive - captured typed data is the signal that the
  // prompt was reached
  return { seen, err, reachedSigning: !!seen.typed };
}

test("the domain is pinned to the token being paid, whatever the order says", async () => {
  // the relay names a DIFFERENT contract as the verifying contract: a signature
  // scoped to that contract is exactly what must not be produced
  const { seen, reachedSigning } = await sign({ name: "USD Coin", version: "2", chainId: BASE_CHAIN, verifyingContract: EVIL_TOKEN });
  assert.ok(reachedSigning, "should have reached the signing step");
  assert.equal(seen.typed.domain.verifyingContract.toLowerCase(), USDC.toLowerCase(),
    "verifyingContract must be the token being paid, not the order's claim");
  assert.equal(seen.typed.domain.chainId, BASE_CHAIN);
});

test("an order naming another chain is refused, not signed around", async () => {
  for (const chainId of [1, 137, 84532, 10]) {
    const { err, reachedSigning } = await sign({ name: "USD Coin", version: "2", chainId, verifyingContract: USDC });
    assert.ok(!reachedSigning, `chainId ${chainId} must not reach the wallet`);
    assert.match(String(err && err.message), /different chain/, `chainId ${chainId}`);
  }
});

test("a well-formed order still signs, and over the right message", async () => {
  const { seen, reachedSigning } = await sign({ name: "USD Coin", version: "2", chainId: BASE_CHAIN, verifyingContract: USDC });
  assert.ok(reachedSigning);
  assert.equal(seen.typed.primaryType, "Permit");
  assert.equal(seen.typed.domain.chainId, BASE_CHAIN);
  assert.equal(seen.typed.domain.verifyingContract.toLowerCase(), USDC.toLowerCase());
  // the spender is the router from the order, and the value the quoted amount:
  // those ARE the server's to state, and stay so
  assert.equal(seen.typed.message.spender, ROUTER);
  assert.equal(seen.typed.message.value, "1803600");
  assert.equal(seen.typed.message.owner, WALLET);
});

test("a missing domain falls back to USDC's well-known fields, still pinned", async () => {
  const { seen, reachedSigning } = await sign(undefined);
  assert.ok(reachedSigning);
  assert.equal(seen.typed.domain.name, "USD Coin");
  assert.equal(seen.typed.domain.version, "2");
  assert.equal(seen.typed.domain.chainId, BASE_CHAIN);
  assert.equal(seen.typed.domain.verifyingContract.toLowerCase(), USDC.toLowerCase());
});

// fund.js's 3009 path is the sibling that took verifyingContract wholly from
// /pricing. It reaches the wallet through the same module graph, so pin the
// guard's presence at the source level rather than re-driving the whole deploy
// flow: the check is a single expression and a drift is what this catches.
test("fund.js refuses a /pricing domain that does not match the token", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(REPO, "site/js/core/fund.js"), "utf8");
  assert.match(src, /dom\.verifyingContract \|\| pay\.usdc\)\.toLowerCase\(\) !== String\(pay\.usdc/,
    "fund.js must compare the domain's verifyingContract against the token being paid");
  assert.match(src, /Number\(dom\.chainId != null \? dom\.chainId : BASE_CHAIN\) !== BASE_CHAIN/,
    "fund.js must pin the domain chainId to BASE_CHAIN");
  assert.match(src, /nothing was signed/, "and refuse before the wallet prompt");
});
