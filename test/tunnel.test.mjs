// Fleet tunnel attach (relay/tunnel.js) + SEV-SNP quote verification
// (relay/snp-verify.mjs) — the trust boundary a self-hosted seller box crosses.
//
// Why these cases exist. The tunnel decides ROUTING, and routing is authority
// enough to matter: a tunnel row's `publicUrl` becomes its registry id upstream
// (keccak of the URL) and a row with a known id DISPLACES the discovered
// on-chain row, so whoever can name another enclave's endpoint inherits that
// enclave's /x data path and /v1 control path. Meanwhile the permissionless
// attach path authenticates a MEASUREMENT, not a box — every seller runs the
// same published image — so the name in the handshake is a request, never an
// identity. And a launch measurement says nothing about the POLICY the guest
// was launched under: the same image booted with DEBUG on is a transparent box
// whose memory the host reads at will, with a bit-identical measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { WebSocket } from "ws";
import { createTunnelHub } from "../relay/tunnel.js";
import { verifyQuote } from "../relay/snp-verify.mjs";
import { pvmCpuPolicy, PVM_CPU_CAPS_DOMAIN } from "../relay/pvm-cpu-tier.mjs";
import { createPadsLedger } from "../relay/pads.mjs";
import { sign as edSign } from "node:crypto";
import { AVF_PAD_FORMAT, avfPadBinding } from "../relay/avf-binding.mjs";
import { avfPolicyFromEnv } from "../relay/avf-policy.mjs";
import fs from "node:fs";
import { haveOpenssl, tmpdir, makeCa, issueLeaf, extension, CODE, AUTH } from "./fixtures/avf-synthetic.mjs";
import { makeVbsWorld, evidenceFor as vbsEvidenceFor, policyFor as vbsPolicyFor, nameOf as tpmName, tpmtPublicOf, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";
import { VBS_FORMAT } from "../relay/vbs-verify.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { HVNODE_FORMAT, hvNodeBinding } from "../relay/hvnode-verify.mjs";

// ---------- SEV-SNP quote gate ------------------------------------------------

const MEAS = "ab".repeat(48);
function report({ version = 2, policy = 0x30000n, vmpl = 0, measurement = MEAS, reportData = null } = {}) {
  const r = Buffer.alloc(0x2a0 + 0x90);
  r.writeUInt32LE(version, 0x00);
  r.writeBigUInt64LE(BigInt(policy), 0x08);
  r.writeUInt32LE(vmpl, 0x30);
  if (reportData) reportData.copy(r, 0x50);
  Buffer.from(measurement, "hex").copy(r, 0x90);
  return r;
}
const SPKI = Buffer.from("30599999", "hex");
const NONCE = Buffer.alloc(32, 7);
const bind32 = () => createHash("sha256").update(Buffer.concat([SPKI, NONCE])).digest();
const verify = (r, extra = {}) => verifyQuote(r, {
  challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], requireVcek: false, ...extra });

test("snp: a well-formed quote over the challenge passes (measurement-only mode)", async () => {
  const res = await verify(report({ reportData: bind32() }));
  assert.equal(res.ok, true);
  assert.equal(res.measurement, MEAS);
  assert.equal(res.vcekVerified, false);
});

