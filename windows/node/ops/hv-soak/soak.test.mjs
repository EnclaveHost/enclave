// node --test windows/node/ops/hv-soak/ - the parsers, the thresholds and the summary against fake answers and fake
// JSONL, and the TLS check against a local server whose throwaway certificate is made with openssl at test time.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULTS, CONSOLE_OK, THRESHOLDS, BOOTSTRAP, remoteCommand, appUrlFor, certFacts, tlsCheck, parseRelayRow, encodeGetCall,
  decodeDeployment, boxScript, parseBoxStdout, consumeChunk, scanLog, consoleScan, pickDeploymentVm, digestBox, newEval, step,
  summarize, newSampler, humanLine, parseArgs, exercised, headSentInWindow,
} from "./soak.mjs";

const DEP = DEFAULTS.deployment;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---------------------------------------------------------------- TLS against a local server */

function makeCert(dir, cn) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`], { stdio: "ignore" });
  return { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
}
let openssl = true;
try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { openssl = false; }

test("tlsCheck: verification is ON - a self-signed leaf is recorded (SPKI, serial, issuer) and no response is counted", { skip: !openssl && "no openssl" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvsoak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { key, cert } = makeCert(dir, "localhost");
  const seen = [];
  const srv = https.createServer({ key, cert }, (req, res) => { seen.push([req.url, req.headers["x-hv-soak"], req.method]); res.end("Hello World!\n"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const want = sha(crypto.createPublicKey(key).export({ type: "spki", format: "der" }));

  const bad = await tlsCheck(`https://localhost:${port}/hv-soak/x`, { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.authorized, false);
  assert.equal(bad.authorizationError, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(bad.status, null, "no status is read over an unverified connection");
  assert.equal(bad.cert.spkiSha256, want);
  assert.match(bad.cert.issuer, /CN=localhost/);
  assert.ok(bad.cert.serial.length > 0);

  const good = await tlsCheck(`https://localhost:${port}/hv-soak/tok123`, { timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tok123" } });
  assert.equal(good.ok, true);
  assert.equal(good.authorized, true);
  assert.equal(good.status, 200);
  assert.equal(good.bytes, 13);
  assert.equal(good.cert.spkiSha256, want);
  assert.ok(Number.isFinite(good.latencyMs));
  assert.deepEqual(seen.at(-1), ["/hv-soak/tok123", "tok123", "GET"], "the token rides in the path and in the header");

  // the HEAD probe: the same verified connection rules, the method reaches the server, no body is read
  const head = await tlsCheck(`https://localhost:${port}/hv-soak/tok456`, { method: "HEAD", timeoutMs: 5000, ca: cert, headers: { "x-hv-soak": "tok456" } });
  assert.deepEqual([head.ok, head.authorized, head.status, head.bytes], [true, true, 200, 0]);
  assert.deepEqual(seen.at(-1), ["/hv-soak/tok456", "tok456", "HEAD"]);
  const headBad = await tlsCheck(`https://localhost:${port}/`, { method: "HEAD", timeoutMs: 5000 });
  assert.deepEqual([headBad.authorized, headBad.status], [false, null]);

  // a trusted chain for the WRONG name is refused too: the hostname is verified
  const wrong = await tlsCheck(`https://127.0.0.1:${port}/`, { timeoutMs: 5000, ca: cert });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.authorized, false);
  assert.match(wrong.authorizationError, /ALTNAME|IP/);
});

