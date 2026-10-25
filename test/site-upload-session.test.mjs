import test from "node:test";
import assert from "node:assert/strict";
import { requestUploadToken } from "../site/js/core/upload-token.js";

const owner = "0x" + "12".repeat(20);
const common = { url: "https://api.enclave.host/v1/apps/upload-token", hash: "ab".repeat(32), expiry: 1792960000, owner };
const unexpectedWallet = () => { throw Error("wallet must not be called"); };
test("session upload signs exact request body and scope without wallet signing", async () => {
  let signed;
  const result = await requestUploadToken({ ...common, sessionPresent: true,
    signMessage: unexpectedWallet,
    authorize: async (...args) => { signed = args; return "EnclaveSession test"; },
    fetchImpl: async (url, request) => {
      assert.deepEqual(signed, ["POST", url, request.body, "api.upload"]);
      assert.equal(request.headers.authorization, "EnclaveSession test");
      assert.deepEqual(JSON.parse(request.body), { hash: common.hash, expiry: common.expiry });
      return { ok: true, json: async () => ({ token: "test-token", address: owner }) };
    } });
  assert.equal(result.expiry, common.expiry);
});
test("missing scope or expired session never falls back to wallet or fetch", async () => {
  await assert.rejects(requestUploadToken({ ...common, sessionPresent: true,
    authorize: async () => null, signMessage: unexpectedWallet,
    fetchImpl: () => { throw Error("must not fetch"); } }), /cannot authorize uploads/);
});
test("relay refusal never falls back to wallet", async () => {
  await assert.rejects(requestUploadToken({ ...common, sessionPresent: true,
    authorize: async () => "EnclaveSession test", signMessage: unexpectedWallet,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "not_allowed" }) }) }), /not_allowed/);
});
test("a token for another owner is rejected", async () => {
  await assert.rejects(requestUploadToken({ ...common, sessionPresent: true,
    authorize: async () => "EnclaveSession test", signMessage: unexpectedWallet,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: "test", address: "0x" + "34".repeat(20) }) }) }), /different owner/);
});
test("without a session the existing explicitly initiated wallet upload remains available", async () => {
  let message;
  await requestUploadToken({ ...common, sessionPresent: false,
    authorize: () => { throw Error("no session"); }, signMessage: async m => { message = m; return "test-signature"; },
    fetchImpl: async (_url, request) => {
      assert.equal(message, `enclave-upload:${common.hash}:${common.expiry}`);
      assert.equal(JSON.parse(request.body).signature, "test-signature");
      assert.equal(request.headers.authorization, undefined);
      return { ok: true, json: async () => ({ token: "test", address: owner }) };
    } });
});
