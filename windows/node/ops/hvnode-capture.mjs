// hvnode-capture.mjs - one real windows-hv-node/v1 session, captured on the box for enclave-99's relay verifier
// (relay/hvnode-verify.mjs verifyHvNodeEvidence), without a relay and without a VM.
//
// It drives the box's own tpmattest.exe exactly as agent.mjs does. It plays the RELAY's part of the exchange with
// the relay's own code: the AK name from tpmNameOf(aikPub), a fresh 32-byte credential, and
// makeCredential(ekPublicFrom(ekCert), name, credential), as relay/tunnel.js mints it. It builds the frame with the
// node's own builder (hvnode-evidence.mjs), unchanged.
// It uses a CAPTURE transport key kept in the output directory, never the node's real node-transport.key.
// It touches only what tpmattest already touches: a transient key, credential activation and a quote. It makes no
// TPM ownership, hierarchy or persistent-handle change.
//
//   usage: node windows/node/ops/hvnode-capture.mjs <out dir> [manager base url]
//   env:   TPMATTEST_EXE (default: ../tpmattest.exe beside windows/node)
// writes <out dir>/{frame.json, nonce.hex, capture-spki.b64, expected-credential.hex, minted-for.json, verdict.json}
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHvNodeFrame, loadOrCreateNodeKey } from "../hvnode-evidence.mjs";
import { tpmNameOf } from "../../../relay/vbs-verify.mjs";
import { ekPublicFrom, makeCredential } from "../../../relay/vbs-credential.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [outDir, managerBase] = process.argv.slice(2);
if (!outDir) { console.error("usage: node hvnode-capture.mjs <out dir> [manager base url]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const TPM_EXE = process.env.TPMATTEST_EXE || path.join(HERE, "..", "tpmattest.exe");

// the tpmattest.exe line protocol, as agent.mjs startTpm/tpmCmd speak it
function openTpm(exe) {
  const p = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "", waiters = [], ready;
  const readyP = new Promise((res, rej) => { ready = { res, rej }; setTimeout(() => rej(new Error("tpm tool did not report ready")), 30_000); });
  p.on("error", (e) => ready.rej(e));
  p.stderr.on("data", (d) => process.stderr.write(`[tpm] ${d}`));
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      if (line.startsWith("ready ")) { ready.res(line); continue; }
      const w = waiters[0]; if (!w) continue;
      if (line === "ok" || line.startsWith("err ")) { waiters.shift(); line === "ok" ? w.res(w.lines) : w.rej(new Error(line)); }
      else { const sp = line.indexOf(" "); if (sp > 0) w.lines[line.slice(0, sp)] = line.slice(sp + 1); }
    }
  });
  const cmd = (c) => new Promise((res, rej) => { waiters.push({ lines: {}, res, rej }); p.stdin.write(c + "\n"); });
  return { readyP, cmd, close: () => p.kill() };
}

const tpm = openTpm(TPM_EXE);
try {
  console.log(`tpm: ${await tpm.readyP}`);
  const keys = await tpm.cmd("keys");
  const ekCert = Buffer.from(keys["ek-cert"], "hex"), aikPub = Buffer.from(keys["aik-pub"], "hex");
  // the relay's part: the name it computes and the credential it mints (relay/tunnel.js vbs-keys)
  const aikName = tpmNameOf(aikPub);
  if (keys["aik-name"] && !aikName.equals(Buffer.from(keys["aik-name"], "hex"))) throw new Error("the tool's aik-name is not 0x000B || sha256(aikPub)");
  const credential = randomBytes(32);
  const { credentialBlob, secret } = makeCredential(ekPublicFrom(ekCert), aikName, credential);
  const nonce = randomBytes(32);
  const { spki, privateKey } = loadOrCreateNodeKey(outDir, { file: "capture-transport.key" });
  let managerHealth = null;
  if (managerBase) managerHealth = await fetch(`${managerBase.replace(/\/+$/, "")}/health`).then((r) => r.json()).catch(() => null);
  const frame = await buildHvNodeFrame({ nonce, credentialBlob, secret, spki, privateKey, tpm: tpm.cmd, managerHealth,
                                         platform: { capture: "hvnode-capture.mjs", note: "a capture key, not the node's" } });
  fs.writeFileSync(path.join(outDir, "frame.json"), JSON.stringify(frame, null, 1));
  fs.writeFileSync(path.join(outDir, "nonce.hex"), nonce.toString("hex"));
  fs.writeFileSync(path.join(outDir, "capture-spki.b64"), spki.toString("base64"));
  fs.writeFileSync(path.join(outDir, "expected-credential.hex"), credential.toString("hex"));
  fs.writeFileSync(path.join(outDir, "minted-for.json"), JSON.stringify({ ekCert: ekCert.toString("base64"), aikName: aikName.toString("hex") }));
  console.log(`captured: ${outDir}/frame.json (nonce ${nonce.toString("hex").slice(0, 16)}...)`);

  // enclave-99's verifier, if this tree carries it (it is on main as relay/hvnode-verify.mjs)
  const verifier = path.join(HERE, "..", "..", "..", "relay", "hvnode-verify.mjs");
  if (fs.existsSync(verifier)) {
    const { verifyHvNodeEvidence } = await import(pathToFileURL(verifier).href);
    const evidence = JSON.parse(Buffer.from(frame.rad.body, "base64"));
    const ekRoots = path.join(HERE, "..", "..", "..", "relay", "fixtures", "tpm-roots.pem");
    const v = verifyHvNodeEvidence({ evidence, nonce, transportKeySpki: spki, expectedCredential: credential, mintedFor: { ekCert, aikName } },
                                   { ekRoots: fs.readFileSync(ekRoots, "utf8") });
    fs.writeFileSync(path.join(outDir, "verdict.json"), JSON.stringify(v, null, 1));
    console.log(`relay verifier: ok=${v.ok} tier=${v.tier ?? "-"} failed=${(v.checks || []).filter((c) => !c.ok).map((c) => c.name).join(" | ") || "none"}`);
  } else console.log("relay/hvnode-verify.mjs is not in this tree: send the files to enclave-99");
} finally { tpm.close(); }