test("tlsCheck: a refused connection is an error with no certificate", async () => {
  const s = https.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  const r = await tlsCheck(`https://127.0.0.1:${port}/`, { timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.cert, null);
  assert.match(r.error, /ECONNREFUSED/);
});

test("certFacts: the SPKI hash is over the DER SubjectPublicKeyInfo, not the certificate", { skip: !openssl && "no openssl" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvsoak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { key, cert } = makeCert(dir, "a.example");
  const f = certFacts(new crypto.X509Certificate(cert));
  assert.equal(f.spkiSha256, sha(crypto.createPublicKey(key).export({ type: "spki", format: "der" })));
  assert.notEqual(f.spkiSha256, new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase());
  assert.equal(f.subject, "CN=a.example");
});

/* ---------------------------------------------------------------- relay row */

const ROW = { endpoint: "tunnel://nucbox-k11", name: "nucbox-k11", lastSeen: 1790386391, tunnel: true, mode: "hv-node", attach: "attestation",
  tier: "hv-node", hvNode: { hostExcluded: false, verifiedAt: "2026-09-26T01:33:11.151Z" }, serving: false, eligible: false,
  ineligible: "host-attested boot state", availability: { claimScope: "owner-only", owners: ["0x389C3f030a209D04D026228D2D053fEB75DbadcA"], apps: { running: 1 } } };
const relayBody = (row) => ({ updatedAt: "2026-09-26T01:33:21.000Z", enclaves: [{ name: "other" }, ...(row ? [row] : [])] });

test("parseRelayRow: the owner-only hv-node row is ok, and each required field is checked", () => {
  const f = parseRelayRow(relayBody(ROW), "nucbox-k11");
  assert.equal(f.ok, true);
  assert.equal(f.attached, true);
  assert.equal(f.lastSeenAgeSec, 10);
  assert.deepEqual(f.owners, ["0x389c3f030a209d04d026228d2d053feb75dbadca"]);
  assert.equal(f.eligible, false);
  for (const [mut, why] of [
    [{ mode: "metal" }, "mode"], [{ tier: "t0" }, "tier"], [{ attach: "token" }, "attach"], [{ tunnel: false }, "tunnel"],
    [{ hvNode: { hostExcluded: true } }, "hostExcluded true"], [{ hvNode: {} }, "hostExcluded missing"],
    [{ availability: { claimScope: "open" } }, "claimScope"],
  ]) assert.equal(parseRelayRow(relayBody({ ...ROW, ...mut }), "nucbox-k11").ok, false, why);
  assert.deepEqual(parseRelayRow(relayBody(null), "nucbox-k11"), { ok: false, present: false, updatedAt: "2026-09-26T01:33:21.000Z" });
  assert.equal(parseRelayRow({}, "nucbox-k11").ok, false);
});

/* ---------------------------------------------------------------- chain */

test("decodeDeployment: reads the static head of get(bytes32)'s tuple (it has dynamic strings)", () => {
  const w = (x) => BigInt(x).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const head = [DEP.slice(2), addr("0x389C3f030a209D04D026228D2D053fEB75DbadcA"), w(17 * 32), w(18 * 32), w(19 * 32), w(0), w(10), w(0),
    w(1), w(1), w(1790384307), w(1), w(46400), w(3600), DEFAULTS.enclaveId.slice(2), addr("0x389C3f030a209D04D026228D2D053fEB75DbadcA"), w(1790388031)];
  const hex = "0x" + w(32) + head.join("") + w(0) + w(0) + w(0);
  const d = decodeDeployment(hex);
  assert.deepEqual(d, { owner: "0x389c3f030a209d04d026228d2d053feb75dbadca", active: true, rate: 1, balance6: 46400, spent6: 3600,
                        runnerIsBox: true, leaseUntil: "2026-09-26T02:00:31.000Z" });
  assert.throws(() => decodeDeployment("0x" + w(32)), /short/);
  assert.equal(encodeGetCall(DEP), "0x8eaa6ac0" + DEP.slice(2));
});

/* ---------------------------------------------------------------- the box script is read-only */

const P = { root: DEFAULTS.root, managerPort: 8091, deployment: DEP, nodeFrom: 0, managerFrom: 0, cap: 4 << 20, consoleSec: 25, consoleMaxBytes: 1 << 20 };

test("boxScript: nothing in it changes the box", () => {
  const s = boxScript(P);
  const verbs = [...s.matchAll(/\b([A-Z][a-z]+)-([A-Z][A-Za-z]+)\b/g)].map((m) => `${m[1]}-${m[2]}`);
  const allowed = new Set(["Invoke-WebRequest", "ConvertFrom-Json", "Where-Object", "Get-VMComPort", "New-Object", "Get-VM", "ForEach-Object",
                           "Get-CimInstance", "Join-Path", "ConvertTo-Json"]);
  assert.deepEqual([...new Set(verbs)].filter((v) => !allowed.has(v)), [], "only reading cmdlets");
  assert.doesNotMatch(s, /-Method\b|FileAccess\]::(Write|ReadWrite)|PipeDirection\]::(Out|InOut)|Set-|Remove-|Stop-|Start-|Restart-|\bdel\b|\bmkdir\b/);
  assert.match(s, /\[IO\.FileAccess\]::Read,/);
  assert.match(s, /\[System\.IO\.Pipes\.PipeDirection\]::In,/);
  assert.match(s, /\$_\.status -eq 'running' -and \$_\.guest/, "the console is opened only once the manager's start capture is done");
  assert.doesNotMatch(s, /state\\|operator\.key|proof\.key|delegations/i, "never near the key directory");
});

test("boxScript: refuses inputs that would change what it reads", () => {
  assert.throws(() => boxScript({ ...P, root: "C:\\x'; Remove-Item C:\\ -Recurse; '" }), /root/);
  assert.throws(() => boxScript({ ...P, deployment: "0x12" }), /deployment/);
  assert.throws(() => boxScript({ ...P, nodeFrom: -5 }), /nodeFrom/);
  assert.throws(() => boxScript({ ...P, managerFrom: 1.5 }), /managerFrom/);
  assert.match(boxScript({ ...P, nodeFrom: 12345 }), /\$NodeFrom = \[long\]12345;/);
});

test("the ssh command line is a short bootstrap (cmd.exe caps a command line at 8191 characters)", () => {
  const cmd = remoteCommand();
  assert.ok(cmd.length < 8191, `${cmd.length}`);
  const enc = cmd.split(" ").pop();
  assert.equal(Buffer.from(enc, "base64").toString("utf16le"), BOOTSTRAP);
  assert.match(BOOTSTRAP, /\[Console\]::In\.ReadToEnd\(\)/);
});

test("parseBoxStdout: the last HVSOAK1 line, not READY and not the noise around it", () => {
  const out = "** WARNING: post-quantum\nHVSOAK1-READY console\n#< CLIXML\nHVSOAK1 {\"v\":1,\"a\":2}\r\n";
  assert.deepEqual(parseBoxStdout(out), { ok: true, data: { v: 1, a: 2 } });
  assert.equal(parseBoxStdout("HVSOAK1-READY console\n").ok, false);
  assert.match(parseBoxStdout("HVSOAK1 {bad").error, /unparseable/);
});

/* ---------------------------------------------------------------- logs and console */

