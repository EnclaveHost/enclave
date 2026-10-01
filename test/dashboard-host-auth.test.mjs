// Exercise the actual dashboard methods without importing browser-only modules.
// EyesOff's host can serve logs even when the fleet has no default sign-in host.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../site/components/deployments/deployments.js", import.meta.url), "utf8");
const names = ["_output", "_lockedLogs", "_verify", "_hostAuthed", "_hostSession", "_asHost"];
const methods = names.map(name => {
  const match = src.match(new RegExp(`^  (?:async )?${name}\\([^]*?^  }`, "m"));
  assert.ok(match, `${name} exists`);
  return match[0];
}).join("\n");
const makePanel = new Function("Enclave", "authenticate", "showToast", "esc", "ctlOf", "runlog", "appEndpoint", "paintLine",
  `return new (class { ${methods} })();`);

function fixture({ generic = false, host = "metal0", cached = [], reject = false, controller = "wallet" } = {}) {
  const sessions = new Set(cached), calls = [], errors = [], reads = [];
  const api = { authed: () => generic, authedFor: name => sessions.has(name) };
  const panel = makePanel(api, async opts => {
    calls.push(opts);
    if (reject) throw new Error("Signature declined");
    if (!opts?.enclave) throw new Error("No enclave in the fleet is taking work right now");
    sessions.add(opts.enclave);
  }, message => errors.push(message), String, () => controller, { runFor: () => null }, () => "", () => {});
  panel._list = [{ id: "eyesoff", enclave: host }];
  panel._startLogs = id => reads.push(["logs", id]);
  panel._attest = id => reads.push(["attestation", id]);
  panel._noteLogs = () => reads.push(["credit-note"]);
  const unlock = { addEventListener: (event, handler) => { assert.equal(event, "click"); unlock.click = handler; } };
  const el = { innerHTML: "", querySelector: () => unlock };
  const box = { hidden: true, isConnected: true, innerHTML: "", querySelector: selector => selector === ".enc-unlock" ? unlock : el };
  const btn = { closest: () => ({ querySelector: () => box }), setAttribute() {} };
  return { panel, box, btn, unlock, calls, errors, reads, sessions };
}

test("Output unlock signs in to the running app's host when fleet-default auth is unavailable", async () => {
  const f = fixture();
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.calls, [], "opening Output must not prompt for a signature");
  assert.deepEqual(f.reads, []);
  await f.unlock.click();
  assert.deepEqual(f.calls, [{ enclave: "metal0" }]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.reads, [["logs", "eyesoff"]]);
  assert.equal(await f.panel._asHost("eyesoff", async host => host), "metal0");
  assert.equal(f.calls.length, 1, "the log read reuses the host session");
});

test("cached host auth opens logs without requiring a generic session or another signature", () => {
  const f = fixture({ cached: ["metal0"] });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [["logs", "eyesoff"]]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.unlock.click, undefined);
});

test("a generic session or another host's session does not unlock this host's private reads", async () => {
  for (const opts of [{ generic: true }, { cached: ["another-host"] }]) {
    const f = fixture(opts);
    f.panel._output("eyesoff", f.btn);
    assert.deepEqual(f.reads, []);
    await f.unlock.click();
    assert.deepEqual(f.calls, [{ enclave: "metal0" }]);
  }
});

test("Unlock & verify uses the same host-scoped session as logs", async () => {
  const f = fixture({ generic: true });
  await f.panel._verify("eyesoff", f.btn);
  assert.deepEqual(f.reads, []);
  await f.unlock.click();
  assert.deepEqual(f.calls, [{ enclave: "metal0" }]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.reads, [["attestation", "eyesoff"]]);
  const cached = fixture({ cached: ["metal0"] });
  await cached.panel._verify("eyesoff", cached.btn);
  assert.deepEqual(cached.reads, [["attestation", "eyesoff"]]);
  assert.deepEqual(cached.calls, []);
});

test("a declined signature never starts logs and leaves unlock available to retry", async () => {
  const f = fixture({ reject: true });
  f.panel._output("eyesoff", f.btn);
  await f.unlock.click();
  assert.deepEqual(f.errors, ["Signature declined"]);
  assert.deepEqual(f.reads, []);
  assert.equal(f.panel._hostAuthed("eyesoff"), false);
});

test("closing or removing Output during authentication does not restart its log poll", async () => {
  for (const closed of [{ hidden: true }, { isConnected: false }]) {
    const f = fixture();
    f.panel._output("eyesoff", f.btn);
    Object.assign(f.box, closed);
    await f.unlock.click();
    assert.deepEqual(f.reads, []);
  }
});

test("legacy rows without a named host retain generic session support", async () => {
  const f = fixture({ host: "", generic: true });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [["logs", "eyesoff"]]);
  assert.equal(await f.panel._hostSession("eyesoff"), "");
  assert.deepEqual(f.calls, []);
});

test("credit-run rows still do not attempt wallet log authentication", () => {
  const f = fixture({ controller: "vault", cached: ["metal0"] });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [["credit-note"]]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.unlock.click, undefined);
});
