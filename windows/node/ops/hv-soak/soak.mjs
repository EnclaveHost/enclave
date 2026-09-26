#!/usr/bin/env node
// soak.mjs - a READ-ONLY soak monitor for the NucBox isolated-app test deployment (hv-node, T0-hv, host NOT excluded).
//
//   node soak.mjs [--interval 300] [--duration 12h] [--out <file.jsonl>] [--no-chain] ...   the loop
//   node soak.mjs --once [--out <file.jsonl>]                                                one sample, to test with
//   node soak.mjs --summary <file.jsonl> [--since <ISO time>]                                PASS/FAIL per threshold
//
// Every INTERVAL it takes ONE sample and appends it as one JSONL line:
//   1. public TLS: ONE GET of https://<id8>.app.enclave.host/hv-soak/<token> with the token also in a header, over a
//      connection whose chain and hostname are VERIFIED (Node's CA store). A connection that fails verification is
//      recorded (its leaf's SPKI sha256, serial, issuer and the reason) and dropped: no response on it is read or counted.
//      With --leak-probe, ONE HEAD to the same URL: the ACTIVE leak probe. An app that never logs (hello-world) makes the
//      token unseeable, so the target is a SENTINEL app that prints "-STDOUT-REQ <path> <x-hv-soak>" to stdout and stderr
//      per request and answers HEAD with a body carrying a marker. The HEAD makes the front handle a body it must drop:
//      an old front logs it ("Unsolicited response ... starting with "<body>""), the fixed one logs "DOM front:
//      unsolicited upstream response (N bytes withheld)". The token, the body marker (--body-marker, no default) or a
//      -STDOUT-REQ line anywhere in the console or a log is a LEAK.
//   2. the relay's public row for the node (GET <relay>/enclaves, unauthenticated).
//   3. the box, over ONE ssh session: the manager's /vms, Hyper-V's view of the manager's VMs, host memory, the node and
//      manager logs FROM THE LAST SAMPLE'S OFFSET, and the deployment's COM1 console, read for a short window while the
//      GET and the HEAD are in flight (both go out at the box's READY line). The script is fed on stdin to a short -EncodedCommand bootstrap: nothing is written
//      to the box, and nothing on it is changed (no restart, no config, no install).
//   4. optionally the deployment's ledger row (balance), with ONE eth_call to a public Base RPC.
// The token is random per sample and is not a secret: any sight of it in the console or in either log is a LEAK.
// Console and log line CONTENTS are never stored or printed; console lines are reported as a count and sha256s.
//
// Thresholds (FAIL): see THRESHOLDS below; README.md has the rationale.
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULTS = Object.freeze({
  deployment: "0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3",
  node: "nucbox-k11",
  relay: "https://api.enclave.host",
  ssh: "minipc-zt",
  root: "C:\\Users\\claude\\vbs-like\\hvnode",          // ROLLOUT.md: hvnode\logs\node.log, manager.log
  managerPort: 8091,
  interval: 300,
  duration: 12 * 3600,
  // the ledger (windows/node/chain.mjs DEP_ABI get(bytes32)) and this box's registry id = keccak(PUBLIC_URL)
  deployments: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a",
  enclaveId: "0xd497d065ca395192db3630699dbc5a6418f2f028256212a4d9ab73288643fe1b",
  rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  tlsTimeoutMs: 20_000,
  httpTimeoutMs: 20_000,
  consoleSec: 25,            // the console window, from READY; longer than tlsTimeoutMs so the request lands inside it
  consoleMaxBytes: 1 << 20,
  leakProbe: false,          // --leak-probe: the HEAD probe; it needs --body-marker (no default: the target app's own marker)
  bodyMarker: null,
  logCapBytes: 4 << 20,      // per log per sample; a longer backlog is read over the following samples
  sshTimeoutMs: 150_000,
  readyTimeoutMs: 60_000,
});

// get(bytes32) on the deployments ledger: keccak256("get(bytes32)")[0..4], computed with viem's toFunctionSelector
export const GET_SELECTOR = "0x8eaa6ac0";
// a console line that is the guest's own: the monitor (MON), a domain's init (DOM, DOM1...) or a kernel timestamp
export const CONSOLE_OK = /^(DOM|MON)|^\[ *[0-9]+\.[0-9]+\]/;
export const THRESHOLDS = Object.freeze([
  { id: "public", text: ">=3 consecutive public checks not 200 over verified TLS" },
  { id: "spki", text: "the public leaf's SPKI changed with no restart of the deployment in the node log" },
  { id: "partition", text: "the deployment's partition not Running on 2 consecutive samples" },
  { id: "price", text: "the node's 'registry: card price now' (price tx) line count increased" },
  { id: "leak", text: "a console line that is not DOM/MON/kernel, or the token, the body marker or a -STDOUT-REQ line in the console or a log" },
  { id: "box", text: "the ssh/box read failing on >=3 consecutive samples (INFO below that)" },
  { id: "relay", text: "relay row not (hv-node, attestation, hostExcluded false, owner-only) on >=3 consecutive samples; hostExcluded true ever" },
]);

const HEX64 = /^0x[0-9a-f]{64}$/;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const trunc = (s, n = 200) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
export const appUrlFor = (id) => `https://${String(id).slice(2, 10)}.app.enclave.host/`;
export const id10 = (id) => String(id).toLowerCase().slice(0, 10);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------------------------ public TLS */

/** The leaf's facts: SPKI sha256 (DER SubjectPublicKeyInfo), serial, issuer, subject, validity. */
export function certFacts(x509) {
  if (!x509) return null;
  const spki = x509.publicKey.export({ type: "spki", format: "der" });
  const flat = (s) => String(s || "").split("\n").filter(Boolean).join(", ");
  return { spkiSha256: sha256(spki), serial: x509.serialNumber, issuer: flat(x509.issuer), subject: flat(x509.subject),
           validFrom: x509.validFrom, validTo: x509.validTo };
}

/**
 * ONE GET over a VERIFIED connection. rejectUnauthorized is false only so the leaf of a connection that FAILS
 * verification can still be recorded; Node still verifies the chain and the hostname and reports it on the socket,
 * and such a connection is destroyed at secureConnect, before any response is read. ok = verified AND 200.
 */
export function tlsCheck(url, { method = "GET", timeoutMs = DEFAULTS.tlsTimeoutMs, headers = {}, ca, maxBody = 65536 } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number((process.hrtime.bigint() - t0) / 1_000_000n);
    const out = { ok: false, status: null, latencyMs: null, authorized: null, authorizationError: null, error: null,
                  bytes: null, cert: null };
    let done = false, timer = null, req = null;
    const finish = (extra = {}) => {
      if (done) return;
      done = true; clearTimeout(timer);
      Object.assign(out, extra);
      if (out.latencyMs === null) out.latencyMs = ms();
      out.ok = out.authorized === true && out.status === 200 && !out.error;
      resolve(out);
    };
    try {
      req = https.request(url, { method, agent: false, rejectUnauthorized: false, ...(ca ? { ca } : {}),
                                 headers: { "user-agent": "enclave-hv-soak/1", accept: "*/*", ...headers } }, (res) => {
        out.status = res.statusCode;
        let n = 0;
        res.on("data", (c) => { n += c.length; if (n > maxBody) res.destroy(); });
        res.on("end", () => finish({ bytes: n, latencyMs: ms() }));
        res.on("error", (e) => finish({ bytes: n, error: `response: ${e.message}` }));
        res.on("close", () => finish({ bytes: n, latencyMs: ms() }));
      });
    } catch (e) { finish({ error: e.message }); return; }
    timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    req.on("socket", (sock) => {
      sock.once("secureConnect", () => {
        out.authorized = sock.authorized === true;
        out.authorizationError = sock.authorized ? null : String(sock.authorizationError || "unauthorized");
        try { out.cert = certFacts(sock.getPeerX509Certificate()); } catch (e) { out.cert = { error: e.message }; }
        if (!out.authorized) req.destroy(new Error(`TLS verification failed: ${out.authorizationError}`));
      });
    });
    req.on("error", (e) => finish({ error: e.code && !String(e.message).includes(e.code) ? `${e.code}: ${e.message}` : e.message }));
    req.end();
  });
}