test("snp: DEBUG in the guest policy is refused — same measurement, transparent box", async () => {
  const res = await verify(report({ policy: 0x30000n | (1n << 19n), reportData: bind32() }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /DEBUG/);
});

test("snp: MIGRATE_MA in the guest policy is refused", async () => {
  const res = await verify(report({ policy: 0x30000n | (1n << 18n), reportData: bind32() }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /MIGRATE_MA/);
});

test("snp: non-zero VMPL, old report version, off-allowlist measurement, stale challenge all fail", async () => {
  assert.equal((await verify(report({ vmpl: 1, reportData: bind32() }))).ok, false);
  assert.equal((await verify(report({ version: 1, reportData: bind32() }))).ok, false);
  assert.equal((await verify(report({ measurement: "cd".repeat(48), reportData: bind32() }))).ok, false);
  // report_data over a DIFFERENT challenge: a replayed quote proves no freshness
  const stale = createHash("sha256").update(Buffer.concat([SPKI, Buffer.alloc(32, 9)])).digest();
  const res = await verify(report({ reportData: stale }));
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /report_data does not bind/);
});

// ---------- tunnel attach -----------------------------------------------------

const TOKEN = "s3cret-token";
const TOKEN_SHA = createHash("sha256").update(TOKEN).digest("hex");

async function hubServer({ attest = null, operatorFor = null } = {}) {
  const hub = createTunnelHub({ allow: [{ name: "metal0", tokenSha256: TOKEN_SHA }], attest, operatorFor });
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`;
  return { hub, server, url, close: () => new Promise((r) => server.close(r)) };
}
// resolves "open" when the handshake completes, or the refusal status code.
// Frames are collected from the socket itself: the hub's challenge is sent the
// instant the handshake lands, before a caller could attach a listener.
const dial = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const frames = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
  ws.on("open", () => resolve({ state: "open", ws, frames }));
  ws.on("unexpected-response", (_req, res) => { try { ws.terminate(); } catch {} resolve({ state: res.statusCode }); });
  ws.on("error", () => resolve({ state: "error" }));
});
const settle = () => new Promise((r) => setTimeout(r, 60));

test("tunnel: the token binds a name; a wrong token or a bad name never attaches", async () => {
  const h = await hubServer();
  try {
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": "wrong" })).state, 401);
    assert.equal((await dial(h.url, { "x-metal-name": "other", "x-metal-token": TOKEN })).state, 401);
    // a name is a routing key (tunnel://<name>, /t/<name>/…): only plain labels
    assert.equal((await dial(h.url, { "x-metal-name": "me/../tal", "x-metal-token": TOKEN })).state, 400);
    assert.equal((await dial(h.url, { "x-metal-name": "", "x-metal-token": TOKEN })).state, 400);
    const ok = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    assert.equal(ok.state, "open");
    await settle();
    assert.equal(h.hub.count(), 1);
    ok.ws.close();
  } finally { await h.close(); }
});

test("tunnel: a hello frame never sets the mode - a token-attached box that says snp stays unverified", async () => {
  // The mode is the hub's verdict from attach ("snp"/"avf"/"vbs" after a verified quote or chain,
  // "" for a token attach). `t.mode = f.mode || t.mode` in the hello handler let a token-attached
  // metal box promote itself to "snp", which downstream read as "the relay verified a fresh SEV-SNP
  // quote" (pricing.js teeCpuOf source "relay") and made it eligible for tenant work on its own word.
  const h = await hubServer();
  try {
    const { ws } = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    await settle();
    assert.equal(h.hub.origins()[0].mode, "", "a token attach verified nothing");
    for (const claimed of ["snp", "avf", "vbs", "hv-node", "tdx"]) {
      ws.send(JSON.stringify({ t: "hello", mode: claimed, publicUrl: "https://api.enclave.host/t/metal0" }));
      await settle();
      assert.equal(h.hub.origins()[0].mode, "", `hello mode:${claimed} must not promote a token attach`);
      assert.equal(h.hub.info("metal0").mode, "", "info() reads the same verdict");
    }
    assert.equal(h.hub.origins()[0].publicUrl, "https://api.enclave.host/t/metal0", "the rest of the hello still lands");
    ws.close();
  } finally { await h.close(); }
});

test("tunnel: only a SELF-ROUTED publicUrl is honored — a box cannot claim another enclave's endpoint", async () => {
  const h = await hubServer();
  try {
    const { ws } = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    await settle();
    const pub = () => h.hub.origins()[0].publicUrl;

    // the shape a CGNAT seller registers on chain (`enclave host`)
    ws.send(JSON.stringify({ t: "hello", publicUrl: "https://api.enclave.host/t/metal0" }));
    await settle();
    assert.equal(pub(), "https://api.enclave.host/t/metal0");

    // …and everything that would let it stand in for somebody else
    for (const claim of ["https://kryptos.enclave.host",            // a first-party enclave
                         "https://api.enclave.host/t/other",        // another tunnel's route
                         "https://api.enclave.host/t/metal0/../x",  // path games
                         "http://api.enclave.host/t/metal0",        // downgrade
                         "https://api.enclave.host/t/metal0?a=1"]) {
      ws.send(JSON.stringify({ t: "hello", publicUrl: claim }));
      await settle();
      assert.equal(pub(), "", `claimed ${claim}`);
      ws.send(JSON.stringify({ t: "hello", publicUrl: "https://api.enclave.host/t/metal0" }));
      await settle();
    }
    ws.close();
  } finally { await h.close(); }
});

test("tunnel: attestation attach cannot take a token-reserved name", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false } });
  try {
    // no token + attest mode on = the attestation path; metal0 belongs to the token
    assert.equal((await dial(h.url, { "x-metal-name": "metal0" })).state, 401);
    assert.equal((await dial(h.url, { "x-metal-name": "metal0", "x-metal-attest": "1" })).state, 401);
    // an unreserved name still gets its challenge (and attaches only after a quote)
    const r = await dial(h.url, { "x-metal-name": "seller7", "x-metal-attest": "1" });
    assert.equal(r.state, "open");
    await settle();
    assert.equal(r.frames[0]?.t, "challenge");
    assert.equal(typeof r.frames[0].nonce, "string");
    assert.equal(h.hub.count(), 0, "unverified peer must not be in the fleet");
    r.ws.close();
  } finally { await h.close(); }
});

// ---------- a name belongs to the key that registered it ----------------------
// A quote proves the IMAGE, never which box it is - every seller runs the same
// published release - and the metal transport key is minted PER BOOT, so
// neither is an identity that survives a reboot. That left a window: while a
// seller was down, another box running the same release could take its name and
// inherit the routing for keccak(https://<relay>/t/<name>), the id its own
// on-chain registration carries. The registry OPERATOR key is what survives, so
// a registered name now demands a signature from it.
// A RAD document the hub will accept: a quote whose report_data binds the
// transport key to THIS attach's nonce, i.e. what a real agent sends.
const radFor = (nonce) => ({
  format: "sev-snp-guest/v2",
  body: report({ reportData: createHash("sha256").update(Buffer.concat([SPKI, nonce])).digest() }).toString("base64"),
  transportKey: SPKI.toString("base64"),
});

const { privateKeyToAccount } = await import("viem/accounts");
const OWNER = privateKeyToAccount("0x" + "11".repeat(32));
const OTHER = privateKeyToAccount("0x" + "22".repeat(32));

// Drive a full attest handshake: dial, read the challenge, answer with a quote
// (+ optional operator signature), and report the hub's verdict.
async function attestAttach(h, name, { signer = null, quoteNonceFrom = (n) => n } = {}) {
  const r = await dial(h.url, { "x-metal-name": name, "x-metal-attest": "1" });
  if (r.state !== "open") return { state: r.state };
  await settle();
  const ch = r.frames.find((f) => f.t === "challenge");
  const nonce = Buffer.from(ch.nonce, "base64");
  const rad = radFor(quoteNonceFrom(nonce));
  const frame = { t: "attest", rad };
  if (signer) frame.operatorSig = await signer.signMessage({
    message: `enclave-tunnel-attach:${name}:${nonce.toString("base64")}` });
  r.ws.send(JSON.stringify(frame));
  const res = await waitResult(r.frames);
  try { r.ws.close(); } catch {}
  return { state: "open", ok: !!res?.ok, reason: res?.reason || "(no verdict)" };
}

// Wait for the hub's verdict rather than sleeping at it: the owner check runs a
// dynamic `import("viem")`, and the FIRST one in a process is slow enough that a
// fixed settle() read an empty frame list and called it a refusal.
async function waitResult(frames, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const f = frames.find((x) => x.t === "attest-result");
    if (f) return f;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("tunnel: a REGISTERED name demands the operator key that registered it", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async (n) => (n === "seller7" ? OWNER.address : null) });
  try {
    // the owner attaches: image proven by the quote, identity by the signature
    const good = await attestAttach(h, "seller7", { signer: OWNER });
    assert.equal(good.ok, true, `owner must attach: ${good.reason}`);
    assert.equal(h.hub.count(), 1);
    await settle();

    // a stranger running the SAME published image cannot take the name
    const thief = await attestAttach(h, "seller7", { signer: OTHER });
    assert.equal(thief.ok, false);
    assert.match(thief.reason, /registered on chain to/i);

    // ...nor by simply omitting the proof
    const silent = await attestAttach(h, "seller7");
    assert.equal(silent.ok, false);
    assert.match(silent.reason, /operatorSig/i);
  } finally { await h.close(); }
});

test("tunnel: an UNREGISTERED name stays first-come (nothing to take yet)", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async () => null });
  try {
    const r = await attestAttach(h, "brand-new");
    assert.equal(r.ok, true, `an unowned name needs no signature: ${r.reason}`);
  } finally { await h.close(); }
});

test("tunnel: a lookup failure fails CLOSED against a name we have seen owned", async () => {
  // An RPC blip must not become the way in. Once the hub has resolved an owner
  // for a name, a later failure falls back to it rather than opening the name.
  let mode = "ok";
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async (n) => {
                                if (mode === "down") throw new Error("rpc down");
                                return n === "seller7" ? OWNER.address : null;
                              } });
  try {
    assert.equal((await attestAttach(h, "seller7", { signer: OWNER })).ok, true);
    await settle();
    mode = "down";
    const thief = await attestAttach(h, "seller7", { signer: OTHER });
    assert.equal(thief.ok, false, "a known owner must survive an unreadable registry");
    // and a name we have never resolved is still first-come while the chain is out
    const fresh = await attestAttach(h, "never-seen");
    assert.equal(fresh.ok, true);
  } finally { await h.close(); }
});

test("tunnel: the signature is bound to THIS attach's nonce and name", async () => {
  const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false },
                              operatorFor: async () => OWNER.address });
  try {
    // a signature over another name's message is not this name's proof
    const r = await dial(h.url, { "x-metal-name": "seller7", "x-metal-attest": "1" });
    await settle();
    const ch = r.frames.find((f) => f.t === "challenge");
    const nonce = Buffer.from(ch.nonce, "base64");
    const wrongName = await OWNER.signMessage({
      message: `enclave-tunnel-attach:someone-else:${nonce.toString("base64")}` });
    r.ws.send(JSON.stringify({ t: "attest", rad: radFor(nonce), operatorSig: wrongName }));
    const res = await waitResult(r.frames);
    assert.equal(res?.ok, false, "a signature for another name must not attach this one");
    try { r.ws.close(); } catch {}

    // a signature over a STALE nonce likewise (replay of an old attach)
    const stale = await attestAttach(h, "seller7", {
      signer: { signMessage: () => OWNER.signMessage({
        message: `enclave-tunnel-attach:seller7:${Buffer.alloc(32, 9).toString("base64")}` }) } });
    assert.equal(stale.ok, false, "a replayed signature must not attach");
  } finally { await h.close(); }
});

/* ---- the RELAY agent: how a box that terminates nothing gets listed --------
   A relay carries traffic and runs no tenants, so it has no TLS surface of its
   own — that is the point of the SNI splice, and giving it a certificate would
   put an ACME key on the one box whose security argument is that it holds none.
   So it dials the same fleet tunnel the CGNAT sellers use and the hub answers
   for it at /t/<name>.

   Three properties, and the third is the one that matters most: this agent has
   NO upstream. metal/guest/agent.mjs forwards tunnel requests into a real
   supervisor and splices raw streams into it; a relay must never become a
   generic proxy into its own network, least of all one reachable from a public
   hub. It answers a fixed self-description and refuses everything else. */
test("relay-agent: attaches, describes itself as resourceless, and proxies nothing", async (t) => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const hub = createTunnelHub({ allow: [{ name: "us-west", tokenSha256: TOKEN_SHA }] });
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const agent = spawn(process.execPath, [path.join(REPO, "relay", "relay-agent.mjs")], {
    env: { ...process.env,
      RELAY_NAME: "us-west", RELAY_TUNNEL_TOKEN: TOKEN,
      RELAY_HUB: `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`,
      RELAY_PUBLIC_ADDRESS: "5.78.85.108", RELAY_REGION: "us-west",
      RELAY_SNI: "1", RELAY_TCP: "0", RELAY_PORTS: "1-49999" },
    stdio: "ignore",
  });
  // ORDER MATTERS: the agent holds a live websocket, and server.close() does not
  // resolve until every connection is gone — closing first hangs the suite.
  t.after(async () => {
    try { agent.kill("SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => server.close(r));
  });

  for (let i = 0; i < 60 && hub.count() === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.count(), 1, "the agent attached with its token");

  const a = await hub.fetchJson("tunnel://us-west", "/availability");
  // DECLARED zeros are the claim that makes this a relay — api-relay reads them
  // (never absent fields) as "carries traffic, sells nothing", badges the row,
  // and keeps it out of the set that sizes the fleet.
  assert.equal(a.gpu, false);
  assert.equal(a.nodeVcpus, 0);
  assert.equal(a.nodeRamGb, 0);
  assert.equal(a.claimEnabled, false, "it must never be routed work");
  // and the part the per-deployment picker needs: a name's address and region
  assert.equal(a.relay.sni, true);
  assert.equal(a.relay.tcp, false, "it does not run the dedicated-IPv6 relays");
  assert.equal(a.relay.address, "5.78.85.108");
  assert.equal(a.relay.region, "us-west");

  const health = await hub.fetchJson("tunnel://us-west", "/v1/health");
  assert.equal(health.ok, true);
  assert.equal(health.role, "relay");

  // anything else 404s — fetchJson maps a non-200 to null. There is no
  // upstream to reach, by construction.
  assert.equal(await hub.fetchJson("tunnel://us-west", "/v1/deployments"), null,
    "no tenant surface is exposed");
});

/* ---- attach by ON-CHAIN OWNERSHIP: the path a relay can actually use ------
   A token says someone put a hash in a file; a quote says "I am a published
   Metal release". A relay can offer neither — it is not a TEE, deliberately,
   because it terminates nothing and holds no keys, so there is no measurement
   to publish and a quote would add nothing. What it does have is the operator
   key that registered its endpoint on chain, and that is a better identity than
   a token: it can be rotated with a transaction instead of a code push, and
   nothing about the fleet's membership has to be hardcoded here.

   The properties: the signature must recover to the address the REGISTRY names
   for that endpoint; a name with no registration proves nothing and is refused
   (unlike the attest path, where the quote still proved something); a name on
   the token allowlist stays reserved; and the whole path is OFF unless switched
   on, because a tunnel row bypasses the dial-time operator allowlist. */
test("tunnel: a relay attaches by signing with the operator that owns its name on chain", async (t) => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);

  const hub = createTunnelHub({
    allow: [{ name: "metal0", tokenSha256: TOKEN_SHA }],
    operatorFor: async (name) => (name === "us-west" ? owner.address : null),
    operatorAttach: true,
    trustedOperators: [owner.address],        // proving the name is not the same as being welcome
  });
  const server = http.createServer((_q, r) => r.end("ok"));
  server.on("upgrade", (q, s, h) => hub.handleUpgrade(q, s, h));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`;

  // drive the exchange by hand: challenge in, signature out, verdict back
  const open = [];
  // ORDER MATTERS: server.close() does not resolve while a socket is still
  // attached, so the held sockets have to go first — one hook, not two racing.
  t.after(async () => {
    for (const w of open) { try { w.close(); } catch {} }
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => server.close(r));
  });
  // `keep` holds a successful socket open: closing on the verdict would unbind
  // the tunnel before the assertion could see it.
  const attach = async (name, account, keep = false) => {
    const ws = new WebSocket(url, { headers: { "x-metal-name": name, "x-metal-attach": "operator" } });
    if (keep) open.push(ws);
    return await new Promise((resolve) => {
      const done = (v) => { if (!keep) { try { ws.close(); } catch {} } resolve(v); };
      ws.on("unexpected-response", (_q, res) => done({ http: res.statusCode }));
      ws.on("error", () => done({ error: true }));
      ws.on("message", async (d) => {
        const f = JSON.parse(d);
        if (f.t === "challenge") {
          if (!account) return;                       // prove nothing, wait for the timeout
          const operatorSig = await account.signMessage({
            message: `enclave-tunnel-attach:${name}:${f.nonce}` });
          ws.send(JSON.stringify({ t: "attach", operatorSig }));
        } else if (f.t === "attest-result") done(f);
      });
    });
  };

  const ok = await attach("us-west", owner, true);
  assert.equal(ok.ok, true, "the registered operator's signature attaches the name");
  await settle();
  assert.equal(hub.count(), 1);

  const wrong = await attach("us-west", stranger);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /registered on chain to/, "a stranger's signature names the mismatch");

  // no registration = nothing to prove against. The attest path lets an
  // unregistered name stay first-come because the QUOTE still proved something;
  // a bare signature over an unowned name proves only that someone holds a key.
  const unowned = await attach("nobody", owner);
  assert.equal(unowned.ok, false);
  assert.match(unowned.reason, /no active on-chain registration/);

  // a token-allowlisted name is claimed, and stays claimed
  assert.equal((await attach("metal0", owner)).http, 401, "reserved for token attach");
});