const NODE_LOG = [
  "01:28:14 [node] [host] registry: listed as https://api.enclave.host/t/nucbox-k11 price 12/sec cpu",
  "01:28:38 [node] [host] 0x31136008 isolation spawned: hvc8633f status=running image=b7ba7731",
  "01:28:45 [node] [host] 0x31136008 isolation adopted: hvc8633f status=running image=b7ba7731",
  "01:30:31 [node] [host] 0x31136008 isolated domain retired (forced relaunch)",
  "Fri 09/25/2026 18:31:27.49 [run] agent.mjs exited -1; restarting in 10 s ",
  "01:33:07 [node] [host] 0x31136008 isolation: manager: this tier refuses what it cannot verify",
  "01:40:00 [node] [host] registry: card price now 0/sec (was 12) tx=0xabc",
  "01:41:00 [node] [host] renewed 0x31136008",
  "01:41:01 [node] [host] renewed 0x99999999",
  "01:42:00 [node] [host] 0x31136008 isolation held, not renewed: boundary",
  "01:43:00 [node] [host] 0x31136008 renew failed: Error: nonce too low",
  "01:44:00 [node] [host] 0x99999999 isolation spawned: hv1 status=running",
  "",
].join("\r\n");

test("scanLog: the markers the soak counts, for THIS deployment where it matters", () => {
  const c = scanLog(NODE_LOG, { deployment: DEP, token: "hvsoakZZ" });
  assert.equal(c.lines, 12);
  assert.equal(c.restart, 2, "spawned + retired for 0x31136008; the other deployment's spawn is not ours");
  assert.equal(c.cardPrice, 1);
  assert.equal(c.renewed, 2);
  assert.equal(c.renewedMine, 1);
  assert.equal(c.notRenewed, 1);
  assert.equal(c.renewFailed, 1);
  assert.equal(c.procRestarts, 1);
  assert.equal(c.errorLines, 1);
  assert.equal(c.refusLines, 1);
  assert.equal(c.tokenHits, 0);
  assert.equal(scanLog(NODE_LOG + "01:50:00 GET /hv-soak/hvsoakZZ\n", { deployment: DEP, token: "hvsoakZZ" }).tokenHits, 1);
  assert.equal(c.restartLines.length, 2);
});

test("consumeChunk: only complete lines are consumed; the next read starts after the last newline", () => {
  const c = consumeChunk({ from: 100, b64: b64("a\nb\npart") });
  assert.equal(c.text, "a\nb\n");
  assert.equal(c.next, 104);
  assert.equal(c.pendingBytes, 4);
  assert.deepEqual(consumeChunk({ from: 7, b64: b64("no newline yet") }), { text: "", next: 7, bytes: 0, pendingBytes: 14 });
  assert.equal(consumeChunk({ from: 0, b64: "" }).next, 0);
});

test("consoleScan: the guest's own lines pass; anything else is counted and hashed, never kept", () => {
  const txt = "\r\nMON ready control_port=9000\r\nDOM1 started runtime=2 front=3\r\n[   12.345678] virtio: probe\r\n"
            + "DOM serving unix=/run/front.sock\r\nServing HTTP on http://127.0.0.1:8080/\r\nGET /hv-soak/hvsoakTOK 200\r\nMON dom";
  const c = consoleScan(Buffer.from(txt, "latin1"), { token: "hvsoakTOK" });
  assert.equal(c.lines, 6);
  assert.equal(c.nonMatching, 2);
  assert.deepEqual(c.nonMatchingSha256, [sha("Serving HTTP on http://127.0.0.1:8080/"), sha("GET /hv-soak/hvsoakTOK 200")]);
  assert.equal(c.partialTailBytes, 7);
  assert.equal(c.tokenHits, 1);
  assert.doesNotMatch(JSON.stringify(c), /Serving|hv-soak/, "no line content in the result");
  assert.ok(CONSOLE_OK.test("DOM1 x") && CONSOLE_OK.test("MON x") && CONSOLE_OK.test("[ 1.5] x") && !CONSOLE_OK.test(" DOM x"));
  assert.deepEqual(consoleScan(Buffer.alloc(0), { token: "x" }), { bytes: 0, lines: 0, nonMatching: 0, nonMatchingSha256: [], partialTailBytes: 0,
                                                                    tokenHits: 0, markerHits: 0, sentinelLines: 0, withheld: 0 });
});

// the target app's HEAD-body marker (a test value: the real one is the sentinel app's, passed with --body-marker)
const MARK = "SENTINEL-BODY-7f3a";
// what the front prints when the HEAD probe's app sends a body: the OLD guest (Go stdlib) and the FIXED one
const OLD_FRONT = `2026/09/26 03:00:01 Unsolicited response received on idle HTTP channel starting with "${MARK}\\n"; err=<nil>`;
const FIXED_FRONT = "DOM front: unsolicited upstream response (19 bytes withheld)";
// the sentinel's own per-request line on stdout and stderr
const SENTINEL_LINE = "-STDOUT-REQ /hv-soak/hvsoakT hvsoakT";