/* ------------------------------------------------------------------ relay row */

/** The node's row in the relay's /enclaves answer, and whether it is what an owner-only hv-node row must be. */
export function parseRelayRow(body, name) {
  const rows = body && Array.isArray(body.enclaves) ? body.enclaves : null;
  if (!rows) return { ok: false, error: "the answer has no enclaves array" };
  const r = rows.find((e) => e && e.name === name);
  if (!r) return { ok: false, present: false, updatedAt: body.updatedAt ?? null };
  const h = r.hvNode || {}, a = r.availability || {};
  const updated = Date.parse(body.updatedAt || "");
  const f = {
    present: true, mode: r.mode ?? null, tier: r.tier ?? null, attach: r.attach ?? null, tunnel: r.tunnel === true,
    hostExcluded: h.hostExcluded ?? null, claimScope: a.claimScope ?? null,
    owners: Array.isArray(a.owners) ? a.owners.map((o) => String(o).toLowerCase()) : null,
    lastSeen: r.lastSeen ?? null,
    lastSeenAgeSec: Number.isFinite(updated) && Number.isFinite(r.lastSeen) ? Math.round(updated / 1000 - r.lastSeen) : null,
    eligible: r.eligible ?? null, serving: r.serving ?? null, ineligible: trunc(r.ineligible ?? null, 160),
    verifiedAt: h.verifiedAt ?? null, appsRunning: a.apps?.running ?? null, updatedAt: body.updatedAt ?? null,
  };
  f.attached = f.tunnel && f.attach === "attestation";
  f.ok = f.mode === "hv-node" && f.tier === "hv-node" && f.attached && f.hostExcluded === false && f.claimScope === "owner-only";
  return f;
}

async function relayRead(cfg) {
  try {
    const r = await fetch(`${cfg.relay}/enclaves`, { signal: AbortSignal.timeout(cfg.httpTimeoutMs), headers: { accept: "application/json" } });
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` };
    return parseRelayRow(await r.json(), cfg.node);
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------------------------------------------------ chain (optional) */

export const encodeGetCall = (id) => GET_SELECTOR + String(id).slice(2).toLowerCase().padStart(64, "0");

/** The static head fields of get(bytes32)'s tuple (DEP_ABI order); the strings are dynamic and not read. */
export function decodeDeployment(hex, enclaveId = DEFAULTS.enclaveId) {
  const h = String(hex || "").replace(/^0x/, "");
  if (h.length < 64 * 18) throw new Error(`short eth_call result (${h.length / 2} bytes)`);
  const word = (i) => h.slice(64 * i, 64 * i + 64);
  const base = Number(BigInt("0x" + word(0))) / 32;            // the tuple's offset (it has dynamic members)
  const u = (i) => BigInt("0x" + word(base + i));
  return { owner: "0x" + word(base + 1).slice(24), active: u(9) !== 0n, rate: Number(u(11)), balance6: Number(u(12)),
           spent6: Number(u(13)), runnerIsBox: ("0x" + word(base + 14)).toLowerCase() === String(enclaveId).toLowerCase(),
           leaseUntil: new Date(Number(u(16)) * 1000).toISOString() };
}

async function chainRead(cfg, st) {
  // ONE request per sample; a failure moves the next sample to the next RPC
  const rpc = cfg.rpcs[st.rpc % cfg.rpcs.length];
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(cfg.httpTimeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: cfg.deployments, data: encodeGetCall(cfg.deployment) }, "latest"] }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return { ok: true, rpc: new URL(rpc).host, ...decodeDeployment(j.result, cfg.enclaveId) };
  } catch (e) { st.rpc++; return { ok: false, rpc: new URL(rpc).host, error: trunc(e.message) }; }
}

/* ------------------------------------------------------------------ the box: script, ssh, digest */

/**
 * The PowerShell run on the box, READ-ONLY: GETs from the manager's loopback /vms, Get-VM, Get-VMComPort,
 * Win32_OperatingSystem, two log files opened for READ with sharing, and the deployment's COM1 pipe opened as a
 * client for reading, only when the manager's record is `running` with its start-time capture done (`guest` present),
 * so it can never take the pipe from a start that is still attaching to it.
 */
export function boxScript({ root, managerPort, deployment, nodeFrom, managerFrom, cap, consoleSec, consoleMaxBytes }) {
  if (!/^[A-Za-z]:\\[A-Za-z0-9 ._\\-]+$/.test(String(root))) throw new Error(`refusing an unexpected root path ${root}`);
  if (!HEX64.test(String(deployment).toLowerCase())) throw new Error("the deployment id must be 0x + 64 hex");
  for (const [k, v] of Object.entries({ managerPort, nodeFrom, managerFrom, cap, consoleSec, consoleMaxBytes }))
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer, not ${v}`);
  return String.raw`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$Root = '${root}'; $Port = ${managerPort}; $Dep = '${String(deployment).toLowerCase()}'
$NodeFrom = [long]${nodeFrom}; $MgrFrom = [long]${managerFrom}; $Cap = [long]${cap}; $ConSec = ${consoleSec}; $ConMax = ${consoleMaxBytes}
function Emit([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Chunk([string]$p, [long]$from) {
  try {
    $fs = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      $size = $fs.Length; $reset = $false
      if ($from -gt $size) { $reset = $true; $from = 0 }
      if ($from -lt 0) { $from = 0 }
      $n = [int][Math]::Min($Cap, $size - $from)
      $buf = New-Object byte[] $n; [void]$fs.Seek($from, [IO.SeekOrigin]::Begin); $got = 0
      while ($got -lt $n) { $r = $fs.Read($buf, $got, $n - $got); if ($r -le 0) { break }; $got += $r }
      if ($got -lt $n) { $b2 = New-Object byte[] $got; [Array]::Copy($buf, $b2, $got); $buf = $b2 }
      return @{ ok = $true; size = $size; from = $from; reset = $reset; b64 = [Convert]::ToBase64String($buf) }
    } finally { $fs.Close() }
  } catch { return @{ ok = $false; error = [string]$_.Exception.Message } }
}
$o = [ordered]@{ v = 1; t0 = [DateTime]::UtcNow.ToString('o') }
$vmsText = $null
try {
  $vmsText = [string](Invoke-WebRequest -Uri "http://127.0.0.1:$Port/vms" -TimeoutSec 20 -UseBasicParsing).Content
  $o.vms = @{ ok = $true; b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($vmsText)) }
} catch { $o.vms = @{ ok = $false; error = [string]$_.Exception.Message } }
$con = [ordered]@{ attempted = $false; connected = $false; note = '' }; $cli = $null
try {
  if ($vmsText) {
    $recs = @((ConvertFrom-Json $vmsText).vms | Where-Object { ([string]$_.name).ToLower() -eq $Dep })
    $run = @($recs | Where-Object { $_.status -eq 'running' -and $_.guest })
    if ($run.Count -eq 1) {
      $vmName = [string]$run[0].vmName; $con.vmName = $vmName
      if ($vmName -notmatch '^enclave-app-[A-Za-z0-9-]{1,80}$') { throw 'the record names an unexpected VM' }
      $pipe = [string](Get-VMComPort -VMName $vmName -Number 1).Path; $con.pipe = $pipe
      if ($pipe -notmatch '^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,120}$') { throw 'COM1 is not a local named pipe' }
      $con.attempted = $true
      $cli = New-Object System.IO.Pipes.NamedPipeClientStream('.', ($pipe -replace '^\\\\\.\\pipe\\', ''), [System.IO.Pipes.PipeDirection]::In, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $cli.Connect(3000); $con.connected = $true
    } else { $con.note = "no single running record with its start capture done ($($recs.Count) record(s), $($run.Count) running)" }
  } else { $con.note = 'no /vms answer, so no record names a console' }
} catch { $con.note = [string]$_.Exception.Message; if ($cli) { try { $cli.Dispose() } catch {} }; $cli = $null }
Emit ('HVSOAK1-READY ' + $(if ($con.connected) { 'console' } else { 'noconsole' }))
$ms = New-Object System.IO.MemoryStream; $con.truncated = $false
if ($cli) {
  $cts = New-Object System.Threading.CancellationTokenSource; $cts.CancelAfter($ConSec * 1000); $pending = $null
  try {
    $buf = New-Object byte[] 4096
    while (-not $cts.IsCancellationRequested) {
      if ($null -eq $pending) { $pending = $cli.ReadAsync($buf, 0, $buf.Length) }
      if (-not $pending.Wait(500)) { continue }
      $n = $pending.Result; $pending = $null
      if ($n -le 0) { $con.note = 'the pipe closed'; break }
      $room = [int][Math]::Min($n, $ConMax - $ms.Length)
      if ($room -gt 0) { $ms.Write($buf, 0, $room) }
      if ($room -lt $n) { $con.truncated = $true }
    }
  } catch { $con.note = [string]$_.Exception.Message } finally { try { $cli.Dispose() } catch {}; $cts.Dispose() }
}
$con.b64 = [Convert]::ToBase64String($ms.ToArray()); $o.console = $con
try {
  $list = @(Get-VM | Where-Object { $_.Name -like 'enclave-app-*' } | ForEach-Object { @{ name = $_.Name; state = [string]$_.State; memMiB = [long]($_.MemoryAssigned / 1MB); uptimeSec = [long]$_.Uptime.TotalSeconds } })
  $o.hv = @{ ok = $true; vms = $list }
} catch { $o.hv = @{ ok = $false; error = [string]$_.Exception.Message } }
try { $os = Get-CimInstance Win32_OperatingSystem; $o.mem = @{ ok = $true; freeKB = [long]$os.FreePhysicalMemory; totalKB = [long]$os.TotalVisibleMemorySize } }
catch { $o.mem = @{ ok = $false; error = [string]$_.Exception.Message } }
$o.node = Chunk (Join-Path $Root 'logs\node.log') $NodeFrom
$o.manager = Chunk (Join-Path $Root 'logs\manager.log') $MgrFrom
Emit ('HVSOAK1 ' + ($o | ConvertTo-Json -Compress -Depth 6))
`;
}