test("tunnel: operator attach is refused unless it is switched on", async (t) => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
  // operatorFor resolves, but the switch is off — the default, and what
  // production runs until someone decides otherwise
  const hub = createTunnelHub({ operatorFor: async () => owner.address });
  const server = http.createServer((_q, r) => r.end("ok"));
  server.on("upgrade", (q, s, h) => hub.handleUpgrade(q, s, h));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const res = await dial(`ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`,
    { "x-metal-name": "us-west", "x-metal-attach": "operator" });
  assert.equal(res.state, 401, "off by default: a tunnel row bypasses the dial-time allowlist");
  assert.equal(hub.count(), 0);
});

/* Proving a name is not the same as being welcome. EnclaveRegistry is
   permissionless, so ownership alone would make the operator path the LEAST
   gated of the three: a stranger registers https://<relay>/t/<name>, signs for
   it, and lands in the fleet listing — and a row that claims capacity joins the
   set that sizes the fleet and takes placement. A token needs a committed hash
   and a quote needs an allowlisted measurement; this needs the same operator
   bar the dial path already applies, enforced here because a tunnel row skips
   that filter entirely. */
test("tunnel: owning the name on chain is not enough — the operator must be trusted", async (t) => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const hub = createTunnelHub({
    operatorFor: async () => stranger.address,     // genuinely owns it on chain
    operatorAttach: true,
    trustedOperators: ["0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1"],   // but not ours
  });
  const server = http.createServer((_q, r) => r.end("ok"));
  server.on("upgrade", (q, s, h) => hub.handleUpgrade(q, s, h));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `ws://127.0.0.1:${server.address().port}/v1/fleet-tunnel`;

  const verdict = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { "x-metal-name": "rogue", "x-metal-attach": "operator" } });
    ws.on("message", async (d) => {
      const f = JSON.parse(d);
      if (f.t === "challenge")
        ws.send(JSON.stringify({ t: "attach",
          operatorSig: await stranger.signMessage({ message: `enclave-tunnel-attach:rogue:${f.nonce}` }) }));
      else if (f.t === "attest-result") { try { ws.close(); } catch {} resolve(f); }
    });
    ws.on("error", () => resolve({ error: true }));
  });
  assert.equal(verdict.ok, false, "a valid signature over a genuinely owned name still does not attach");
  assert.match(verdict.reason, /not a trusted operator/);
  assert.equal(hub.count(), 0);
});