test("consoleScan: the body marker and a -STDOUT-REQ line are sightings; a 'bytes withheld' line is counted and is the guest's own", () => {
  const old = consoleScan(Buffer.from(`MON ok\r\n${OLD_FRONT}\r\n`, "latin1"), { token: "hvsoakZ", marker: MARK });
  assert.equal(old.markerHits, 1);
  assert.equal(old.nonMatching, 1);
  assert.equal(old.withheld, 0);
  const fixed = consoleScan(Buffer.from(`${FIXED_FRONT}\r\n${FIXED_FRONT}\r\n`, "latin1"), { token: "hvsoakZ", marker: MARK });
  assert.deepEqual([fixed.withheld, fixed.nonMatching, fixed.markerHits, fixed.sentinelLines, fixed.lines], [2, 0, 0, 0, 2]);
  const sen = consoleScan(Buffer.from(`${SENTINEL_LINE}\n${SENTINEL_LINE}\n`), { token: "hvsoakT", marker: MARK });
  assert.deepEqual([sen.sentinelLines, sen.tokenHits, sen.nonMatching], [2, 4, 2]);
  assert.equal(consoleScan(Buffer.from(`${OLD_FRONT}\n`), { marker: null }).markerHits, 0, "no marker, no count");
  assert.doesNotMatch(JSON.stringify(old) + JSON.stringify(sen), /Unsolicited|SENTINEL-BODY|STDOUT-REQ \//, "no line content in the result");
});

test("scanLog and digestBox: marker and sentinel sightings in the logs; the baseline read is history, reported apart", () => {
  const c = scanLog(`01:00:00 upstream said ${MARK}\n01:00:01 ${SENTINEL_LINE}\n`, { deployment: DEP, marker: MARK });
  assert.deepEqual([c.markerHits, c.sentinelLines], [1, 1]);
  const st = newSampler();
  const b1 = digestBox(boxRes({ node: `00:00:01 old ${MARK} ${SENTINEL_LINE}\n` }), st, { deployment: DEP, token: "t", marker: MARK });
  assert.deepEqual([b1.logs.node.markerHits, b1.logs.node.markerHitsHistory, b1.logs.node.sentinelLines, b1.logs.node.sentinelLinesHistory], [0, 1, 0, 1]);
  const b2 = digestBox(boxRes({ node: `00:05:00 new ${MARK}\n`, nodeFrom: st.offsets.node, console: `${OLD_FRONT}\n${SENTINEL_LINE}\n` }), st,
                       { deployment: DEP, token: "t", marker: MARK });
  assert.equal(b2.logs.node.markerHits, 1);
  assert.equal(b2.console.markerHits, 1);
  assert.equal(b2.console.sentinelLines, 1);
});

/* ---------------------------------------------------------------- digestBox */

const vm = (o = {}) => ({ id: "hv1210563e5e204bbc7cf0f987485949db", name: DEP, instanceId: "hv1210563e5e204b-9c3d10f1", status: "running",
  vmName: "enclave-app-hv1210563e5e204b-9c3d10f1", policy: { memMiB: 128 }, tier: "T0-hv", hostExcluded: false,
  transportKeySha256: "ab".repeat(32), managerEpoch: "e1", guest: { booted: true, bytes: 600, head: "MON ready" }, ...o });
function boxRes({ vms = [vm()], hv = [{ name: "enclave-app-hv1210563e5e204b-9c3d10f1", state: "Running", memMiB: 512, uptimeSec: 60 }],
                  node = NODE_LOG, nodeFrom = 0, manager = "[winmgr] data plane on 127.0.0.1:8092\n", console = "", connected = true } = {}) {
  return { ok: true, exit: 0, ms: 30000, readyMs: 3000, ready: connected ? "console" : "noconsole", data: {
    v: 1, vms: vms === null ? { ok: false, error: "503" } : { ok: true, b64: b64(JSON.stringify({ vms, managerEpoch: "e1" })) },
    console: { attempted: connected, connected, note: connected ? "" : "not connected", b64: b64(console) },
    hv: hv === null ? { ok: false, error: "Get-VM failed" } : { ok: true, vms: hv.length === 1 ? hv[0] : hv },
    mem: { ok: true, freeKB: 104857600, totalKB: 117440512 },
    node: { ok: true, size: nodeFrom + Buffer.byteLength(node), from: nodeFrom, reset: false, b64: b64(node) },
    manager: { ok: true, size: Buffer.byteLength(manager), from: 0, reset: false, b64: b64(manager) } } };
}

test("digestBox: a running partition, its VM Running, the logs from offset 0 as the baseline", () => {
  const st = newSampler();
  const b = digestBox(boxRes(), st, { deployment: DEP, token: "hvsoakT" });
  assert.equal(b.ok, true);
  assert.equal(b.partition.running, true);
  assert.equal(b.partition.vmState, "Running");
  assert.equal(b.partition.vmMemMiB, 512);
  assert.equal(b.vms.mine.memMiB, 128);
  assert.equal(b.mem.freeMiB, 102400);
  assert.equal(b.logs.node.baseline, true);
  assert.equal(st.offsets.node, Buffer.byteLength(NODE_LOG));
  assert.equal(b.partition.instanceChanged, false);
  // the second read is from the new offset, not a baseline, and a new instance is noticed
  const b2 = digestBox(boxRes({ vms: [vm({ id: "hvNEW" })], node: "01:50:00 [node] x\n", nodeFrom: st.offsets.node }), st, { deployment: DEP, token: "t2" });
  assert.equal(b2.logs.node.baseline, false);
  assert.equal(b2.logs.node.lines, 1);
  assert.equal(b2.partition.instanceChanged, true);
});

test("digestBox: not Running when the manager says so, when Hyper-V says Off, or when there is no record", () => {
  const d = (o) => digestBox(boxRes(o), newSampler(), { deployment: DEP, token: "t" });
  assert.equal(d({ vms: [vm({ status: "starting" })] }).partition.running, false);
  assert.equal(d({ hv: [{ name: vm().vmName, state: "Off", memMiB: 0, uptimeSec: 0 }] }).partition.running, false);
  assert.equal(d({ hv: [] }).partition.vmState, "absent");
  assert.equal(d({ hv: [] }).partition.running, false);
  assert.equal(d({ vms: [] }).partition.status, "absent");
  assert.equal(d({ vms: [] }).partition.running, false);
  assert.equal(d({ hv: null }).partition.running, true, "a failed Get-VM leaves the manager's word");
  assert.equal(d({ vms: null }).partition.running, null, "an unread /vms is unknown, not stopped");
  assert.equal(d({ vms: null }).ok, false);
  // the running record picked over a failed older one
  assert.equal(d({ vms: [vm({ id: "old", status: "failed" }), vm()] }).vms.mine.id, vm().id);
});

test("digestBox: a running partition whose console cannot be read is a failed box read; line contents never kept", () => {
  const st = newSampler();
  assert.equal(digestBox(boxRes({ connected: false }), st, { deployment: DEP, token: "t" }).ok, false);
  const b = digestBox(boxRes({ console: "MON ok\r\nServing HTTP on http://127.0.0.1:8080/ SECRETCANARY\r\n", node: "01:00:00 Error: boom SECRETCANARY\n" }),
                      newSampler(), { deployment: DEP, token: "t" });
  assert.equal(b.console.nonMatching, 1);
  assert.equal(b.logs.node.errorLines, 1);
  assert.doesNotMatch(JSON.stringify(b), /SECRETCANARY|Serving HTTP|boom/);
});

test("digestBox: an ssh failure yields only the ssh block", () => {
  const b = digestBox({ ok: false, exit: 255, ms: 15000, error: "ssh: connect timed out" }, newSampler(), { deployment: DEP, token: "t" });
  assert.deepEqual(b, { ok: false, ssh: { ok: false, exit: 255, ms: 15000, readyMs: null, error: "ssh: connect timed out" } });
});

/* ---------------------------------------------------------------- thresholds */

const SPKI_A = "a".repeat(64), SPKI_B = "b".repeat(64);
let clock = Date.parse("2026-09-26T03:00:00Z");
function S({ ok = true, spki = SPKI_A, authorized = true, status = ok ? 200 : 503, restart = 0, nodeOk = true, baseline = false,
             running = true, price = 0, nonMatching = 0, tokenHits = 0, boxOk = true, sshOk = true, relayOk = true, hostExcluded = false,
             connected = true, latencyMs = 300, t = null, chain = null, head = true, markerHits = 0, nodeMarkerHits = 0, withheld = 0,
             sentinelLines = 0 } = {}) {
  clock += 300_000;
  return { type: "sample", t: t || new Date(clock).toISOString(), deployment: DEP,
    tls: { ok, status: ok ? 200 : status, authorized, latencyMs, cert: spki ? { spkiSha256: spki } : null, error: ok ? null : "x" },
    head: { method: "HEAD", trigger: head ? "console" : "fallback", authorized: true, status: 200, sentInWindow: head },
    relay: { ok: relayOk, present: true, hostExcluded, mode: "hv-node" },
    chain: chain || { skipped: true },
    box: { ok: boxOk && sshOk, ssh: { ok: sshOk, error: sshOk ? undefined : "timeout" }, vms: { ok: true },
      partition: sshOk ? { running, status: running ? "running" : "starting" } : undefined,
      logs: sshOk ? { node: nodeOk ? { ok: true, baseline, restart, cardPrice: price, tokenHits: 0, markerHits: nodeMarkerHits, renewed: 0, renewedMine: 0 } : { ok: false, error: "x" },
                      manager: { ok: true, tokenHits: 0, markerHits: 0 } } : undefined,
      console: sshOk ? { connected, nonMatching, nonMatchingSha256: Array(nonMatching).fill("c".repeat(64)), tokenHits, markerHits, withheld,
                         sentinelLines, lines: 3 } : undefined } };
}
const run = (samples) => { const ev = newEval(); const vs = samples.map((s) => step(ev, s)); return { ev, vs, fails: ev.events.map((e) => e.id) }; };

test("thresholds: a clean run fails nothing", () => {
  assert.deepEqual(run([S({ baseline: true }), S(), S(), S()]).fails, []);
});

test("thresholds: public FAILs at the 3rd consecutive non-200, once per streak", () => {
  assert.deepEqual(run([S(), S({ ok: false }), S({ ok: false }), S()]).fails, []);
  const r = run([S(), S({ ok: false }), S({ ok: false }), S({ ok: false }), S({ ok: false }), S()]);
  assert.deepEqual(r.fails, ["public"]);
  assert.equal(r.ev.worst.public, 4);
  assert.deepEqual(run([S({ ok: false }), S({ ok: false }), S({ ok: false }), S(), S({ ok: false }), S({ ok: false }), S({ ok: false })]).fails, ["public", "public"]);
  // an unverified 200 is not a 200
  assert.deepEqual(run([S({ ok: false, authorized: false, status: 200 }), S({ ok: false, authorized: false }), S({ ok: false, authorized: false })]).fails, ["public"]);
});

test("thresholds: an SPKI change FAILs unless the node log recorded a restart of the deployment", () => {
  assert.deepEqual(run([S({ baseline: true }), S(), S({ spki: SPKI_B })]).fails, ["spki"]);
  assert.deepEqual(run([S({ baseline: true }), S(), S({ spki: SPKI_B, restart: 2 })]).fails, [], "the same window");
  // restarted after this sample's public check: the new key shows at the next one
  assert.deepEqual(run([S({ baseline: true }), S({ restart: 1 }), S({ spki: null, ok: false }), S({ spki: SPKI_B })]).fails, []);
  // a restart that kept the key clears the pending restart: a later change is unexplained again
  assert.deepEqual(run([S({ baseline: true }), S({ restart: 1 }), S(), S({ spki: SPKI_B })]).fails, ["spki"]);
  // a re-baselined key is the new reference
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, restart: 1 }), S({ spki: SPKI_B }), S({ spki: SPKI_A })]).fails, ["spki"]);
  // restart lines in the baseline read (history) explain nothing
  assert.deepEqual(run([S({ baseline: true, restart: 5 }), S({ spki: SPKI_B })]).fails, ["spki"]);
  // the log unreadable when the key changed: judged at the next read, either way
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, nodeOk: false }), S({ spki: SPKI_B, restart: 1 })]).fails, []);
  assert.deepEqual(run([S({ baseline: true }), S({ spki: SPKI_B, nodeOk: false }), S({ spki: SPKI_B })]).fails, ["spki"]);
  // the baseline waits for the first presented leaf
  assert.deepEqual(run([S({ baseline: true, spki: null, ok: false }), S({ spki: SPKI_B })]).fails, []);
});