// the bootstrap (well under cmd.exe's 8191-character command line) reads the script from ssh's stdin
export const BOOTSTRAP = "$ProgressPreference='SilentlyContinue'; $s=[Console]::In.ReadToEnd(); & ([scriptblock]::Create($s))";
export const remoteCommand = () =>
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(BOOTSTRAP, "utf16le").toString("base64")}`;

/** The last `HVSOAK1 {...}` line of the box's stdout. */
export function parseBoxStdout(stdout) {
  const line = String(stdout).split(/\r?\n/).reverse().find((l) => l.startsWith("HVSOAK1 "));
  if (!line) return { ok: false, error: "no HVSOAK1 line in the box's output" };
  try { return { ok: true, data: JSON.parse(line.slice(8)) }; } catch (e) { return { ok: false, error: `unparseable box JSON: ${e.message}` }; }
}

/**
 * ONE ssh session. onReady(trigger) fires at the READY line ("console" when the console is connected, else
 * "noconsole"), or with "fallback" when the session ends or stalls without one.
 */
function runBox(cfg, script, onReady) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = "", err = "", readyMs = null, fired = false, settled = false;
    const fire = (trigger) => { if (!fired) { fired = true; onReady(trigger); } };
    const ch = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
                             "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR", cfg.ssh, remoteCommand()],
                     { stdio: ["pipe", "pipe", "pipe"] });
    const readyTimer = setTimeout(() => fire("fallback"), cfg.readyTimeoutMs);
    const killTimer = setTimeout(() => { try { ch.kill("SIGKILL"); } catch {} }, cfg.sshTimeoutMs);   // this child's own PID
    ch.stdout.on("data", (d) => {
      out += d;
      const m = readyMs === null && out.match(/(^|\n)HVSOAK1-READY (\w+)/);
      if (m) { readyMs = Date.now() - t0; fire(m[2] === "console" ? "console" : "noconsole"); }
    });
    ch.stderr.on("data", (d) => { if (err.length < 8192) err += d; });
    const end = (code, spawnErr) => {
      if (settled) return; settled = true;
      clearTimeout(readyTimer); clearTimeout(killTimer); fire("fallback");
      const p = parseBoxStdout(out);
      const ready = out.match(/(^|\n)HVSOAK1-READY (\w+)/);
      const errText = err.replace(/#< CLIXML[\s\S]*/, "").trim();
      resolve({ ms: Date.now() - t0, exit: code, readyMs, ready: ready ? ready[2] : null,
                ...(p.ok ? { ok: true, data: p.data } : { ok: false, error: spawnErr || [p.error, trunc(errText, 300)].filter(Boolean).join("; ") }) });
    };
    ch.on("error", (e) => end(null, `ssh: ${e.message}`));
    ch.on("close", (code) => end(code));
    ch.stdin.on("error", () => {});
    ch.stdin.end(script);
  });
}

/** The complete lines of a log chunk read from `from`, and the offset to read from next (after the last newline). */
export function consumeChunk(chunk) {
  const buf = Buffer.from(chunk.b64 || "", "base64");
  const last = buf.lastIndexOf(0x0a);
  const used = last < 0 ? 0 : last + 1;
  return { text: buf.subarray(0, used).toString("utf8"), next: Number(chunk.from) + used, bytes: used, pendingBytes: buf.length - used };
}

/** Counts over the new node/manager log lines; only the restart and price lines are kept (truncated), nothing else. */
export function scanLog(text, { deployment, token = null, marker = null }) {
  const d10 = id10(deployment);
  const restartRe = new RegExp(`${reEsc(d10)} (isolation spawned|isolated domain retired|isolation respawn)|config edit ${reEsc(d10)}: .*relaunching`);
  const c = { lines: 0, errorLines: 0, refusLines: 0, cardPrice: 0, renewed: 0, renewedMine: 0, notRenewed: 0, renewFailed: 0,
              restart: 0, procRestarts: 0, tokenHits: 0, markerHits: 0, sentinelLines: 0, restartLines: [], cardPriceLines: [] };
  for (const raw of String(text).split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (!l.trim()) continue;
    c.lines++;
    if (/error/i.test(l)) c.errorLines++;
    if (/refus/i.test(l)) c.refusLines++;
    if (l.includes("registry: card price now")) { c.cardPrice++; if (c.cardPriceLines.length < 5) c.cardPriceLines.push(trunc(l)); }
    if (/renewed 0x/.test(l)) c.renewed++;
    if (l.includes(`renewed ${d10}`)) c.renewedMine++;
    if (/not renewed/i.test(l)) c.notRenewed++;
    if (/ renew failed/.test(l)) c.renewFailed++;
    if (restartRe.test(l)) { c.restart++; if (c.restartLines.length < 5) c.restartLines.push(trunc(l)); }
    if (/\[run\] \S+ exited/.test(l)) c.procRestarts++;
    if (token && l.includes(token)) c.tokenHits++;
    if (marker && l.includes(marker)) c.markerHits++;
    if (l.includes(SENTINEL)) c.sentinelLines++;
  }
  return c;
}

// the FIXED front's line when an app sends a body on HEAD: the probe reached the front and nothing leaked
export const WITHHELD = /unsolicited upstream response \(\d+ bytes withheld\)/;
// the sentinel app's own stdout/stderr line per request: seen outside the app, it is app output that crossed over
export const SENTINEL = "-STDOUT-REQ";

/**
 * The console window's lines: any line that is not the guest's own is counted and hashed, never kept. The token and
 * the body marker are searched for in the raw text (a sighting is a leak); a `withheld` line is the fixed front saying
 * it dropped the HEAD probe's body, counted as proof the probe reached the front.
 */
export function consoleScan(buf, { token = null, marker = null, allow = CONSOLE_OK } = {}) {
  const text = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf || "");
  const parts = text.split("\n");
  const tail = parts.pop();                                        // after the last newline: a partial line
  const bad = [];
  let lines = 0, withheld = 0;
  for (const raw of parts) {
    const l = raw.replace(/\r$/, "");
    if (!l.trim()) continue;
    lines++;
    if (WITHHELD.test(l)) withheld++;
    if (!allow.test(l)) bad.push(sha256(Buffer.from(l, "latin1")));
  }
  const count = (needle) => (needle ? text.split(needle).length - 1 : 0);
  return { bytes: Buffer.byteLength(text, "latin1"), lines, nonMatching: bad.length, nonMatchingSha256: bad.slice(0, 50),
           partialTailBytes: Buffer.byteLength(tail || "", "latin1"), tokenHits: count(token), markerHits: count(marker),
           sentinelLines: count(SENTINEL), withheld };
}

/** The deployment's records in /vms, and the current one (running, else starting, else the last). */
export function pickDeploymentVm(body, deployment) {
  const vms = Array.isArray(body?.vms) ? body.vms : [];
  const mine = vms.filter((v) => String(v?.name || "").toLowerCase() === String(deployment).toLowerCase());
  const cur = mine.find((v) => v.status === "running") || mine.find((v) => v.status === "starting") || mine[mine.length - 1] || null;
  return { count: vms.length, forDeployment: mine.length, mine: cur };
}

const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

/**
 * Turn the box's raw answer into the sample's `box` block, advancing the log offsets and the last-seen instance in
 * `st`. Pure apart from `st`, so it is tested against fake answers.
 */
export function digestBox(res, st, { deployment, token, marker = null }) {
  const box = { ok: false, ssh: { ok: !!res.ok, exit: res.exit ?? null, ms: res.ms ?? null, readyMs: res.readyMs ?? null,
                                  ...(res.ok ? {} : { error: trunc(res.error, 400) }) } };
  if (!res.ok) return box;
  const d = res.data || {};
  let mine = null;
  if (d.vms && d.vms.ok) {
    try {
      const pick = pickDeploymentVm(JSON.parse(Buffer.from(d.vms.b64 || "", "base64").toString("utf8")), deployment);
      mine = pick.mine;
      box.vms = { ok: true, count: pick.count, forDeployment: pick.forDeployment, mine: mine && {
        id: mine.id ?? null, instanceId: mine.instanceId ?? null, status: mine.status ?? null, vmName: mine.vmName ?? null,
        memMiB: mine.policy?.memMiB ?? null, tier: mine.tier ?? null, hostExcluded: mine.hostExcluded ?? null,
        transportKeySha256: mine.transportKeySha256 ?? null, startedAt: mine.startedAt ?? null, recovered: mine.recovered === true,
        managerEpoch: mine.managerEpoch ?? null, reason: trunc(mine.reason ?? null, 200) } };
    } catch (e) { box.vms = { ok: false, error: `the /vms answer is not JSON: ${e.message}` }; }
  } else box.vms = { ok: false, error: trunc(d.vms?.error ?? "no /vms section", 300) };

  const hvList = d.hv && d.hv.ok ? asArray(d.hv.vms) : null;
  box.hv = d.hv && d.hv.ok ? { ok: true, vms: hvList.length } : { ok: false, error: trunc(d.hv?.error ?? "no Hyper-V section", 300) };
  box.mem = d.mem && d.mem.ok ? { ok: true, freeMiB: Math.round(d.mem.freeKB / 1024), totalMiB: Math.round(d.mem.totalKB / 1024) }
                              : { ok: false, error: trunc(d.mem?.error ?? "no memory section", 300) };

  if (box.vms.ok) {
    const hvVm = hvList && mine?.vmName ? hvList.find((v) => v.name === mine.vmName) || null : undefined;
    const running = !!mine && mine.status === "running" && (hvVm === undefined || (hvVm !== null && hvVm.state === "Running"));
    const instance = mine?.id ?? null;
    box.partition = { running, status: mine ? mine.status : "absent", instance,
                      instanceChanged: st.instance !== undefined && instance !== st.instance,
                      vmState: hvVm === undefined ? null : hvVm ? hvVm.state : "absent",
                      vmMemMiB: hvVm ? hvVm.memMiB : null, vmUptimeSec: hvVm ? hvVm.uptimeSec : null };
    st.instance = instance;
  } else box.partition = { running: null };

  box.logs = {};
  for (const k of ["node", "manager"]) {
    const ch = d[k];
    if (!ch || !ch.ok) { box.logs[k] = { ok: false, error: trunc(ch?.error ?? `no ${k} log section`, 300) }; continue; }
    const baseline = st.offsets[k] === 0 && !st.baselined[k];
    const c = consumeChunk(ch);
    st.offsets[k] = c.next; st.baselined[k] = true;
    const sc = scanLog(c.text, { deployment, token, marker });
    // the baseline read is the log's HISTORY, from before this soak's probes: a marker there is reported, not judged
    if (baseline) { sc.markerHitsHistory = sc.markerHits; sc.markerHits = 0; sc.sentinelLinesHistory = sc.sentinelLines; sc.sentinelLines = 0; }
    box.logs[k] = { ok: true, baseline, reset: ch.reset === true, size: ch.size, bytes: c.bytes, pendingBytes: c.pendingBytes, ...sc };
  }

  const con = d.console || {};
  const cs = consoleScan(Buffer.from(con.b64 || "", "base64"), { token, marker });
  box.console = { attempted: con.attempted === true, connected: con.connected === true, ready: res.ready ?? null,
                  note: trunc(con.note || null, 200), vmName: con.vmName ?? null, truncated: con.truncated === true, ...cs };
  // a console the deployment's running partition should have and that could not be read is a failed box read
  const consoleOwed = box.partition.running === true;
  box.ok = box.vms.ok && box.logs.node.ok && box.logs.manager.ok && (!consoleOwed || box.console.connected);
  return box;
}

/* ------------------------------------------------------------------ thresholds (one reducer, live and in --summary) */

export function newEval() {
  return { n: 0, streak: { public: 0, partition: 0, box: 0, relay: 0 }, worst: { public: 0, partition: 0, box: 0, relay: 0 },
           spki: { baseline: null, pendingRestartSeq: null, deferred: null }, price: { baseline: null, added: 0 }, events: [] };
}

/** Apply one sample; returns { fail: [[id, msg]], info: [[id, msg]] } and records FAILs in ev.events. */
export function step(ev, s) {
  const seq = ev.n++;
  const fail = [], info = [];
  const bump = (k, bad, at, msg, infoMsg) => {
    if (bad === null) return;
    if (!bad) { ev.streak[k] = 0; return; }
    ev.streak[k]++; ev.worst[k] = Math.max(ev.worst[k], ev.streak[k]);
    if (ev.streak[k] === at) fail.push([k, msg(ev.streak[k])]);
    else info.push([k, infoMsg(ev.streak[k])]);
  };

  // public
  const t = s.tls || {};
  const why = t.status != null && t.authorized ? `HTTP ${t.status}` : t.authorized === false ? `TLS ${t.authorizationError}` : trunc(t.error || "no answer", 80);
  bump("public", t.ok !== true, 3, (n) => `${n} consecutive public checks not 200 (last: ${why})`, (n) => `public check not OK (${why}); ${n} in a row`);

  // SPKI: baseline at the first presented leaf; a change needs a restart of the deployment in the node log
  const node = s.box?.logs?.node;
  const evidence = node && node.ok ? (!node.baseline && node.restart > 0) : null;     // null = the log was not read
  const sp = ev.spki, cur = t.cert?.spkiSha256 || null;
  if (evidence === true) sp.pendingRestartSeq = seq;
  if (sp.deferred && evidence !== null) {
    if (evidence) info.push(["spki", `the SPKI change at sample ${sp.deferred.seq} is explained by a restart read now`]);
    else fail.push(["spki", `SPKI changed to ${sp.deferred.spki.slice(0, 16)}… at sample ${sp.deferred.seq} with no restart of the deployment in the node log`]);
    sp.deferred = null;
  }
  if (cur) {
    if (!sp.baseline) { sp.baseline = cur; info.push(["spki", `SPKI baseline ${cur.slice(0, 16)}…${t.authorized ? "" : " (from an UNVERIFIED leaf)"}`]); }
    else if (cur !== sp.baseline) {
      const was = sp.baseline; sp.baseline = cur;
      if (evidence === true || sp.pendingRestartSeq !== null) {
        info.push(["spki", `SPKI ${was.slice(0, 16)}… -> ${cur.slice(0, 16)}… after a recorded restart: re-baselined`]);
        sp.pendingRestartSeq = null;
      } else if (evidence === null) {
        sp.deferred = { seq, spki: cur };
        info.push(["spki", `SPKI ${was.slice(0, 16)}… -> ${cur.slice(0, 16)}… while the node log was unreadable: judged at the next read`]);
      } else fail.push(["spki", `SPKI changed ${was.slice(0, 16)}… -> ${cur.slice(0, 16)}… with no restart of the deployment in the node log`]);
    } else if (sp.pendingRestartSeq !== null && seq > sp.pendingRestartSeq) sp.pendingRestartSeq = null;   // restarted, key kept
  }

  // partition
  const run = s.box?.partition?.running;
  bump("partition", run === true ? false : run === false ? true : null, 2,
       (n) => `the partition is not Running on ${n} consecutive samples (${s.box.partition.status}, VM ${s.box.partition.vmState ?? "?"})`,
       () => `the partition is not Running (${s.box.partition.status}, VM ${s.box.partition.vmState ?? "?"})`);
  if (run === null || run === undefined) info.push(["partition", "the partition's state is unknown this sample (the box read failed)"]);

  // price tx
  if (node && node.ok) {
    if (node.baseline) { ev.price.baseline = node.cardPrice; info.push(["price", `card-price line baseline ${node.cardPrice}`]); }
    else if (node.cardPrice > 0) { ev.price.added += node.cardPrice; fail.push(["price", `${node.cardPrice} new 'registry: card price now' line(s): a price tx`]); }
  }

  // leak
  const con = s.box?.console, mgr = s.box?.logs?.manager;
  const hits = (con?.tokenHits || 0) + (node?.tokenHits || 0) + (mgr?.tokenHits || 0);
  if (hits > 0) fail.push(["leak", `the sample's token appeared ${hits} time(s) (console ${con?.tokenHits || 0}, node.log ${node?.tokenHits || 0}, manager.log ${mgr?.tokenHits || 0})`]);
  const marks = (con?.markerHits || 0) + (node?.markerHits || 0) + (mgr?.markerHits || 0);
  if (marks > 0) fail.push(["leak", `the app's body marker appeared ${marks} time(s) (console ${con?.markerHits || 0}, node.log ${node?.markerHits || 0}, manager.log ${mgr?.markerHits || 0})`]);
  const sent = (con?.sentinelLines || 0) + (node?.sentinelLines || 0) + (mgr?.sentinelLines || 0);
  if (sent > 0) fail.push(["leak", `${sent} sentinel '-STDOUT-REQ' line(s): the app's own output (console ${con?.sentinelLines || 0}, node.log ${node?.sentinelLines || 0}, manager.log ${mgr?.sentinelLines || 0})`]);
  if (con?.withheld > 0) info.push(["leak", `${con.withheld} 'bytes withheld' line(s): the HEAD probe reached the front and its body was dropped`]);
  if (con && con.nonMatching > 0) fail.push(["leak", `${con.nonMatching} console line(s) that are not DOM/MON/kernel (sha256 ${con.nonMatchingSha256.slice(0, 3).map((h) => h.slice(0, 12)).join(", ")}…)`]);
  if (s.box?.partition?.running === true && con && !con.connected) info.push(["leak", `no console coverage this sample: ${con.note || "not connected"}`]);

  // box
  const boxBad = s.box?.ok !== true;
  const boxWhy = !s.box?.ssh?.ok ? `ssh: ${trunc(s.box?.ssh?.error, 120)}` : !s.box.vms?.ok ? `/vms: ${trunc(s.box.vms?.error, 120)}`
    : !s.box.logs?.node?.ok ? `node.log: ${trunc(s.box.logs?.node?.error, 120)}` : !s.box.logs?.manager?.ok ? `manager.log: ${trunc(s.box.logs?.manager?.error, 120)}`
    : `console: ${trunc(s.box.console?.note, 120)}`;
  bump("box", boxBad, 3, (n) => `the box read failed on ${n} consecutive samples (${boxWhy})`, (n) => `box read failed (${boxWhy}); ${n} in a row`);

  // relay
  const rl = s.relay || {};
  const rlWhy = rl.error ? trunc(rl.error, 100) : rl.present === false ? "no row" : `mode ${rl.mode} tier ${rl.tier} attach ${rl.attach} hostExcluded ${rl.hostExcluded} scope ${rl.claimScope}`;
  bump("relay", rl.ok !== true, 3, (n) => `the relay row is wrong on ${n} consecutive samples (${rlWhy})`, (n) => `relay row not OK (${rlWhy}); ${n} in a row`);
  if (rl.hostExcluded === true) fail.push(["relay", "the relay row claims hostExcluded TRUE: this tier never excludes the host"]);

  for (const [id, msg] of fail) ev.events.push({ seq, t: s.t, id, msg });
  return { fail, info };
}

