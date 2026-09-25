// The agent started without ENCLAVE_ENGINE=legacy never touches the retired engine: it never dials the engine's
// port, it reports itself as windows-hv-node, and the enclave-only services answer 503 with the reason
// (enclave-d1 F1). A fake engine port is a listener here; any connection to it fails the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../windows/node/agent.mjs");
const freePort = async () => { const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening"); const p = s.address().port; s.close(); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the agent without the legacy engine never dials the engine port and refuses enclave services", { timeout: 30_000 }, async () => {
  let dialed = 0;
  const enginePort = net.createServer((c) => { dialed++; c.destroy(); });
  enginePort.listen(0, "127.0.0.1"); await once(enginePort, "listening");
  const httpPort = await freePort();
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-agent-"));
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, NODE_DIR: nodeDir, NODE_NAME: "retired-test", RELAY_URL: "none",
    LOCAL_HTTP_PORT: String(httpPort), TPMATTEST_EXE: path.join(nodeDir, "no-tpm-tool"), HOST_PORT: String(enginePort.address().port),
    HOST_EXE: path.join(nodeDir, "no-ee-host"), ENCLAVE_ENGINE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  try {
    let health = null;
    for (let i = 0; i < 50 && !health; i++) {
      await sleep(200);
      health = await fetch(`http://127.0.0.1:${httpPort}/v1/health`).then((r) => r.json()).catch(() => null);
    }
    assert.ok(health, `the agent did not come up: ${out}`);
    assert.equal(health.role, "windows-hv-node");
    assert.equal(health.engine, "retired");
    // /availability names no CPU TEE and no card: the retired engine's name would read as that backend (enclave-99)
    const avail = await fetch(`http://127.0.0.1:${httpPort}/availability`).then((r) => r.json());
    assert.equal(avail.role, "windows-hv-node");
    assert.equal(avail.teeCpu, null);
    assert.equal(avail.shielded, null);
    for (const [method, p] of [["POST", "/v1/completions"], ["GET", "/v1/session/keys"], ["POST", "/v1/session"]]) {
      const r = await fetch(`http://127.0.0.1:${httpPort}${p}`, { method, body: method === "POST" ? "{}" : undefined });
      assert.equal(r.status, 503, p);
      assert.match((await r.json()).reason, /VBS enclave engine is retired/);
    }
    await sleep(1500);
    assert.equal(dialed, 0, "the retired engine's port was dialed");
    assert.match(out, /isolation-only node: the VBS enclave engine is retired/);
    assert.equal(child.exitCode, null, `the agent exited: ${out}`);
  } finally {
    child.kill(); enginePort.close(); fs.rmSync(nodeDir, { recursive: true, force: true });
  }
});