test("thresholds: partition not Running on 2 consecutive samples; unknown neither counts nor resets", () => {
  assert.deepEqual(run([S({ running: false }), S(), S({ running: false })]).fails, []);
  assert.deepEqual(run([S({ running: false }), S({ running: false })]).fails, ["partition"]);
  assert.deepEqual(run([S({ running: false }), S({ sshOk: false }), S({ running: false })]).fails, ["partition"]);
});

test("thresholds: a card-price line after the baseline is a price tx", () => {
  assert.deepEqual(run([S({ baseline: true, price: 3 }), S(), S()]).fails, []);
  const r = run([S({ baseline: true, price: 3 }), S({ price: 1 })]);
  assert.deepEqual(r.fails, ["price"]);
  assert.equal(r.ev.price.baseline, 3);
  assert.equal(r.ev.price.added, 1);
});

test("thresholds: any non-DOM/MON console line or any token sighting is a leak", () => {
  assert.deepEqual(run([S({ nonMatching: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ tokenHits: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ tokenHits: 1, nonMatching: 2 })]).fails, ["leak", "leak"]);
});

test("thresholds: the HEAD probe's body marker and a sentinel -STDOUT-REQ line are leaks; a 'withheld' line is not", () => {
  assert.deepEqual(run([S({ markerHits: 1 })]).fails, ["leak"]);
  assert.deepEqual(run([S({ nodeMarkerHits: 2 })]).fails, ["leak"], "the marker in node.log");
  assert.deepEqual(run([S({ sentinelLines: 1 })]).fails, ["leak"]);
  const w = run([S({ withheld: 1 }), S({ withheld: 3 })]);
  assert.deepEqual(w.fails, []);
  assert.ok(w.vs[1].info.some(([id, m]) => id === "leak" && /3 'bytes withheld' line\(s\): the HEAD probe reached the front/.test(m)));
});