/**
 * A sample EXERCISED the leak check when a leak could have been seen in it: the partition ran, the token request was
 * delivered (a verified 200), the HEAD probe went out over verified TLS inside the connected console window and was
 * answered, the console was read around both, and both logs were read. The token alone proves nothing for an app that
 * never logs (hello-world writes nothing to the console); the HEAD probe makes the front handle a body it must not
 * pass on. A sample that is not exercised proves nothing either way, so the summary never lets `leak` PASS on coverage
 * below LEAK_FLOOR.
 */
export const LEAK_FLOOR = 0.9;
export const exercised = (s) => s.box?.partition?.running === true && s.tls?.ok === true && s.head?.sentInWindow === true
  && s.box?.console?.connected === true && s.box?.logs?.node?.ok === true && s.box?.logs?.manager?.ok === true;
/** The HEAD probe counts only when it was fired by a READY with the console connected, verified, and answered. */
export const headSentInWindow = (trigger, head) => trigger === "console" && head?.authorized === true && head?.status != null;

/* ------------------------------------------------------------------ summary */

const pct =(sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null);
const dur = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`; };

/** Re-evaluate a JSONL file's samples from scratch. -> { text, pass }; pass only when every threshold PASSes. */
export function summarize(lines, { since = null, interval = null, leakFloor = LEAK_FLOOR } = {}) {
  const recs = [];
  for (const l of lines) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* a torn last line */ } }
  const head = recs.find((r) => r.type === "start");
  let samples = recs.filter((r) => r.type === "sample").sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (since) samples = samples.filter((r) => Date.parse(r.t) >= Date.parse(since));
  const out = [];
  if (!samples.length) return { text: "no samples", pass: false };
  const times = samples.map((r) => Date.parse(r.t));
  const diffs = times.slice(1).map((x, i) => x - times[i]);
  const iv = (interval || head?.interval || (diffs.length ? [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)] / 1000 : DEFAULTS.interval)) * 1000;
  let best = 0, runStart = 0;
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > 2 * iv) { gaps.push({ at: samples[i - 1].t, ms: times[i] - times[i - 1] }); runStart = i; }
    best = Math.max(best, times[i] - times[runStart]);
  }
  const ev = newEval();
  for (const s of samples) step(ev, s);
  const ok = samples.filter((s) => s.tls?.ok === true);
  const lat = ok.map((s) => s.tls.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const known = samples.filter((s) => typeof s.box?.partition?.running === "boolean");
  const chain = samples.filter((s) => s.chain?.ok);
  const sum = (f) => samples.reduce((a, s) => a + (f(s) || 0), 0);
  const nl = (s) => (s.box?.logs?.node?.ok && !s.box.logs.node.baseline ? s.box.logs.node : null);

  out.push(`hv-soak summary: ${samples.length} samples ${samples[0].t} .. ${samples[samples.length - 1].t} (span ${dur(times[times.length - 1] - times[0])})`
           + `${since ? ` since ${since}` : ""}; interval ${iv / 1000} s; deployment ${head?.deployment || samples[0].deployment || "?"}`);
  out.push(`coverage: ${dur(best)} with no gap longer than ${2 * iv / 1000} s; ${gaps.length} longer gap(s)`
           + (gaps.length ? ` (largest ${Math.round(Math.max(...gaps.map((g) => g.ms)) / 1000)} s, first after ${gaps[0].at})` : ""));
  out.push(`public: uptime ${(100 * ok.length / samples.length).toFixed(1)}% (${ok.length}/${samples.length} verified 200); `
           + `latency p50 ${pct(lat, 50) ?? "-"} ms, p95 ${pct(lat, 95) ?? "-"} ms (n=${lat.length})`);
  out.push(`partition: Running in ${known.filter((s) => s.box.partition.running).length}/${known.length} samples with a known state; `
           + `instance changes ${samples.filter((s) => s.box?.partition?.instanceChanged).length}`);
  out.push(`node log: renewals ${sum((s) => nl(s)?.renewedMine)} for the deployment (${sum((s) => nl(s)?.renewed)} all), not-renewed ${sum((s) => nl(s)?.notRenewed)}, `
           + `restart lines ${sum((s) => nl(s)?.restart)}, process restarts ${sum((s) => nl(s)?.procRestarts)}, error lines ${sum((s) => nl(s)?.errorLines)}, refus lines ${sum((s) => nl(s)?.refusLines)}; `
           + `card-price lines baseline ${ev.price.baseline ?? "?"}, added ${ev.price.added}`);
  out.push(`console: ${samples.filter((s) => s.box?.console?.connected).length}/${samples.length} samples read, `
           + `${sum((s) => s.box?.console?.lines)} lines, ${sum((s) => s.box?.console?.nonMatching)} not DOM/MON/kernel`);
  const ex = samples.filter(exercised).length, exShare = ex / samples.length;
  const leakCovered = ex >= 1 && exShare >= leakFloor;
  out.push(`leak check: exercised in ${ex}/${samples.length} samples (${(100 * exShare).toFixed(1)}%; floor ${(100 * leakFloor).toFixed(1)}%): `
           + "partition running, a verified 200 carrying the token, the HEAD probe sent inside the console window, the console and both logs read");
  out.push(`HEAD probe: sent inside the console window in ${samples.filter((s) => s.head?.sentInWindow === true).length}/${samples.length} samples; `
           + `'bytes withheld' lines ${sum((s) => s.box?.console?.withheld)} (in ${samples.filter((s) => s.box?.console?.withheld > 0).length} samples: the probe reached the front); `
           + `body-marker sightings ${sum((s) => (s.box?.console?.markerHits || 0) + (s.box?.logs?.node?.markerHits || 0) + (s.box?.logs?.manager?.markerHits || 0))}, `
           + `sentinel '-STDOUT-REQ' lines ${sum((s) => (s.box?.console?.sentinelLines || 0) + (s.box?.logs?.node?.sentinelLines || 0) + (s.box?.logs?.manager?.sentinelLines || 0))}; `
           + `in the logs' history before the soak: marker ${sum((s) => (s.box?.logs?.node?.markerHitsHistory || 0) + (s.box?.logs?.manager?.markerHitsHistory || 0))}, `
           + `sentinel ${sum((s) => (s.box?.logs?.node?.sentinelLinesHistory || 0) + (s.box?.logs?.manager?.sentinelLinesHistory || 0))}`
           + (samples.some((s) => s.head?.skipped) ? `; the probe was OFF in ${samples.filter((s) => s.head?.skipped).length} samples (--leak-probe not given)` : ""));
  if (chain.length) {
    const a = chain[0].chain, b = chain[chain.length - 1].chain;
    const h = (Date.parse(chain[chain.length - 1].t) - Date.parse(chain[0].t)) / 3.6e6;
    out.push(`chain: balance6 ${a.balance6} -> ${b.balance6} (${b.balance6 - a.balance6 >= 0 ? "+" : ""}${b.balance6 - a.balance6} over ${h.toFixed(1)} h), `
             + `spent6 ${a.spent6} -> ${b.spent6}, lease until ${b.leaseUntil}, runner is this box: ${b.runnerIsBox}`);
  } else out.push("chain: no successful reads");
  out.push("thresholds:");
  let failed = 0, unproven = 0;
  for (const th of THRESHOLDS) {
    const evs = ev.events.filter((e) => e.id === th.id);
    // a leak seen anywhere FAILs; no leak seen PASSes only on enough exercised samples, else it is NOT EXERCISED
    const word = evs.length ? "FAIL" : th.id === "leak" && !leakCovered ? `NOT EXERCISED (${ex}/${samples.length})` : "PASS";
    if (evs.length) failed++; else if (word !== "PASS") unproven++;
    const worst = ev.worst[th.id] !== undefined ? ` (worst streak ${ev.worst[th.id]})` : "";
    const exNote = th.id === "leak" ? ` [exercised ${ex}/${samples.length}, floor ${(100 * leakFloor).toFixed(1)}%]` : "";
    out.push(`  ${word} ${th.id.padEnd(9)} ${th.text}${worst}${exNote}`
             + (evs.length ? `: ${evs.length} event(s); first ${evs[0].t}: ${evs[0].msg}` : ""));
  }
  const pass = failed === 0 && unproven === 0;
  out.push(`VERDICT: ${failed ? "FAIL" : unproven ? "NOT PASS (the leak check was not exercised enough to pass)" : "PASS"}`);
  return { text: out.join("\n"), pass };
}

