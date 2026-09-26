// lab.mjs: drives the launcher (vbslike-host lab) over its stdin/stdout line protocol and runs every
// client-side check itself: TLS pinned at the handshake, the verdict from judge-hv.mjs, the app's answer
// (the m2 test app's label), the crossed-domain refusals, crash independence and the lifecycle. Separate
// code from the launcher, by design. Writes <out>/lab.json and prints PASS/FAIL lines in the style of
// isolation/m3/test-m3.sh.
//
//   node verify/lab.mjs --host vbslike-host.exe --kernel K --initrd mon.cpio.gz --apps DIR --out DIR
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import tls from "node:tls";
import { judge, signedReportOf } from "./judge-hv.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
const need = (k) => { if (!args[k]) { console.error(`--${k} required`); process.exit(2); } return args[k]; };
const HOST = need("host"), KERNEL = need("kernel"), INITRD = need("initrd"), APPS = need("apps"), OUT = need("out");
fs.mkdirSync(OUT, { recursive: true });
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
// a bundle's identity is the sha256 of ALL its bytes; its label is in the manifest (isolation/contract)
function bundleInfo(file) {
  const b = fs.readFileSync(file);
  const magic = "ENCLAVE-BUNDLE/1\n";
  let label = null;
  if (b.subarray(0, magic.length).toString() === magic) {
    const ml = b.readUInt32LE(magic.length);
    label = JSON.parse(b.subarray(magic.length + 4, magic.length + 4 + ml).toString()).label;
  }
  return { file, appId: sha256hex(b), label, bytes: b.length };
}
const appA = bundleInfo(path.join(APPS, "appA.bundle")), appB = bundleInfo(path.join(APPS, "appB.bundle"));
const results = [], evidence = { started: new Date().toISOString(), apps: { A: appA, B: appB }, timings: [], memory: {}, verdicts: {}, events: {}, guest: {} };
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}