test("headSentInWindow: only a HEAD fired by READY-with-console, verified and answered", () => {
  const h = { authorized: true, status: 200 };
  assert.equal(headSentInWindow("console", h), true);
  assert.equal(headSentInWindow("console", { authorized: true, status: 405 }), true, "any answer proves it was delivered");
  assert.equal(headSentInWindow("noconsole", h), false, "no console connected: outside any window");
  assert.equal(headSentInWindow("fallback", h), false, "fired by the timer or the session's end");
  assert.equal(headSentInWindow("console", { authorized: false, status: null }), false, "unverified: dropped before sending");
  assert.equal(headSentInWindow("console", { authorized: true, status: null }), false, "no answer");
  assert.equal(headSentInWindow("console", null), false, "--leak-probe off");
});

/* the leak check must not pass vacuously: no leak seen PASSes only on enough EXERCISED samples (enclave-bf's blocker) */
const soakFile = (samples) => [JSON.stringify({ type: "start", interval: 300, deployment: DEP }), ...samples.map((s) => JSON.stringify(s))];
// n samples, `ex` of them exercised; the others miss ONLY the console (box.ok stays true, so no other threshold moves)
const coverage = (n, ex) => { clock = Date.parse("2026-09-27T00:00:00Z"); return soakFile(Array.from({ length: n }, (_, i) => S({ baseline: i === 0, connected: i < ex }))); };