/* ------------------------------------------------------------------ one sample, the loop, the CLI */

export function newSampler() {
  return { seq: 0, rpc: 0, offsets: { node: 0, manager: 0 }, baselined: { node: false, manager: false }, instance: undefined };
}

async function takeSample(cfg, st) {
  const seq = st.seq++;
  const t = new Date().toISOString();
  const token = "hvsoak" + crypto.randomBytes(16).toString("hex");
  const url = new URL(cfg.url);
  url.pathname = `/hv-soak/${token}`;
  const script = boxScript({ root: cfg.root, managerPort: cfg.managerPort, deployment: cfg.deployment, nodeFrom: st.offsets.node,
                             managerFrom: st.offsets.manager, cap: cfg.logCapBytes, consoleSec: cfg.consoleSec, consoleMaxBytes: cfg.consoleMaxBytes });
  // At the box's READY, inside the console window: the token GET and ONE HEAD probe, both over verified TLS. The HEAD
  // makes the app send a body the front must drop; a leaky front logs it, a fixed one logs that it was withheld.
  let probes = null;
  const startProbes = (trigger = "fallback") => (probes ||= { trigger,
    get: tlsCheck(url.href, { timeoutMs: cfg.tlsTimeoutMs, headers: { "x-hv-soak": token } }),
    head: cfg.leakProbe ? tlsCheck(url.href, { method: "HEAD", timeoutMs: cfg.tlsTimeoutMs, headers: { "x-hv-soak": token } }) : null });
  const relayP = relayRead(cfg);
  const chainP = cfg.chain ? chainRead(cfg, st) : Promise.resolve({ skipped: true });
  const res = await runBox(cfg, script, startProbes);
  const p = startProbes();
  const [tls, head] = await Promise.all([p.get, p.head]);
  const marker = cfg.leakProbe ? cfg.bodyMarker : null;
  const box = digestBox(res, st, { deployment: cfg.deployment, token, marker });
  const s = { type: "sample", v: 1, seq, t, tEnd: new Date().toISOString(), deployment: cfg.deployment, token, bodyMarker: marker,
              tls: { url: url.href, trigger: p.trigger, ...tls },
              head: head ? { method: "HEAD", trigger: p.trigger, ...head, sentInWindow: headSentInWindow(p.trigger, head) }
                         : { method: "HEAD", skipped: "--leak-probe is off", sentInWindow: false },
              relay: await relayP, chain: await chainP, box };
  const mk = box.vms?.mine?.transportKeySha256;
  s.derived = { spkiEqualsManagerKey: tls.cert?.spkiSha256 && mk ? tls.cert.spkiSha256 === mk : null };
  s.derived.leakExercised = exercised(s);           // informational; --summary recomputes it from the observations
  return s;
}

