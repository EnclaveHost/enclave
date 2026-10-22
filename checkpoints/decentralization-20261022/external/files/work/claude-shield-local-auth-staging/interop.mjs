// STAGING ONLY (minipc, C:\Users\claude\enclave-staging\claude-shield-local-auth): the manager's REAL package and custody
// servers behind the REAL shielded-bridge, over Hyper-V socket loopback (no partition, no registry, test ports 9983/9984),
// with other local callers' connections first. Prints one JSON verdict.
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { servePackage, packageFrame } from "./manager/package-transport.mjs";
import { serveCustodyRequests, custodyAnswerLine } from "./manager/custody-transport.mjs";
import { mintBridgeCredential, bridgeAuthLine, BRIDGE_AUTH_FLAG } from "./manager/bridge-auth.mjs";
const REL = process.argv[2], BR = path.join(REL, "shielded-bridge.exe"), CHECK = path.join(REL, "bridge-auth-check.exe");
const LOOP = "e0e16197-dd56-4a10-9195-5ee7a155a838", DEP = "0x" + "e7".repeat(32), VAULT = "0x" + "c1".repeat(20), B = "11".repeat(32);
const out = {};
const hostile = async (port, n) => { for (let i = 0; i < n; i++) await new Promise((r) => { const c = net.connect(port, "127.0.0.1", () => { if (i % 2) c.write(`custody-auth-v2 ${VAULT} ${DEP} ${B}\n`); }); c.on("close", r); c.on("error", r); }); };
async function bridge(port, workerPort, credential) {
  const c = spawn(BR, [LOOP, String(port), String(workerPort), "0", BRIDGE_AUTH_FLAG], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  c.stdin.write(bridgeAuthLine(credential));
  let text = ""; c.stderr.on("data", (b) => { text += b; });
  const ready = await new Promise((ok, no) => { c.stdout.on("data", (b) => { text += b; if (/shielded bridge ready/.test(text)) ok(text); }); c.on("exit", (x) => no(new Error(`bridge exited ${x}: ${text}`))); setTimeout(() => no(new Error("no ready")), 10000); });
  return { c, ready, output: () => text };
}
const dial = (port, send = "") => new Promise((ok) => { const p = spawn(CHECK, ["--dial", String(port), Buffer.from(send).toString("hex")], { windowsHide: true }); let t = ""; p.stdout.on("data", (b) => { t += b; }); p.on("exit", () => { const m = /read (\d+) hex ([0-9a-f]*)/.exec(t); ok(m ? Buffer.from(m[2], "hex") : null); }); });
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };
// 1. package
{
  const credential = mintBridgeCredential(), frame = packageFrame(DEP, Buffer.from('{"version":1,"staging":true}'));
  const s = await servePackage(frame, { credential, maxServes: 2, authTimeoutMs: 500 });
  await hostile(s.port, 30);
  out.packageServedAfterHostile = s.served();
  const b = await bridge(9983, s.port, credential);
  const got = await dial(9983);
  out.packageGuestGotFrame = !!got && got.equals(frame);
  out.packageServed = s.served();
  out.packageGate = s.gate();
  out.packageReadyHasCredential = b.output().includes(credential);
  b.c.stdin.end(); await new Promise((r) => b.c.on("exit", r)); await s.close();
}
// 2. custody
{
  const credential = mintBridgeCredential();
  const s = await serveCustodyRequests({ deploymentId: DEP, vault: VAULT, credential, maxRequests: 2, authTimeoutMs: 500 });
  await hostile(s.port, 30);
  out.custodyAfterHostile = { requests: s.stats().requests, pending: s.pending().length, refused: s.stats().refused };
  const b = await bridge(9984, s.port, credential);
  const asked = dial(9984, `custody-auth-v2 ${VAULT} ${DEP} ${B}\n`);
  const p = await until(() => s.pending()[0]);
  const auth = { binding: B, endpoint: "https://staging.invalid", sig: "0x" + "ab".repeat(65), expiry: Math.floor(Date.now() / 1000) + 300 };
  if (p) s.answer(p.request, auth);
  const got = await asked;
  out.custodyGuestGotAnswer = !!got && got.toString() === custodyAnswerLine(auth);
  out.custodyStats = s.stats();
  out.custodyReadyHasCredential = b.output().includes(credential);
  b.c.stdin.end(); await new Promise((r) => b.c.on("exit", r)); await s.close();
}
console.log(JSON.stringify(out));
