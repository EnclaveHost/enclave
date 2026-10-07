// Exercise the actual dashboard methods without importing browser-only modules.
// EyesOff's host can serve logs even when the fleet has no default sign-in host.
// With a wallet session the host-owned reads open with no prompt at all; the per-host
// sign-in is the fallback for no session, or a host that answered the session 401.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../site/components/deployments/deployments.js", import.meta.url), "utf8");
const names = ["_output", "_lockedLogs", "_verify", "_lockedAttest", "_hostOf", "_hostAuthed", "_sessionTried", "_hostSignIn", "_asHost"];
const methods = names.map(name => {
  const match = src.match(new RegExp(`^  (?:async )?${name}\\([^]*?^  }`, "m"));
  assert.ok(match, `${name} exists`);
  return match[0];
}).join("\n");
const makePanel = new Function("Enclave", "authenticate", "asHostOwner", "showToast", "esc", "ctlOf", "runlog", "appEndpoint", "paintLine",
  `return new (class { ${methods} })();`);

// `wallet`: a wallet session in this browser; `oldHosts`: hosts that answered it 401 (api.js _siweHosts)
function fixture({ generic = false, host = "metal0", cached = [], reject = false, controller = "wallet", wallet = false, oldHosts = [] } = {}) {
  const sessions = new Set(cached), calls = [], errors = [], reads = [];
  const hostKey = (e) => String(e || "").trim().toLowerCase() || "*";
  const siwe = new Set(oldHosts.map(hostKey));
  const api = { authed: () => generic, authedFor: name => sessions.has(name), address: wallet ? "0x" + "11".repeat(20) : null,
    sessionMayServe: (h) => wallet && !siwe.has(hostKey(h)), _siweHosts: siwe, _hostKey: hostKey };
  const authenticate = async opts => {
    calls.push(opts);
    if (reject) throw new Error("Signature declined");
    if (!opts?.enclave) throw new Error("No enclave in the fleet is taking work right now");
    sessions.add(opts.enclave);
  };
  // wallet.js asHostOwner, as shipped: the call first; the host's sign-in only after a 401, and never for prompt:false
  const asHostOwner = async (enclave, call, { prompt = true } = {}) => {
    const h = String(enclave || "").trim();
    try { return await call(h); }
    catch (e) { if (!e || e.status !== 401 || !prompt) throw e; await authenticate(h ? { enclave: h } : undefined); return await call(h); }
  };
  const panel = makePanel(api, authenticate, asHostOwner, message => errors.push(message), String, () => controller,
    { runFor: () => null }, () => "", () => {});
  panel._list = [{ id: "eyesoff", enclave: host }];
  panel._startLogs = id => reads.push(["logs", id]);
  panel._attest = id => reads.push(["attestation", id]);
  panel._noteLogs = () => reads.push(["credit-note"]);
  const unlock = { addEventListener: (event, handler) => { assert.equal(event, "click"); unlock.click = handler; } };
  const el = { innerHTML: "", querySelector: () => unlock, isConnected: true };
  const box = { hidden: true, isConnected: true, innerHTML: "", querySelector: selector => selector === ".enc-unlock" ? unlock : el };
  const btn = { closest: () => ({ querySelector: () => box }), setAttribute() {} };
  return { panel, box, btn, unlock, calls, errors, reads, sessions, el };
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
  assert.equal(f.panel._hostOf("eyesoff"), "");
  assert.equal(await f.panel._asHost("eyesoff", async host => host), "");
  assert.deepEqual(f.calls, []);
});

test("a wallet session opens Output and Verify straight away: no unlock, no signature", async () => {
  const f = fixture({ wallet: true });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [["logs", "eyesoff"]]);
  const v = fixture({ wallet: true });     // (one box per fixture: a second toggle would close it)
  await v.panel._verify("eyesoff", v.btn);
  assert.deepEqual(v.reads, [["attestation", "eyesoff"]]);
  for (const x of [f, v]) {
    assert.deepEqual(x.calls, [], "no per-host sign-in");
    assert.equal(x.unlock.click, undefined, "no unlock offered");
  }
});

test("a host that answered the session 401 gets its own unlock, worded for it, and signs in to THAT host on the click", async () => {
  const f = fixture({ wallet: true, oldHosts: ["Metal0"] });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [], "not tried again: that host needs its own sign-in");
  assert.match(f.el.innerHTML, /doesn't take your session yet/);
  assert.deepEqual(f.calls, [], "and the wallet is not asked until the click");
  await f.unlock.click();
  assert.deepEqual(f.calls, [{ enclave: "metal0" }]);
  assert.deepEqual(f.reads, [["logs", "eyesoff"]]);
  // the other hosts still ride the session
  const g = fixture({ wallet: true, oldHosts: ["kryptos"] });
  g.panel._output("eyesoff", g.btn);
  assert.deepEqual(g.reads, [["logs", "eyesoff"]]);
});

test("owner calls: a poll never prompts (prompt:false hands the 401 back); a click falls back to the host's sign-in once", async () => {
  const f = fixture({ wallet: true });
  const err401 = Object.assign(new Error("Not signed in to metal0."), { status: 401 });
  let tries = 0;
  const call = async (h) => { tries++; if (!f.sessions.has(h)) throw err401; return "served by " + h; };
  await assert.rejects(f.panel._asHost("eyesoff", call, { prompt: false }), (e) => e.status === 401);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.panel._asHost("eyesoff", call), "served by metal0");
  assert.deepEqual(f.calls, [{ enclave: "metal0" }], "one sign-in, to the deployment's host");
  assert.equal(tries, 3);
});

test("credit-run rows still do not attempt wallet log authentication", () => {
  const f = fixture({ controller: "vault", cached: ["metal0"] });
  f.panel._output("eyesoff", f.btn);
  assert.deepEqual(f.reads, [["credit-note"]]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.unlock.click, undefined);
});