export function humanLine(s, v) {
  const t = s.tls, b = s.box || {}, r = s.relay || {}, n = b.logs?.node, m = b.logs?.manager, c = b.console;
  const pub = t.ok ? `200 ${t.latencyMs}ms` : t.status != null && t.authorized ? `HTTP ${t.status}` : t.authorized === false ? `TLS ${t.authorizationError}` : `ERR ${trunc(t.error, 60)}`;
  const parts = [
    `${s.t.slice(0, 19)}Z #${s.seq}`,
    `public ${pub}${t.cert?.spkiSha256 ? ` spki ${t.cert.spkiSha256.slice(0, 12)}` : ""}${s.derived?.spkiEqualsManagerKey === true ? "=vm" : s.derived?.spkiEqualsManagerKey === false ? "!=vm" : ""}`,
    `relay ${r.ok ? "ok" : "NOT ok"}${r.present ? ` ${r.mode}/${r.attach} hx=${r.hostExcluded} ${r.claimScope} eligible=${r.eligible} serving=${r.serving}` : r.error ? ` ${trunc(r.error, 60)}` : " no row"}`,
    b.ssh?.ok ? `box ${b.ok ? "ok" : "PARTIAL"} ${Math.round((b.ssh.ms || 0) / 100) / 10}s vm ${b.partition?.status ?? "?"}${b.vms?.mine ? ` ${String(b.vms.mine.id).slice(0, 10)} ${b.vms.mine.memMiB}MiB` : ""} hv ${b.partition?.vmState ?? "?"} free ${b.mem?.ok ? (b.mem.freeMiB / 1024).toFixed(1) + "GiB" : "?"}`
              : `box FAIL ${trunc(b.ssh?.error, 80)}`,
    n?.ok ? `node +${n.lines}${n.baseline ? "(baseline)" : ""} err ${n.errorLines} refus ${n.refusLines} price ${n.cardPrice} renew ${n.renewedMine}/${n.renewed} notRenewed ${n.notRenewed} restart ${n.restart}` : "node log ?",
    m?.ok ? `mgr +${m.lines} err ${m.errorLines} refus ${m.refusLines}` : "mgr log ?",
    `head ${!s.head ? "?" : s.head.skipped ? "off" : (s.head.status != null && s.head.authorized ? `${s.head.status}` : s.head.authorized === false ? `TLS ${s.head.authorizationError}`
      : `ERR ${trunc(s.head.error, 40)}`) + (s.head.sentInWindow ? " in-window" : " NOT in window")}`,
    c ? `console ${c.connected ? `${c.lines} lines, ${c.nonMatching} not-own, withheld ${c.withheld || 0}` : `none (${trunc(c.note, 50)})`} `
        + `token ${(c.tokenHits || 0) + (n?.tokenHits || 0) + (m?.tokenHits || 0)} marker ${(c.markerHits || 0) + (n?.markerHits || 0) + (m?.markerHits || 0)}`
        + ` sentinel ${(c.sentinelLines || 0) + (n?.sentinelLines || 0) + (m?.sentinelLines || 0)}` : "console ?",
    `leak check ${exercised(s) ? "exercised" : "NOT exercised"}`,
    s.chain?.ok ? `bal6 ${s.chain.balance6}` : s.chain?.skipped ? "" : `chain ?`,
  ].filter(Boolean);
  const tail = [...v.fail.map(([id, msg]) => `FAIL ${id}: ${msg}`), ...v.info.map(([id, msg]) => `info ${id}: ${msg}`)];
  return parts.join(" | ") + (tail.length ? "\n    " + tail.join("\n    ") : "");
}