test("exercised: the partition running, a verified 200, the console read, and both logs read", () => {
  assert.equal(exercised(S()), true);
  for (const [o, why] of [[{ running: false }, "not running"], [{ ok: false }, "no verified 200"], [{ ok: false, authorized: false, status: 200 }, "an unverified 200"],
                          [{ connected: false }, "no console"], [{ nodeOk: false }, "node.log unread"], [{ sshOk: false }, "no box read"],
                          [{ head: false }, "the HEAD probe not sent inside the console window"]])
    assert.equal(exercised(S(o)), false, why);
  const m = S(); m.box.logs.manager = { ok: false };
  assert.equal(exercised(m), false, "manager.log unread");
});

test("summarize: no console ever read -> leak NOT EXERCISED and the verdict is not PASS", () => {
  const r = summarize(coverage(10, 0));
  assert.equal(r.pass, false);
  assert.match(r.text, /NOT EXERCISED \(0\/10\) leak .*\[exercised 0\/10, floor 90\.0%\]/);
  assert.match(r.text, /leak check: exercised in 0\/10 samples \(0\.0%; floor 90\.0%\)/);
  assert.match(r.text, /VERDICT: NOT PASS/);
  assert.doesNotMatch(r.text, /VERDICT: PASS/);
  for (const id of ["public", "spki", "partition", "price", "box", "relay"]) assert.match(r.text, new RegExp(`PASS ${id} `), `${id} is untouched`);
});

test("summarize: just under the floor is NOT PASS; at or above it with no hits is PASS", () => {
  const under = summarize(coverage(100, 89));
  assert.equal(under.pass, false);
  assert.match(under.text, /NOT EXERCISED \(89\/100\) leak/);
  const at = summarize(coverage(100, 90));
  assert.equal(at.pass, true);
  assert.match(at.text, /PASS leak .*\[exercised 90\/100, floor 90\.0%\]/);
  assert.match(at.text, /VERDICT: PASS/);
  assert.equal(summarize(coverage(10, 10)).pass, true);
  // the floor is configurable, and whatever it is, 0 exercised samples never PASS (even a floor of 0 through the API)
  assert.equal(summarize(coverage(100, 89), { leakFloor: 0.85 }).pass, true);
  assert.equal(summarize(coverage(10, 0), { leakFloor: 0.01 }).pass, false);
  assert.equal(summarize(coverage(10, 0), { leakFloor: 0 }).pass, false);
  assert.equal(summarize(coverage(10, 1), { leakFloor: 0 }).pass, true);
});

test("summarize: a token hit in an exercised sample is a leak FAIL", () => {
  clock = Date.parse("2026-09-28T00:00:00Z");
  const r = summarize(soakFile([S({ baseline: true }), S(), S({ tokenHits: 1 }), S()]));
  assert.equal(r.pass, false);
  assert.match(r.text, /FAIL leak .*\[exercised 4\/4, floor 90\.0%\]: 1 event\(s\)/);
  assert.match(r.text, /VERDICT: FAIL/);
});

test("summarize: without the HEAD probe nothing is exercised; a marker sighting FAILs; withheld lines are reported", () => {
  clock = Date.parse("2026-09-29T00:00:00Z");
  const off = summarize(soakFile(Array.from({ length: 10 }, (_, i) => S({ baseline: i === 0, head: false }))));
  assert.equal(off.pass, false);
  assert.match(off.text, /NOT EXERCISED \(0\/10\) leak/);
  assert.match(off.text, /HEAD probe: sent inside the console window in 0\/10 samples/);
  const hit = summarize(soakFile([S({ baseline: true }), S({ markerHits: 1 }), S()]));
  assert.match(hit.text, /FAIL leak .*: 1 event\(s\); first .*body marker appeared 1 time/);
  const ok = summarize(soakFile([S({ baseline: true, withheld: 1 }), S({ withheld: 1 }), S()]));
  assert.equal(ok.pass, true);
  assert.match(ok.text, /'bytes withheld' lines 2 \(in 2 samples: the probe reached the front\)/);
});

test("thresholds: the box read FAILs at 3 in a row and is INFO below that", () => {
  const r = run([S({ sshOk: false }), S({ sshOk: false })]);
  assert.deepEqual(r.fails, []);
  assert.ok(r.vs[1].info.some(([id]) => id === "box"));
  assert.deepEqual(run([S({ sshOk: false }), S({ boxOk: false }), S({ sshOk: false })]).fails, ["box"]);
});

test("thresholds: relay row wrong 3 in a row; hostExcluded true at once", () => {
  assert.deepEqual(run([S({ relayOk: false }), S({ relayOk: false }), S()]).fails, []);
  assert.deepEqual(run([S({ relayOk: false }), S({ relayOk: false }), S({ relayOk: false })]).fails, ["relay"]);
  assert.deepEqual(run([S({ relayOk: false, hostExcluded: true })]).fails, ["relay"]);
});

/* ---------------------------------------------------------------- summary */