// ---------- AVF (phone-anchored) attach ------------------------------------
test("AVF production configuration never promotes legacy build pins to pad access", () => {
  const legacy = "aa".repeat(32), pad = "bb".repeat(32), authority = "cc".repeat(64);
  assert.equal(avfPolicyFromEnv({}), null);
  assert.equal(avfPolicyFromEnv({ METAL_AVF_PAD_CODE_HASHES: pad }), null, "APK authority remains mandatory");
  assert.equal(avfPolicyFromEnv({ METAL_AVF_AUTHORITY_HASHES: authority }), null);
  const old = avfPolicyFromEnv({ METAL_AVF_CODE_HASHES: legacy, METAL_AVF_AUTHORITY_HASHES: authority });
  assert.deepEqual(old, { codeHashes: [legacy], padCodeHashes: [], authorityHashes: [authority] });
  const onlyPad = avfPolicyFromEnv({ METAL_AVF_PAD_CODE_HASHES: ` ${pad.toUpperCase()}, `, METAL_AVF_AUTHORITY_HASHES: authority });
  assert.deepEqual(onlyPad, { codeHashes: [], padCodeHashes: [pad], authorityHashes: [authority] });
  const both = avfPolicyFromEnv({ METAL_AVF_CODE_HASHES: legacy, METAL_AVF_PAD_CODE_HASHES: pad, METAL_AVF_AUTHORITY_HASHES: authority });
  assert.deepEqual(both, { codeHashes: [legacy], padCodeHashes: [pad], authorityHashes: [authority] });
});
// The same gate, a different root: a phone's protected VM presents the X.509
// chain Google's RKP issued for its attested key. The relay binds it exactly as
// it binds an SNP quote — challenge = sha256(transportKey || nonce) inside the
// certificate, the attested key signing (transportKey || nonce) — and refuses
// anything not rooted at Google, not naming an allowlisted anchor build, or
// not carrying the signature. Its origin row says mode "avf", never "snp".
test("avf: a Google-rooted chain over (transportKey || nonce) attaches as mode avf; wrong root, wrong code, no signature, SNP-only relay all refuse",
     { skip: !haveOpenssl && "openssl not installed" }, async () => {
  const dir = tmpdir("avf-tunnel-");
  const ca = makeCa(dir);
  const policy = { codeHashes: [CODE.toString("hex")], authorityHashes: [AUTH.toString("hex")] };
  const env = { METAL_AVF_CODE_HASHES: CODE.toString("hex"), METAL_AVF_AUTHORITY_HASHES: AUTH.toString("hex") };
  const h = await hubServer({ attest: { avf: { ...avfPolicyFromEnv({ ...env, METAL_AVF_PAD_CODE_HASHES: CODE.toString("hex") }), rootPins: [ca.rootPin] } } });
  const hLegacy = await hubServer({ attest: { avf: { ...avfPolicyFromEnv(env), rootPins: [ca.rootPin] } } });
  const hStrict = await hubServer({ attest: { avf: policy } });        // the REAL Google pins: our synthetic root must be refused
  const hSnp = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false } });
  const transport = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const padKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  async function avfAttach(hub, name, { mutate = (ev) => ev, code = CODE,
                                      format = "android-avf-pvm/v1", mutateRad = (rad) => rad,
                                      stale = false } = {}) {
    const r = await dial(hub.url, { "x-metal-name": name, "x-metal-attest": "1" });
    if (r.state !== "open") return { state: r.state };
    await settle();
    const nonce = Buffer.from(r.frames.find((f) => f.t === "challenge").nonce, "base64");
    const signedNonce = stale ? Buffer.alloc(32, 9) : nonce;
    const bound = format === AVF_PAD_FORMAT ? avfPadBinding(transport, padKey, signedNonce) : Buffer.concat([transport, signedNonce]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(bound).digest(), code }) });
    const ev = mutate({ chain: [leaf.leaf, ca.inter, ca.root].map((d) => d.toString("base64")), signature: leaf.sign(bound).toString("base64") });
    r.ws.send(JSON.stringify({ t: "attest", rad: mutateRad({ format, body: Buffer.from(JSON.stringify(ev)).toString("base64"), transportKey: transport.toString("base64"), padKey }) }));
    const res = await waitResult(r.frames);
    return { state: "open", ok: !!res?.ok, reason: res?.reason || "(no verdict)", measurement: res?.measurement, ws: r.ws };
  }
  try {
    const good = await avfAttach(h, "pixel-1");
    assert.equal(good.ok, true, good.reason);
    assert.equal(good.measurement, CODE.toString("hex"), "the verdict carries the anchor's codeHash as the measurement");
    const row = h.hub.origins().find((o) => o.name === "pixel-1");
    assert.ok(row, "the phone is a tunnel origin now");
    assert.equal(row.mode, "avf", "the badge path reads mode avf, not snp");
    assert.equal(row.measurement, CODE.toString("hex"));
    // a verified phone cannot relabel itself as a confidential server in its hello
    good.ws.send(JSON.stringify({ t: "hello", mode: "snp", publicUrl: "https://api.enclave.host/t/pixel-1" }));
    await settle();
    assert.equal(h.hub.origins().find((o) => o.name === "pixel-1").mode, "avf", "hello mode:snp must not override the verified avf verdict");
    assert.equal(h.hub.info("pixel-1").padKey, "", "v1 cannot authenticate a pad recipient, even when it supplies one");
    try { good.ws.close(); } catch {}

    const wrongRoot = await avfAttach(hStrict, "pixel-2");
    assert.equal(wrongRoot.ok, false); assert.match(wrongRoot.reason, /not a pinned Google attestation root/);
    const wrongCode = await avfAttach(h, "pixel-3", { code: createHash("sha256").update("some other apk").digest() });
    assert.equal(wrongCode.ok, false); assert.match(wrongCode.reason, /allowlisted codeHash/);
    const unsigned = await avfAttach(h, "pixel-4", { mutate: (ev) => ({ chain: ev.chain }) });
    assert.equal(unsigned.ok, false); assert.match(unsigned.reason, /signature/);
    const off = await avfAttach(hSnp, "pixel-5");
    assert.equal(off.ok, false); assert.match(off.reason, /not enabled/);

    const v2 = await avfAttach(h, "pixel-v2", { format: AVF_PAD_FORMAT });
    assert.equal(v2.ok, true, v2.reason);
    assert.equal(h.hub.info("pixel-v2").padKey, padKey);
    assert.equal(h.hub.info("pixel-v2").spki, transport.toString("base64"));
    v2.ws.close();
    const tamper = [
      ["pad", (rad) => ({ ...rad, padKey: "31".repeat(32) })],
      ["transport", (rad) => ({ ...rad, transportKey: Buffer.concat([transport.subarray(0, 12), Buffer.alloc(32, 7)]).toString("base64") })],
      ["downgrade", (rad) => ({ ...rad, format: "android-avf-pvm/v1" })],
      ["missing-pad", (rad) => ({ ...rad, padKey: undefined })],
      ["short-pad", (rad) => ({ ...rad, padKey: "31".repeat(31) })],
      ["nonhex-pad", (rad) => ({ ...rad, padKey: "zz".repeat(32) })],
      ["unknown-format", (rad) => ({ ...rad, format: "android-avf-pvm/v3" })],
      ["format-suffix", (rad) => ({ ...rad, format: "android-avf-pvm/v2junk" })],
      ["bad-spki", (rad) => ({ ...rad, transportKey: SPKI.toString("base64") })],
    ];
    for (const [name, mutateRad] of tamper) {
      const bad = await avfAttach(h, `pixel-${name}`, { format: AVF_PAD_FORMAT, mutateRad });
      assert.equal(bad.ok, false, `${name}: ${bad.reason}`);
      assert.equal(h.hub.info(`pixel-${name}`), null, `${name} did not bind a tunnel`);
    }
    const stale = await avfAttach(h, "pixel-stale", { format: AVF_PAD_FORMAT, stale: true });
    assert.equal(stale.ok, false, "the attested transcript cannot be replayed under a fresh relay nonce");
    const upgraded = await avfAttach(h, "pixel-upgrade", { mutateRad: (rad) => ({ ...rad, format: AVF_PAD_FORMAT }) });
    assert.equal(upgraded.ok, false, "v1 evidence cannot masquerade as v2");
    const oldPolicy = await avfAttach(hLegacy, "pixel-old-policy", { format: AVF_PAD_FORMAT });
    assert.equal(oldPolicy.ok, false, "general legacy codeHashes must not admit arbitrary-signing payloads for pads");
    assert.match(oldPolicy.reason, /v2 pad attach is not enabled/);
    const wrongV2Code = await avfAttach(h, "pixel-v2-other-code", { format: AVF_PAD_FORMAT, code: createHash("sha256").update("old arbitrary signing apk").digest() });
    assert.equal(wrongV2Code.ok, false);
    assert.match(wrongV2Code.reason, /allowlisted codeHash/);
  } finally { await h.close(); await hLegacy.close(); await hStrict.close(); await hSnp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the NucBox node (mode hv-node) and the RETIRED VBS-enclave attach -------------
// Steven, 2026-09-25: the custom type-1 path is the only NucBox target; the VBS-enclave backend is retired.
// The node proves a HOST-ATTESTED BOOT STATE (relay/hvnode-verify.mjs): the same vbs-keys/vbs-credential round
// ties its quote to the TPM whose EK is checked, the quote binds its transport key and statement, the log must
// show Secure Boot on and test signing off with no dev tier. The row says mode/tier "hv-node", no measurement, no
// pad key, never tenant capacity. The legacy format is refused by name whatever the relay's policy holds.
test("hv-node: the NucBox node attaches as mode hv-node through the vbs-keys/vbs-credential round only when the relay's switch is on; the retired VBS-enclave format is refused by name; wrong credential, skipped round, stale nonce, foreign key, swapped statement, test signing and Secure Boot off all refuse",
     { skip: !haveOpenssl && "openssl not installed" }, async () => {
  const dir = tmpdir("hvnode-tunnel-");
  const w = makeVbsWorld(dir);
  const h = await hubServer({ attest: { hvNode: { ekRoots: w.ca.bundlePem } } });
  // a relay still holding the RETIRED VBS policy, lab test-signing switch included: it enables nothing now
  const hLegacy = await hubServer({ attest: { vbs: vbsPolicyFor(w, { allowTestSigning: true }), hvNode: { ekRoots: w.ca.bundlePem } } });
  const hOff = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false, vbs: vbsPolicyFor(w) } });
  const waitFrame = (frames, pred, ms = 8000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { const f = frames.find(pred); if (f) return resolve(f); if (Date.now() - t0 > ms) return resolve(null); setTimeout(tick, 20); };
    tick();
  });
  const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
  // A fake node: dial, take the challenge, present its keys, activate the credential with the EK's private
  // key (what the TPM does), then attest in the hv-node format, or in the retired one (`legacy`).
  async function nodeAttach(hub, name, { keys = true, credentialOf = (c) => c, stale = false, log = {}, statement = STATEMENT, statementSent = null, signer = w.transport.privateKey,
                                         transport = w.transport.spki, legacy = false, mutateRad = (r) => r } = {}) {
    const r = await dial(hub.url, { "x-metal-name": name, "x-metal-attest": "1" });
    if (r.state !== "open") return { state: r.state };
    const chal = await waitFrame(r.frames, (f) => f.t === "challenge");
    const nonce = Buffer.from(chal.nonce, "base64");
    let credential = Buffer.alloc(32, 0);
    if (keys) {
      r.ws.send(JSON.stringify({ t: "vbs-keys", ek: w.ek.cert.toString("base64"), ekChain: [w.ca.inter.toString("base64")], aikPub: w.aik.tpmtPublic.toString("base64"), aikName: w.aik.name.toString("base64") }));
      const cred = await waitFrame(r.frames, (f) => f.t === "vbs-credential" || f.t === "attest-result");
      if (!cred || cred.t !== "vbs-credential") return { state: "open", ok: false, reason: cred?.reason || "(no credential frame)", ws: r.ws, stage: "keys" };
      try { credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(cred.credentialBlob, "base64"), Buffer.from(cred.secret, "base64")); } catch { credential = Buffer.alloc(32, 0); }
    }
    let rad;
    if (legacy) {
      const ev = vbsEvidenceFor(w, { nonce, credential: credentialOf(credential) });
      rad = { format: VBS_FORMAT, body: Buffer.from(JSON.stringify(ev.body)).toString("base64"), transportKey: w.transport.spki.toString("base64"), padKey: w.padKey };
    } else {
      const bound = hvNodeBinding(w.transport.spki, stale ? Buffer.alloc(32, 9) : nonce, statement);
      const L = buildLog({ idksPub: w.idks.publicKey, ...log });
      const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: createHash("sha256").update(bound).digest() });
      const body = { proves: "an admin-level process on this TPM's host, in this measured boot state, chose and holds this transport key; it proves nothing about isolation or host exclusion",
                     statement: (statementSent || statement).toString("base64"), signature: edSign(null, bound, signer).toString("base64"), log: L.log.toString("base64"),
                     quote: { attest: Q.attest.toString("base64"), sig: Q.sig.toString("base64"), aikPub: w.aik.tpmtPublic.toString("base64") },
                     credential: credentialOf(credential).toString("base64"), ek: { cert: w.ek.cert.toString("base64"), chain: [w.ca.inter.toString("base64")] }, pcr0: w.pcr0.toString("hex"), platform: {} };
      rad = { format: HVNODE_FORMAT, transportKey: transport.toString("base64"), body: Buffer.from(JSON.stringify(body)).toString("base64") };
    }
    r.ws.send(JSON.stringify({ t: "attest", rad: mutateRad(rad) }));
    const res = await waitResult(r.frames);
    return { state: "open", ok: !!res?.ok, reason: res?.reason || "(no verdict)", measurement: res?.measurement, tier: res?.tier, hostExcluded: res?.hostExcluded, ws: r.ws, stage: "attest" };
  }
  try {
    const good = await nodeAttach(h, "nucbox-1");
    assert.equal(good.ok, true, good.reason); assert.equal(good.tier, "hv-node"); assert.equal(good.hostExcluded, false); assert.equal(good.measurement, null);
    const row = h.hub.origins().find((o) => o.name === "nucbox-1");
    assert.ok(row, "the node is a tunnel origin now");
    assert.equal(row.mode, "hv-node"); assert.equal(row.tier, "hv-node"); assert.equal(row.measurement, undefined, "no measurement: a host is not an image");
    assert.equal(row.attestedKeys, undefined); assert.equal(row.hvNode.hostExcluded, false); assert.equal(row.hvNode.tee, null); assert.deepEqual(row.hvNode.omissions, ["platform-firmware-unpinned"]);
    assert.match(row.hvNode.idksModulusSha256, /^[0-9a-f]{64}$/, "the boot's IDKS, for a same-boot VM report"); assert.equal(row.hvNode.hostStatement, undefined, "the node's statement stays in the hub");
    const info = h.hub.info("nucbox-1");
    assert.equal(info.mode, "hv-node"); assert.equal(info.padKey, "", "a host is never a pad consumer"); assert.equal(info.spki, w.transport.spki.toString("base64"));
    assert.equal(info.hvNode.hostStatement.json.backend, "custom-type1"); assert.match(info.hvNode.hostStatement.note, /never read for admission/);
    // a genuine reconnect (same transport key) may retake the name
    const again = await nodeAttach(h, "nucbox-1"); assert.equal(again.ok, true, again.reason); again.ws.close(); try { good.ws.close(); } catch {}

    // the RETIRED VBS-enclave format: refused by name, even on a relay still holding the lab test-signing policy
    const legacy = await nodeAttach(hLegacy, "win-legacy", { legacy: true });
    assert.equal(legacy.ok, false); assert.match(legacy.reason, /VBS-enclave backend \(ee-engine\) is retired/);
    // a relay with only the retired policy: the keys round is refused, the switch is the hv-node one
    const off = await nodeAttach(hOff, "nucbox-off");
    assert.equal(off.ok, false); assert.match(off.reason, /hv-node attach is not enabled/); assert.equal(off.stage, "keys");
    const offLegacy = await nodeAttach(hOff, "win-off", { keys: false, legacy: true });
    assert.equal(offLegacy.ok, false); assert.match(offLegacy.reason, /retired/);
    // straight to attest, no credential minted
    const skipped = await nodeAttach(h, "nucbox-nokeys", { keys: false });
    assert.equal(skipped.ok, false); assert.match(skipped.reason, /without the vbs-keys round/);
    // the TPM handed back the wrong credential
    const wrongCred = await nodeAttach(h, "nucbox-cred", { credentialOf: () => Buffer.alloc(32, 7) });
    assert.equal(wrongCred.ok, false); assert.match(wrongCred.reason, /3 credential/);
    // the transcript was built for another challenge (replay)
    const stale = await nodeAttach(h, "nucbox-stale", { stale: true });
    assert.equal(stale.ok, false); assert.match(stale.reason, /extraData == challenge/);
    // a foreign transport key in the rad: the quote and the possession signature were for another key
    const other = generateKeyPairSync("ed25519");
    const foreign = await nodeAttach(h, "nucbox-foreign", { transport: other.publicKey.export({ type: "spki", format: "der" }) });
    assert.equal(foreign.ok, false); assert.match(foreign.reason, /extraData == challenge|possession/);
    const forged = await nodeAttach(h, "nucbox-forged", { signer: other.privateKey });
    assert.equal(forged.ok, false); assert.match(forged.reason, /8 possession/);
    // the statement sent is not the one the quote bound
    const swapped = await nodeAttach(h, "nucbox-stmt", { statementSent: Buffer.from(JSON.stringify({ stated: true, hostExcluded: true })) });
    assert.equal(swapped.ok, false); assert.match(swapped.reason, /extraData == challenge/);
    // production boot policy only: test signing and Secure Boot off refuse, on the legacy lab relay too
    const ts = await nodeAttach(hLegacy, "nucbox-ts", { log: { fields: { TESTSIGNING: 1 } } });
    assert.equal(ts.ok, false); assert.match(ts.reason, /TESTSIGNING == 0/);
    const sb = await nodeAttach(h, "nucbox-sb", { log: { secureBoot: 0 } });
    assert.equal(sb.ok, false); assert.match(sb.reason, /Secure Boot on/);
    const noTransport = await nodeAttach(h, "nucbox-nokey", { mutateRad: (r) => ({ ...r, transportKey: undefined }) });
    assert.equal(noTransport.ok, false); assert.match(noTransport.reason, /must carry transportKey/);
    // hv-node evidence cannot ride another format
    const misLabel = await nodeAttach(h, "nucbox-format", { mutateRad: (r) => ({ ...r, format: AVF_PAD_FORMAT }) });
    assert.equal(misLabel.ok, false);
    for (const n of ["win-legacy", "nucbox-off", "win-off", "nucbox-nokeys", "nucbox-cred", "nucbox-stale", "nucbox-foreign", "nucbox-forged", "nucbox-stmt", "nucbox-ts", "nucbox-sb", "nucbox-nokey", "nucbox-format"])
      assert.equal(h.hub.info(n) || hLegacy.hub.info(n) || hOff.hub.info(n), null, `${n} did not bind`);
  } finally { await h.close(); await hLegacy.close(); await hOff.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the operator's minimum-TCB policy reaches the attach gate -----------
// relay/snp-verify.mjs judges the reported TCB against a floor only the caller supplies
// (METAL_MIN_TCB on the relay). Unset, attaches behave as before; set, a quote whose TCB cannot be
// judged (this file's version-2 reports name no product line) or a policy that is not well formed
// refuses the attach instead of passing it.
test("tunnel: a minimum-TCB policy it cannot evaluate, or cannot parse, refuses the attach", async () => {
  const floor = { Turin: { fmc: 0, bootloader: 0, tee: 0, snp: 0, microcode: 0 } };
  for (const [minTcb, why] of [[floor, /product line is unknown/], ["not json", /malformed/]]) {
    const h = await hubServer({ attest: { allowedMeasurements: [MEAS], requireVcek: false, minTcb }, operatorFor: async () => null });
    try {
      const r = await attestAttach(h, "seller9");
      assert.equal(r.ok, false, `minTcb ${JSON.stringify(minTcb)} must refuse`);
      assert.match(r.reason, why);
      assert.equal(h.hub.count(), 0);
    } finally { await h.close(); }
  }
});

// ---------- pVM CPU tier: one signed capability report per AVF attach --------
// The tier is the HUB's verdict (relay/pvm-cpu-tier.mjs admitPvmCpu): a phone whose
// protected-VM chain verified sends ONE {t:"caps"} frame, signed by the attested
// transport key over this attach's nonce; the hub sets tier "pvm-cpu" only when
// the verifier says eligible. A bad signature refuses (capsRefused, no tier), a
// second frame is ignored, a token-attached box's frame does nothing, and a hub
// without a pvm-cpu policy refuses every report.
test("pvm-cpu: a signed capability report over the attach nonce sets the hub's tier; refusals, replays and token boxes do not",
     { skip: !haveOpenssl && "openssl not installed" }, async () => {
  const dir = tmpdir("pvm-tunnel-");
  const ca = makeCa(dir);
  const env = { METAL_AVF_CODE_HASHES: CODE.toString("hex"), METAL_AVF_AUTHORITY_HASHES: AUTH.toString("hex") };
  const MODEL = "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", SELF = "d".repeat(64);
  const policy = pvmCpuPolicy({ codeHashes: [CODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
    models: [{ sha256: MODEL, name: "gemma-4-e2b-q4_0", bytes: 3360161216, selftestSha256: SELF, minDecodeTokS: 10, minMemMib: 6144 }] });
  const avf = { ...avfPolicyFromEnv(env), rootPins: [ca.rootPin] };
  const h = await hubServer({ attest: { avf, pvmCpu: policy } });
  const hNoPolicy = await hubServer({ attest: { avf } });
  const attach = async (hub, name, key) => {
    const r = await dial(hub.url, { "x-metal-name": name, "x-metal-attest": "1" });
    assert.equal(r.state, "open");
    await settle();
    const nonce = Buffer.from(r.frames.find((f) => f.t === "challenge").nonce, "base64");
    const transport = key.publicKey.export({ type: "spki", format: "der" });
    const bound = Buffer.concat([transport, nonce]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(bound).digest(), code: CODE }) });
    const ev = { chain: [leaf.leaf, ca.inter, ca.root].map((d) => d.toString("base64")), signature: leaf.sign(bound).toString("base64") };
    r.ws.send(JSON.stringify({ t: "attest", rad: { format: "android-avf-pvm/v1", body: Buffer.from(JSON.stringify(ev)).toString("base64"), transportKey: transport.toString("base64") } }));
    const res = await waitResult(r.frames);
    assert.equal(res?.ok, true, res?.reason);
    return { ws: r.ws, frames: r.frames, nonce };
  };
  const report = (nonce, over = {}) => Buffer.from(JSON.stringify({ v: 1, tier: "pvm-cpu", nonce: nonce.toString("hex"), mode: "protected",
    model: { sha256: MODEL, bytes: 3360161216, ctx: 4096 }, vm: { threads: 6, mem_mib: 7168 },
    selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 108.2, decode_tok_s: 13.9, output_sha256: SELF },
    vm_ms: 200000, attach_vm_ms: 120000, device: "Pixel 10 Pro XL", ...over }));
  const caps = (ws, bytes, key) => ws.send(JSON.stringify({ t: "caps", report: bytes.toString("base64"),
    sig: edSign(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), bytes]), key.privateKey).toString("hex") }));
  const capsResult = async (frames) => { for (let i = 0; i < 40; i++) { const f = frames.find((x) => x.t === "caps-result"); if (f) return f; await settle(); } return null; };
  const row = (hub, name) => hub.hub.origins().find((o) => o.name === name);
  try {
    // the good phone: verified attach, then a report signed by its attested key over its nonce
    const k1 = generateKeyPairSync("ed25519");
    const a = await attach(h, "pixel-a", k1);
    assert.equal(row(h, "pixel-a").mode, "avf"); assert.equal(row(h, "pixel-a").tier, undefined, "no tier before a report");
    caps(a.ws, report(a.nonce), k1);
    const r1 = await capsResult(a.frames);
    assert.equal(r1?.ok, true, (r1?.reasons || []).join(" | "));
    assert.equal(row(h, "pixel-a").tier, "pvm-cpu", "the hub set the tier");
    assert.equal(row(h, "pixel-a").pvmCpu.model, "gemma-4-e2b-q4_0", "the row carries the model name");
    assert.equal(row(h, "pixel-a").pvmCpu.decodeTokS, undefined, "and no measured rate");
    // a second frame, even a worse one, changes nothing: one report per attach
    caps(a.ws, report(a.nonce, { mode: "dev" }), k1);
    await settle(); await settle();
    assert.equal(row(h, "pixel-a").tier, "pvm-cpu");
    assert.equal(a.frames.filter((x) => x.t === "caps-result").length, 1, "the second frame is ignored, not re-judged");
    // a hello afterwards cannot touch the tier or the mode
    a.ws.send(JSON.stringify({ t: "hello", mode: "snp", tier: "pvm-cpu", publicUrl: "https://api.enclave.host/t/pixel-a" }));
    await settle();
    assert.equal(row(h, "pixel-a").mode, "avf"); assert.equal(row(h, "pixel-a").tier, "pvm-cpu");
    a.ws.close();

    // a report signed by some other key: refused, no tier, the row says a report was refused
    const k2 = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
    const b = await attach(h, "pixel-b", k2);
    caps(b.ws, report(b.nonce), other);
    const r2 = await capsResult(b.frames);
    assert.equal(r2?.ok, false); assert.ok(r2.reasons.some((x) => /not signed by the attested transport key/.test(x)), r2.reasons.join(" | "));
    assert.equal(row(h, "pixel-b").tier, undefined); assert.equal(row(h, "pixel-b").capsRefused, true);
    b.ws.close();

    // a report over another attach's nonce: refused (a replayed or foreign report)
    const k3 = generateKeyPairSync("ed25519");
    const c = await attach(h, "pixel-c", k3);
    caps(c.ws, report(Buffer.alloc(32, 5)), k3);
    const r3 = await capsResult(c.frames);
    assert.equal(r3?.ok, false); assert.ok(r3.reasons.some((x) => /not this attach's nonce/.test(x)), r3.reasons.join(" | "));
    assert.equal(row(h, "pixel-c").tier, undefined);
    c.ws.close();

    // a hub with no pvm-cpu policy refuses every report, however good
    const k4 = generateKeyPairSync("ed25519");
    const d = await attach(hNoPolicy, "pixel-d", k4);
    caps(d.ws, report(d.nonce), k4);
    const r4 = await capsResult(d.frames);
    assert.equal(r4?.ok, false); assert.ok(r4.reasons.some((x) => /not configured/.test(x)), r4.reasons.join(" | "));
    assert.equal(row(hNoPolicy, "pixel-d").tier, undefined);
    d.ws.close();

    // a token-attached box has no attach verdict: its caps frame does nothing at all
    const tok = await dial(h.url, { "x-metal-name": "metal0", "x-metal-token": TOKEN });
    await settle();
    tok.ws.send(JSON.stringify({ t: "caps", report: report(Buffer.alloc(32, 1)).toString("base64"), sig: "00".repeat(64) }));
    await settle(); await settle();
    assert.equal(tok.frames.some((x) => x.t === "caps-result"), false, "no verdict for a box that never attested");
    assert.equal(row(h, "metal0").mode, ""); assert.equal(row(h, "metal0").tier, undefined);
    tok.ws.close();
  } finally { await h.close(); await hNoPolicy.close(); }
});