function parseDuration(x) {
  const m = String(x).match(/^(\d+(?:\.\d+)?)(h|m|s)?$/);
  if (!m) throw new Error(`bad duration ${x}`);
  return Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2] || "s"]);
}

export function parseArgs(argv) {
  const cfg = { ...DEFAULTS, rpcs: [...DEFAULTS.rpcs], chain: true, once: false, summary: null, since: null, out: null, url: null,
                leakFloor: LEAK_FLOOR };
  const rpcs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case "--once": cfg.once = true; break;
      case "--summary": cfg.summary = v(); break;
      case "--since": cfg.since = v(); break;
      case "--interval": cfg.interval = parseDuration(v()); break;
      case "--duration": cfg.duration = parseDuration(v()); break;
      case "--out": cfg.out = v(); break;
      case "--deployment": cfg.deployment = v().toLowerCase(); break;
      case "--url": cfg.url = v(); break;
      case "--node": cfg.node = v(); break;
      case "--relay": cfg.relay = v().replace(/\/+$/, ""); break;
      case "--ssh": cfg.ssh = v(); break;
      case "--root": cfg.root = v(); break;
      case "--console-sec": cfg.consoleSec = parseInt(v(), 10); break;
      case "--leak-probe": cfg.leakProbe = true; break;
      case "--body-marker": cfg.bodyMarker = v(); if (cfg.bodyMarker.length < 4) throw new Error("--body-marker must be at least 4 characters"); break;
      case "--leak-floor": {
        const x = String(v()), f = x.endsWith("%") ? Number(x.slice(0, -1)) / 100 : Number(x);
        if (!(f > 0 && f <= 1)) throw new Error(`--leak-floor must be a fraction in (0, 1] or a percentage, not ${x}`);
        cfg.leakFloor = f; break;
      }
      case "--rpc": rpcs.push(v()); break;
      case "--no-chain": cfg.chain = false; break;
      case "-h": case "--help": cfg.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (rpcs.length) cfg.rpcs = rpcs;
  if (cfg.leakProbe && !cfg.bodyMarker) throw new Error("--leak-probe needs --body-marker: the marker the target app puts in its HEAD body (there is no default)");
  if (cfg.bodyMarker && !cfg.leakProbe) throw new Error("--body-marker is only used by --leak-probe");
  if (!HEX64.test(cfg.deployment)) throw new Error("--deployment must be 0x + 64 hex");
  if (!cfg.url) cfg.url = appUrlFor(cfg.deployment);
  if (!(cfg.interval >= 30)) throw new Error("--interval must be at least 30 s");
  if (cfg.consoleSec * 1000 <= cfg.tlsTimeoutMs) throw new Error("--console-sec must outlast the public request's timeout (20 s)");
  return cfg;
}