test("summarize: uptime, latency percentiles, coverage with a gap, PASS/FAIL per threshold", () => {
  clock = Date.parse("2026-09-26T03:00:00Z");
  const lines = [JSON.stringify({ type: "start", interval: 300, deployment: DEP })];
  const lat = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  lat.forEach((l, i) => lines.push(JSON.stringify(S({ baseline: i === 0, latencyMs: l, chain: { ok: true, balance6: 46400 - i * 300, spent6: 3600 + i * 300, leaseUntil: "x", runnerIsBox: true } }))));
  clock += 3 * 300_000;                                          // a 20 min gap (> 2 x interval)
  lines.push(JSON.stringify(S({ ok: false })));
  lines.push(JSON.stringify(S({ ok: false })));
  lines.push("{\"type\":\"sample\",\"t\":\"torn");                // a torn last line is ignored
  // 10 of 12 samples exercised the leak check (83%): under the default 90% floor this could not PASS
  assert.match(summarize(lines).text, /NOT EXERCISED \(10\/12\) leak/);
  const r = summarize(lines, { leakFloor: 0.8 });
  assert.equal(r.pass, true);
  assert.match(r.text, /12 samples/);
  assert.match(r.text, /uptime 83\.3% \(10\/12 verified 200\)/);
  assert.match(r.text, /latency p50 500 ms, p95 1000 ms \(n=10\)/);
  assert.match(r.text, /coverage: 0h45m with no gap longer than 600 s; 1 longer gap\(s\) \(largest 1200 s/);
  assert.match(r.text, /balance6 46400 -> 43700 \(-2700 over 0\.8 h\)/);
  assert.match(r.text, /PASS public/, "two failures in a row are not three");
  for (const th of THRESHOLDS) assert.match(r.text, new RegExp(`(PASS|FAIL) ${th.id}`));
  assert.match(r.text, /VERDICT: PASS/);
  lines.push(JSON.stringify(S({ ok: false })));
  const r2 = summarize(lines);
  assert.match(r2.text, /FAIL public .*1 event\(s\)/);
  assert.match(r2.text, /VERDICT: FAIL/);
  // --since (inclusive) drops the early samples
  const r3 = summarize(lines, { since: new Date(clock - 300_000 * 2).toISOString() });
  assert.match(r3.text, /^hv-soak summary: 3 samples/);
  assert.match(r3.text, /uptime 0\.0% \(0\/3/);
  assert.equal(summarize([]).pass, false);
});

test("summarize re-evaluates from the observations, not from the stored verdicts", () => {
  clock = Date.parse("2026-09-26T05:00:00Z");
  const a = S({ baseline: true }), b = S({ spki: SPKI_B });
  b.verdict = { fail: [], info: [] };                            // a stale verdict must not be trusted
  assert.match(summarize([JSON.stringify(a), JSON.stringify(b)]).text, /FAIL spki/);
});

/* ---------------------------------------------------------------- CLI and the human line */

test("parseArgs: defaults, the derived URL, and the guards", () => {
  const c = parseArgs([]);
  assert.equal(c.url, "https://31136008.app.enclave.host/");
  assert.equal(appUrlFor(DEP), c.url);
  assert.equal(c.interval, 300);
  assert.equal(c.duration, 43200);
  assert.equal(parseArgs(["--duration", "90m"]).duration, 5400);
  assert.equal(parseArgs(["--interval", "5m"]).interval, 300);
  assert.equal(parseArgs(["--no-chain"]).chain, false);
  assert.equal(c.leakFloor, 0.9);
  assert.equal(parseArgs(["--leak-floor", "95%"]).leakFloor, 0.95);
  assert.equal(parseArgs(["--leak-floor", "0.5"]).leakFloor, 0.5);
  for (const bad of ["0", "1.5", "x", "-1"]) assert.throws(() => parseArgs(["--leak-floor", bad]), /leak-floor/);
  // the HEAD probe's marker has NO default: it is the target app's, and it is required with --leak-probe
  assert.equal(c.leakProbe, false);
  assert.equal(c.bodyMarker, null);
  assert.throws(() => parseArgs(["--leak-probe"]), /needs --body-marker/);
  assert.throws(() => parseArgs(["--body-marker", "SENTINEL-X"]), /only used by --leak-probe/);
  assert.throws(() => parseArgs(["--leak-probe", "--body-marker", "ab"]), /at least 4/);
  const lp = parseArgs(["--leak-probe", "--body-marker", "SENTINEL-X"]);
  assert.deepEqual([lp.leakProbe, lp.bodyMarker], [true, "SENTINEL-X"]);
  assert.throws(() => parseArgs(["--interval", "10"]), /at least 30/);
  assert.throws(() => parseArgs(["--deployment", "0x1"]), /64 hex/);
  assert.throws(() => parseArgs(["--console-sec", "10"]), /outlast/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown/);
});

test("humanLine: one line per sample with the verdict under it", () => {
  const st = newSampler();
  const s = { type: "sample", seq: 0, t: "2026-09-26T03:00:00.000Z", deployment: DEP, token: "hvsoakX",
              tls: { ok: false, authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT", cert: { spkiSha256: SPKI_A } },
              relay: parseRelayRow(relayBody(ROW), "nucbox-k11"), chain: { ok: true, balance6: 46400 },
              box: digestBox(boxRes(), st, { deployment: DEP, token: "hvsoakX" }), derived: { spkiEqualsManagerKey: false } };
  const v = step(newEval(), s);
  const h = humanLine(s, v);
  assert.match(h, /^2026-09-26T03:00:00Z #0 \| public TLS DEPTH_ZERO_SELF_SIGNED_CERT spki aaaaaaaaaaaa!=vm \| relay ok hv-node\/attestation/);
  assert.match(h, /vm running hv1210563e 128MiB hv Running free 100\.0GiB/);
  assert.match(h, /node \+12\(baseline\)/);
  assert.match(h, /info spki: SPKI baseline aaaaaaaaaaaaaaaa… \(from an UNVERIFIED leaf\)/);
});