// ---------- pVM CPU build on the v2 transcript: routes, never gets pads ------
// The pvm-cpu build always attaches with the v2 (pad-binding) transcript because its
// VM mints a pad key. It is admitted on ITS code hash for routing only: a pvm-cpu
// code hash that is not also an admitted PAD build keeps no pad key, so the pads
// ledger never lists it as a consumer and never issues it a seed - the same rule a
// v1 attach lives under. A pad build on the same transcript keeps its key, and a
// build in neither list is refused.
test("pvm-cpu: a v2 attach on a pvm-cpu code hash routes with no pad eligibility; a pad build keeps its key; a stranger is refused",
     { skip: !haveOpenssl && "openssl not installed" }, async () => {
  const dir = tmpdir("pvm-v2-");
  const ca = makeCa(dir);
  const PADCODE = createHash("sha256").update("dealt-pads anchor build").digest();
  const PVMCODE = createHash("sha256").update("pvm-cpu protected build").digest();
  const MODEL = "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", SELF = "d".repeat(64);
  const env = { METAL_AVF_CODE_HASHES: CODE.toString("hex"), METAL_AVF_PAD_CODE_HASHES: PADCODE.toString("hex"), METAL_AVF_AUTHORITY_HASHES: AUTH.toString("hex") };
  const policy = pvmCpuPolicy({ codeHashes: [PVMCODE.toString("hex")], authorityHashes: [AUTH.toString("hex")],
    models: [{ sha256: MODEL, name: "gemma-4-e2b-q4_0", bytes: 3360161216, selftestSha256: SELF, minDecodeTokS: 10, minMemMib: 6144 }] });
  const h = await hubServer({ attest: { avf: { ...avfPolicyFromEnv(env), rootPins: [ca.rootPin] }, pvmCpu: policy } });
  const ledger = createPadsLedger({ dir, hub: h.hub, log: () => {} });
  const attachV2 = async (name, key, code) => {
    const r = await dial(h.url, { "x-metal-name": name, "x-metal-attest": "1" });
    assert.equal(r.state, "open");
    await settle();
    const nonce = Buffer.from(r.frames.find((f) => f.t === "challenge").nonce, "base64");
    const transport = key.publicKey.export({ type: "spki", format: "der" });
    const padKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const bound = avfPadBinding(transport, padKey, nonce);
    const leaf = issueLeaf(dir, { ext: extension({ challenge: createHash("sha256").update(bound).digest(), code }) });
    const ev = { chain: [leaf.leaf, ca.inter, ca.root].map((d) => d.toString("base64")), signature: leaf.sign(bound).toString("base64") };
    r.ws.send(JSON.stringify({ t: "attest", rad: { format: AVF_PAD_FORMAT, body: Buffer.from(JSON.stringify(ev)).toString("base64"), transportKey: transport.toString("base64"), padKey } }));
    const res = await waitResult(r.frames);
    return { ok: !!res?.ok, reason: res?.reason || "", ws: r.ws, frames: r.frames, nonce, padKey };
  };
  try {
    // the pvm-cpu build: admitted for routing, its pad key NOT retained
    const kp = generateKeyPairSync("ed25519");
    const pvm = await attachV2("pixel-pvm", kp, PVMCODE);
    assert.equal(pvm.ok, true, pvm.reason);
    const row = h.hub.origins().find((o) => o.name === "pixel-pvm");
    assert.equal(row.mode, "avf");
    assert.equal(row.measurement, PVMCODE.toString("hex"));
    assert.equal(h.hub.info("pixel-pvm").padKey, "", "a pvm-cpu build keeps no pad key, whatever it presented");
    assert.equal(ledger.pvm("pixel-pvm").padKey, "", "the pads ledger sees no key to seal a seed to");
    assert.deepEqual(ledger.consumers().map((c) => c.name), [], "and never lists it as a pad consumer");
    // the same phone can still be admitted to the tier on its capability report
    const report = Buffer.from(JSON.stringify({ v: 1, tier: "pvm-cpu", nonce: pvm.nonce.toString("hex"), mode: "protected",
      model: { sha256: MODEL, bytes: 3360161216, ctx: 4096 }, vm: { threads: 6, mem_mib: 7168 },
      selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 108.2, decode_tok_s: 13.9, output_sha256: SELF },
      vm_ms: 200000, attach_vm_ms: 120000, device: "Pixel 10 Pro XL" }));
    pvm.ws.send(JSON.stringify({ t: "caps", report: report.toString("base64"),
      sig: edSign(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), report]), kp.privateKey).toString("hex") }));
    for (let i = 0; i < 40 && !pvm.frames.some((x) => x.t === "caps-result"); i++) await settle();
    assert.equal(pvm.frames.find((x) => x.t === "caps-result")?.ok, true);
    assert.equal(h.hub.origins().find((o) => o.name === "pixel-pvm").tier, "pvm-cpu");
    assert.equal(h.hub.info("pixel-pvm").padKey, "", "the tier changes nothing about pads");
    assert.deepEqual(ledger.consumers(), [], "still not a pad consumer");

    // the pad build on the same transcript keeps its key and IS a consumer (the control)
    const kd = generateKeyPairSync("ed25519");
    const pad = await attachV2("pixel-pad", kd, PADCODE);
    assert.equal(pad.ok, true, pad.reason);
    assert.equal(h.hub.info("pixel-pad").padKey, pad.padKey);
    assert.deepEqual(ledger.consumers().map((c) => c.name), ["pixel-pad"], "only the pad build is a consumer");
    // its caps frame is refused (not a pvm-cpu build) and it gains no tier
    pad.ws.send(JSON.stringify({ t: "caps", report: report.toString("base64"), sig: "00".repeat(64) }));
    for (let i = 0; i < 40 && !pad.frames.some((x) => x.t === "caps-result"); i++) await settle();
    assert.equal(pad.frames.find((x) => x.t === "caps-result")?.ok, false);
    assert.equal(h.hub.origins().find((o) => o.name === "pixel-pad").tier, undefined);

    // a v1-only build (CODE) on the v2 transcript is in neither v2 list: refused
    const stranger = await attachV2("pixel-x", generateKeyPairSync("ed25519"), CODE);
    assert.equal(stranger.ok, false);
    assert.match(stranger.reason, /codeHash/i);
    assert.equal(h.hub.origins().some((o) => o.name === "pixel-x"), false);

    pvm.ws.close(); pad.ws.close();
  } finally { await h.close(); }
});