const USAGE = `usage:
  node soak.mjs [--interval 300] [--duration 12h] [--out FILE.jsonl] [--no-chain]   the loop (default OUT ~/enclave-bench/nucbox-soak/<start>.jsonl)
  node soak.mjs --once [--out FILE.jsonl]                                           one sample, printed (appended to FILE only if --out is given)
  node soak.mjs --summary FILE.jsonl [--since ISO] [--leak-floor 0.9]              per threshold; exit 1 unless every one PASSes
options: --deployment 0x.. --url https://.. --node nucbox-k11 --relay https://api.enclave.host --ssh minipc-zt
         --root C:\\Users\\claude\\vbs-like\\hvnode --console-sec 25 --rpc URL (repeatable)
         --leak-floor F: the share of samples that must EXERCISE the leak check for it to PASS (default 0.9; "90%" works)
         --leak-probe --body-marker S: send ONE HEAD per sample inside the console window and treat S (the target app's
             HEAD-body marker; no default) anywhere in the console or a log as a leak. Without it the leak check cannot PASS`;

async function main() {
  let cfg;
  try { cfg = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exitCode = 2; return; }
  if (cfg.help) { console.log(USAGE); return; }
  if (cfg.summary) {
    const r = summarize(fs.readFileSync(cfg.summary, "utf8").split("\n"), { since: cfg.since, leakFloor: cfg.leakFloor });
    console.log(r.text);
    process.exitCode = r.pass ? 0 : 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = cfg.out || (cfg.once ? null : path.join(os.homedir(), "enclave-bench", "nucbox-soak", `${stamp}.jsonl`));
  if (out) fs.mkdirSync(path.dirname(out), { recursive: true });
  const write = (o) => { if (out) fs.appendFileSync(out, JSON.stringify(o) + "\n"); };
  const header = { type: "start", t: new Date().toISOString(), v: 1, interval: cfg.interval, duration: cfg.duration, leakFloor: cfg.leakFloor,
                   leakProbe: cfg.leakProbe, bodyMarker: cfg.bodyMarker, deployment: cfg.deployment,
                   url: cfg.url, node: cfg.node, relay: cfg.relay, ssh: cfg.ssh, root: cfg.root, chain: cfg.chain, pid: process.pid, once: cfg.once };
  write(header);
  const st = newSampler(), ev = newEval();

  if (cfg.once) {
    const s = await takeSample(cfg, st);
    s.verdict = step(ev, s);
    write(s);
    console.log(JSON.stringify(s, null, 2));
    console.log(humanLine(s, s.verdict));
    process.exitCode = s.verdict.fail.length ? 1 : 0;
    return;
  }

  console.log(`hv-soak: ${cfg.deployment} every ${cfg.interval} s for ${cfg.duration} s -> ${out} (pid ${process.pid})`);
  let stopping = false, wake = null;
  const stop = (sig) => { if (!stopping) console.log(`hv-soak: ${sig}: stopping after the current sample`); stopping = true; if (wake) wake(); };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  const start = Date.now();
  for (let k = 0; !stopping; ) {
    const due = start + k * cfg.interval * 1000;
    if (due - Date.now() > 0) {
      let timer = null;
      await new Promise((r) => { wake = r; timer = setTimeout(r, due - Date.now()); });
      clearTimeout(timer);
    }
    wake = null;
    if (stopping || Date.now() - start >= cfg.duration * 1000) break;
    let s;
    try { s = await takeSample(cfg, st); }
    catch (e) { s = { type: "sample", v: 1, seq: st.seq, t: new Date().toISOString(), deployment: cfg.deployment, error: `sampler: ${e.message}`,
                      tls: { ok: false, error: "not run" }, relay: { ok: false, error: "not run" }, box: { ok: false, ssh: { ok: false, error: "not run" } } }; }
    s.verdict = step(ev, s);
    write(s);
    console.log(humanLine(s, s.verdict));
    k = Math.floor((Date.now() - start) / (cfg.interval * 1000)) + 1;     // a slow sample skips its missed slots
  }
  write({ type: "end", t: new Date().toISOString(), samples: st.seq });
  console.log(summarize(fs.readFileSync(out, "utf8").split("\n"), { leakFloor: cfg.leakFloor }).text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`hv-soak: ${e.stack || e.message}`); process.exitCode = 2; });
}