// --- the launcher process ------------------------------------------------------------------------
const cp = spawn(HOST, ["lab", "--kernel", KERNEL, "--initrd", INITRD, "--out", OUT, "--mem", args.mem || "512", "--cpus", args.cpus || "1"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: cp.stdout });
const queue = [];
const hostLog = [];
rl.on("line", (l) => { if (l.startsWith("{")) { const w = queue.shift(); if (w) w(JSON.parse(l)); else console.log("  (unsolicited)", l); } else { hostLog.push(l); console.log("  host:", l); } });
function ask(cmd) { return new Promise((res) => { queue.push(res); cp.stdin.write(cmd + "\n"); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ps(cmd) { try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8", timeout: 20000 }).trim(); } catch (e) { return "error: " + e.message; } }
function memorySample(tag) {
  const s = { freeKiB: Number(ps("(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory")) || null,
    vmmemWorkingSet: Number(ps("(Get-Process | Where-Object { $_.ProcessName -like 'vmmem*' } | Measure-Object WorkingSet64 -Sum).Sum")) || 0,
    vmwpWorkingSet: Number(ps("(Get-Process vmwp -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum")) || 0,
    hostPrivate: Number(ps("(Get-Process vbslike-host -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum")) || 0 };
  evidence.memory[tag] = s;
  return s;
}
function consoleOf(id, label) { try { return fs.readFileSync(path.join(OUT, `p${id}-${label}.console`), "utf8"); } catch { return ""; } }

// --- the client: TLS pinned at the handshake, the document judged before anything else -----------
function connectPinned(port, expectSpki) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "enclave-domain", minVersion: "TLSv1.3" }, () => {
      const spki = new X509Certificate(s.getPeerCertificate(true).raw).publicKey.export({ type: "spki", format: "der" });
      if (expectSpki && !spki.equals(expectSpki)) { s.destroy(); return reject(new Error("pinned key mismatch at the handshake")); }
      resolve({ s, spki });
    });
    s.on("error", reject);
    s.setTimeout(20000, () => { s.destroy(); reject(new Error("timeout")); });
  });
}
function httpOver(s, method, p, body) {
  return new Promise((resolve, reject) => {
    const b = body ? Buffer.from(body) : null;
    s.write(`${method} ${p} HTTP/1.1\r\nHost: enclave-domain\r\nConnection: close\r\n${b ? `Content-Length: ${b.length}\r\n` : ""}\r\n`);
    if (b) s.write(b);
    const chunks = [];
    s.on("data", (d) => chunks.push(d));
    s.on("end", () => {
      const raw = Buffer.concat(chunks); const i = raw.indexOf("\r\n\r\n");
      const head = raw.toString("latin1", 0, i >= 0 ? i : 0);
      let body = i >= 0 ? raw.subarray(i + 4) : Buffer.alloc(0);
      if (/transfer-encoding:\s*chunked/i.test(head)) { // wasmtime serve streams: decode the chunks
        const parts = []; let p = 0;
        for (;;) { const e = body.indexOf("\r\n", p); if (e < 0) break; const n = parseInt(body.toString("latin1", p, e), 16); if (!(n > 0)) break; parts.push(body.subarray(e + 2, e + 2 + n)); p = e + 2 + n + 2; }
        body = Buffer.concat(parts);
      }
      resolve({ status: Number(head.split(" ")[1]), body });
    });
    s.on("error", reject);
  });
}
async function attest(port, expectSpki) {
  const nonce = randomBytes(32);
  const { s, spki } = await connectPinned(port, expectSpki);
  const r = await httpOver(s, "GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
  let doc = null; try { doc = JSON.parse(r.body.toString()); } catch {}
  return { nonce, spki, doc, status: r.status };
}
async function get(port, spki, p) { const { s } = await connectPinned(port, spki); return httpOver(s, "GET", p); }
async function echo(port, spki, bytes) { const { s } = await connectPinned(port, spki); const r = await httpOver(s, "POST", "/echo", bytes); return r.body; }
async function portClosed(port) { try { await connectPinned(port, null); return false; } catch { return true; } }
async function attestFirst(port, expectSpki, tries = 40) {
  // the front inside the domain comes up moments after the launcher reports "loaded"
  let last;
  for (let i = 0; i < tries; i++) { try { const a = await attest(port, expectSpki); if (a.doc) return a; last = "no document"; } catch (e) { last = e.message; } await sleep(250); }
  throw new Error("domain never served: " + last);
}

// --- the lab -------------------------------------------------------------------------------------
const ready = await new Promise((res) => queue.push(res));
const launcherKey = ready.launcherKey;
console.log(`launcher ready: key=${launcherKey} boundary="${ready.boundary}" initrd=${ready.initrdSha256} kernel=${ready.kernelSha256}`);
evidence.launcher = ready;
const imageSha = sha256hex(fs.readFileSync(INITRD));
check("0 the guest image on this box is byte-identical to the one built beside the Linux path (sha256 of mon.cpio.gz)", imageSha === ready.initrdSha256 && (!args.expectImage || args.expectImage === imageSha), imageSha);
memorySample("before");

console.log("\n1. two apps, one partition each, the SAME guest image in both");
const A = (await ask(`load A ${appA.file}`)).loaded;
const B = (await ask(`load B ${appB.file}`)).loaded;
evidence.A = A; evidence.B = B;
check("1 partition A: the launcher's hash of the bundle it pushed equals the in-guest monitor's hash of what arrived, and it is appA's ID", A && A.appSha256 === appA.appId && A.guest.appSha256 === appA.appId, A ? `${A.ms.total.toFixed(0)} ms, vm ${A.vmId}, guest domain ${A.guestId}` : "load failed");
check("1b partition B: the same for appB, in a different partition", B && B.appSha256 === appB.appId && B.guest.appSha256 === appB.appId && B.vmId !== (A && A.vmId), B ? `${B.ms.total.toFixed(0)} ms, vm ${B.vmId}` : "load failed");
if (A) evidence.timings.push({ domain: "A", ...A.ms }); if (B) evidence.timings.push({ domain: "B", ...B.ms });
memorySample("two-partitions");
const stateTwo = (await ask("state")).state;
check("1c the service lists exactly the two partitions this launcher owns", stateTwo.hcsOwnedByVbslike === 2 && stateTwo.domains === 2, JSON.stringify({ hcs: stateTwo.hcsOwnedByVbslike, domains: stateTwo.domains }));

if (A && B) {
  const gA = (await ask(`guest ${A.id} {"cmd":"list"}`)).guest, gB = (await ask(`guest ${B.id} {"cmd":"list"}`)).guest;
  evidence.guest.A = gA; evidence.guest.B = gB;
  check("1d each in-guest monitor holds exactly its one domain, naming its own app", gA && gA.domains && gA.domains.length === 1 && gA.domains[0].appSha256 === appA.appId && gB && gB.domains && gB.domains.length === 1 && gB.domains[0].appSha256 === appB.appId, JSON.stringify({ A: gA && gA.domains, B: gB && gB.domains }));

  console.log("\n2. each domain attests its own app on its own key, judged against the handshake, signed by the launcher");
  const aA = await attestFirst(A.tcpPort, null), aB = await attestFirst(B.tcpPort, null);
  evidence.attestA = aA.doc; evidence.attestB = aB.doc;
  const jA = judge({ doc: aA.doc, spki: aA.spki, nonce: aA.nonce, expectedAppSha256: appA.appId, launcherKey, expectedVmId: A.vmId, expectedImageSha256: imageSha });
  const jB = judge({ doc: aB.doc, spki: aB.spki, nonce: aB.nonce, expectedAppSha256: appB.appId, launcherKey, expectedVmId: B.vmId, expectedImageSha256: imageSha });
  evidence.verdicts.A = jA; evidence.verdicts.B = jB;
  check("2 domain A: monitor-signed; report_data binds the handshake key + our nonce and names app A, partition A and the shipped image", jA.verdict === "monitor-signed", jA.reasons.join("; "));
  check("2b domain B: the same for app B and partition B", jB.verdict === "monitor-signed", jB.reasons.join("; "));
  check("2c the two domains minted different keys, inside their partitions", !aA.spki.equals(aB.spki));
  const aA2 = await attest(A.tcpPort, aA.spki);
  check("2d a second nonce on a new pinned connection is answered under the same key", judge({ doc: aA2.doc, spki: aA2.spki, nonce: aA2.nonce, expectedAppSha256: appA.appId, launcherKey }).verdict === "monitor-signed");
  check("2e the in-guest boundary tuple travels with the report and says t0-hv, host_excluded=no", typeof aA.doc.boundary === "string" && aA.doc.boundary.includes("tier=t0-hv") && aA.doc.boundary.includes("host_excluded=no"), aA.doc.boundary);

  console.log("\n3. crossed domains are refused: naming is the monitor's, keyed by the partition");
  const jCross = judge({ doc: aA.doc, spki: aA.spki, nonce: aA.nonce, expectedAppSha256: appB.appId, launcherKey });
  check("3 a client expecting app B is REJECTED by the domain running app A", jCross.verdict === "reject", jCross.reasons.join("; "));
  check("3b A's report presented as B's partition is REJECTED", judge({ doc: aA.doc, spki: aA.spki, nonce: aA.nonce, expectedAppSha256: appA.appId, launcherKey, expectedVmId: B.vmId }).verdict === "reject");
  check("3c a report does not satisfy a different nonce", judge({ doc: aA.doc, spki: aA.spki, nonce: randomBytes(32), expectedAppSha256: appA.appId, launcherKey }).verdict === "reject");
  check("3d A's report does not bind B's key", judge({ doc: aA.doc, spki: aB.spki, nonce: aA.nonce, expectedAppSha256: appA.appId, launcherKey }).verdict === "reject");
  const rep = signedReportOf(aA.doc); rep.doc.domain.appSha256 = appB.appId; rep.doc.reportData = rep.doc.reportData.slice(0, 64) + appB.appId;
  const tampered = { ...aA.doc, report: Buffer.from(JSON.stringify(rep)).toString("base64"), appSha256: appB.appId };
  const jTamper = judge({ doc: tampered, spki: aA.spki, nonce: aA.nonce, expectedAppSha256: appB.appId, launcherKey });
  check("3e a host rewriting A's document to name B breaks the launcher's signature (never monitor-signed)", jTamper.verdict !== "monitor-signed" && jTamper.checks["launcher signature verifies"] === false, jTamper.verdict);
  check("3f a report under a launcher key the client does not trust is not monitor-signed", judge({ doc: aA.doc, spki: aA.spki, nonce: aA.nonce, expectedAppSha256: appA.appId, launcherKey: randomBytes(32).toString("base64") }).verdict !== "monitor-signed");

  console.log("\n4. the artifact that was hashed is the one that runs: the m2 test app answers with its compiled-in label");
  const rA = (await get(A.tcpPort, aA.spki, "/hello")).body.toString(), rB = (await get(B.tcpPort, aB.spki, "/hello")).body.toString();
  check("4 app A answers with label AAAAA and app B with BBBBB, each on its own attested key", rA.startsWith(`APP ${appA.label} `) && rB.startsWith(`APP ${appB.label} `), JSON.stringify({ A: rA.trim(), B: rB.trim() }));
  const big = randomBytes(4 << 20);
  const back = await echo(A.tcpPort, aA.spki, big);
  check("4b 4 MiB echoed intact through a partition (TLS ends inside it; the launcher relays ciphertext)", back.equals(big), `${back.length} bytes`);

  console.log("\n5. the adversary inside a partition: native code as root, in the domain (isolation/m3 domprobe)");
  const P = (await ask(`load P ${appA.file} probe`)).loaded;
  let probe = {};
  if (P) { for (let i = 0; i < 60 && !/PROBE\d+ done/.test(consoleOf(P.id, "P")); i++) await sleep(500); const con = consoleOf(P.id, "P"); for (const m of con.matchAll(/^PROBE\d+ (\S+?)=(.*)$/gm)) probe[m[1]] = m[2].trim(); evidence.probeConsole = con.split("\n").filter((l) => /^(PROBE|DOM|MON)/.test(l)); }
  evidence.probe = probe;
  const reach = Object.entries(probe).filter(([k]) => /^(vsock_|tcp_|other_)/.test(k));
  check("5 from inside the partition nothing beyond it is reachable: no other domain's files, no vsock port but its own monitor's, no host network", reach.length >= 6 && reach.every(([, v]) => !/CONNECTED|READABLE/.test(v)), reach.map(([k, v]) => `${k}=${v}`).join("; ") || "no probe output");
  check("5b it cannot reach the report interface directly (no /sys, no configfs in the domain)", probe.configfs_tsm && !/READABLE/.test(probe.configfs_tsm) && probe.create_tsm_entry && !/CREATED/.test(probe.create_tsm_entry), `${probe.configfs_tsm} / ${probe.create_tsm_entry}`);
  check("5c the RUNTIME (the probe, as its uid) is REFUSED a report, unfiltered and filtered: the report channel is the front's alone (enclave-87's ruling)", probe.report === "Permission denied" && probe.filtered_report === "Permission denied" && !probe.report_b64 /* exactly the front's 0700 /run refusing: "no-answer" would mean the socket was REACHED (enclave-5d) */, `${probe.report} / ${probe.filtered_report}`);
  if (P) { await ask(`destroy ${P.id}`); await ask(`wait ${P.id} 30`); }

  console.log("\n6. crash independence: the host terminates partition A without notice; B keeps serving on the same key");
  await ask(`kill ${A.id}`);
  const w = await ask(`wait ${A.id} 30`);
  check("6 a partition that dies is retired by the exit path and leaves the table", w.gone, `${w.ms.toFixed(0)} ms after the kill`);
  let evA = await ask(`events ${A.id}`);
  for (let i = 0; i < 40 && !evA.events.some((e) => e.includes("ended:")); i++) { await sleep(250); evA = await ask(`events ${A.id}`); }
  const endedLines = (evidence.events.A = evA.events).filter((e) => e.includes("ended:"));
  check("6b it ended exactly once, by the partition's exit", endedLines.length === 1 && /partition exited/.test(endedLines[0] || ""), endedLines.join(" | "));
  check("6c A's relay port no longer answers", await portClosed(A.tcpPort));
  const aB2 = await attest(B.tcpPort, aB.spki);
  const jB2 = judge({ doc: aB2.doc, spki: aB2.spki, nonce: aB2.nonce, expectedAppSha256: appB.appId, launcherKey, expectedVmId: B.vmId });
  check("6d B still attests on the same key it had before A died, and still answers", jB2.verdict === "monitor-signed" && aB2.spki.equals(aB.spki) && (await get(B.tcpPort, aB.spki, "/x")).body.toString().startsWith(`APP ${appB.label} `), jB2.reasons.join("; "));
  const stateAfter = (await ask("state")).state;
  check("6e the service lists exactly the one partition still alive", stateAfter.hcsOwnedByVbslike === 1 && stateAfter.domains === 1, JSON.stringify({ hcs: stateAfter.hcsOwnedByVbslike, domains: stateAfter.domains }));
  memorySample("after-kill");

  console.log("\n7. lease end: graceful stop inside the guest, destroy, then the launcher still serves");
  const C = (await ask(`load C ${appA.file}`)).loaded;
  if (C) evidence.timings.push({ domain: "C", ...C.ms });
  const st = C ? await ask(`stop ${C.id}`) : { error: "no C" };
  if (C) await ask(`wait ${C.id} 30`);
  check("7 a graceful stop winds the in-guest domain down (the monitor answers stopped) and the partition is ended", st.guest && st.guest.stopped !== undefined, JSON.stringify(st.guest));
  const dB = await ask(`destroy ${B.id}`); await ask(`wait ${B.id} 30`);
  check("7b destroying B removes its in-guest domain and stops its port answering", dB.guest && dB.guest.destroyed !== undefined && (await portClosed(B.tcpPort)), JSON.stringify(dB.guest));
  const stateEnd = (await ask("state")).state;
  check("7c nothing left behind: no partitions in the table, none owned by this launcher at the service", stateEnd.domains === 0 && stateEnd.hcsOwnedByVbslike === 0, JSON.stringify({ hcs: stateEnd.hcsOwnedByVbslike, domains: stateEnd.domains }));
  const D = (await ask(`load D ${appB.file}`)).loaded;
  if (D) {
    evidence.timings.push({ domain: "D", ...D.ms });
    const aD = await attestFirst(D.tcpPort, null);
    check("7d after those cycles a new partition loads, attests and answers", judge({ doc: aD.doc, spki: aD.spki, nonce: aD.nonce, expectedAppSha256: appB.appId, launcherKey, expectedVmId: D.vmId }).verdict === "monitor-signed");
    memorySample("one-partition-D");
    await ask(`destroy ${D.id}`); await ask(`wait ${D.id} 30`);
  } else check("7d after those cycles a new partition loads, attests and answers", false, "load failed");
  memorySample("end");
}

console.log("\n8. cost (measured, no pass/fail)");
for (const t of evidence.timings) console.log(`  partition ${t.domain}: HCS create ${t.create.toFixed(0)} ms, start ${t.start.toFixed(0)} ms, in-guest monitor answering ${t.monitor.toFixed(0)} ms, app loaded ${t.loaded.toFixed(0)} ms, total ${t.total.toFixed(0)} ms`);
for (const [k, v] of Object.entries(evidence.memory)) console.log(`  memory ${k}: free ${v.freeKiB ? (v.freeKiB / 1024).toFixed(0) : "?"} MiB, vmmem ${(v.vmmemWorkingSet / 1048576).toFixed(0)} MiB, vmwp ${(v.vmwpWorkingSet / 1048576).toFixed(0)} MiB, launcher private ${(v.hostPrivate / 1048576).toFixed(0)} MiB`);

await ask("quit").catch(() => {});
cp.stdin.end();
await sleep(1000);
evidence.results = results; evidence.failures = failures; evidence.hostLog = hostLog; evidence.imageSha256 = imageSha;
fs.writeFileSync(path.join(OUT, "lab.json"), JSON.stringify(evidence, null, 1));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"} (${results.length} checks); evidence in ${path.join(OUT, "lab.json")}`);
process.exit(failures === 0 ? 0 : 1);
