// The raw attestation document's paths (relay/attestation-paths.mjs): ONE module names them, the supervisor serves the
// document under each and advertises the alias today's relays pass, and no other source spells the alias.
// (The relay side, an ineligible box's allowlist, is test/relay-u7-eligible-routing.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootDaemon } from "./helpers/daemon.mjs";
import * as P from "../relay/attestation-paths.mjs";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the module names the canonical path and the exact wire bytes deployed verifiers request", () => {
  assert.equal(P.CANONICAL_RAD_PATH, "/.well-known/enclave-attestation");
  // protocol compatibility: the path production supervisors serve and advertise and the deployed relays allow
  assert.equal(P.LEGACY_RAD_PATH, "/.well-known/tinfoil-attestation");
  assert.deepEqual([...P.RAD_PATHS], [P.CANONICAL_RAD_PATH, P.LEGACY_RAD_PATH]);
  assert.ok(Object.isFrozen(P.RAD_PATHS));
  assert.equal(P.ADVERTISED_RAD_PATH, P.LEGACY_RAD_PATH);
  for (const p of P.RAD_PATHS) assert.equal(p, p.toLowerCase(), "the relay compares lower-cased canonical paths");
});

test("no other source spells the alias; the supervisor and the relay take the paths from the module", () => {
  const alias = P.LEGACY_RAD_PATH.slice("/.well-known/".length);
  const allowed = new Set(["relay/attestation-paths.mjs", "test/attestation-route.test.mjs"]);
  const generated = /(\.bundle\.mjs$|(^|\/)dist\/|^site\/vendor\/|^network\/host-services\/packages\/)/;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!["node_modules", ".git"].includes(e.name)) walk(rel); continue; }
      if (!e.isFile() || !/\.(m?js|cjs|ts|json|md|html|py|sh|go|rs|sol|txt)$/.test(e.name) || generated.test(rel) || allowed.has(rel)) continue;
      if (fs.readFileSync(path.join(REPO, rel), "utf8").includes(alias)) hits.push(rel);
    }
  };
  walk("");
  assert.deepEqual(hits, []);
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8"), relay = fs.readFileSync(path.join(REPO, "relay/api-relay.js"), "utf8");
  assert.match(sup, /^import \{ RAD_PATHS, ADVERTISED_RAD_PATH \} from "\.\/relay\/attestation-paths\.mjs";$/m);
  assert.match(sup, /^app\.get\(RAD_PATHS, /m);
  assert.match(sup, /attestationEndpoint: \(origin \|\| ""\) \+ ADVERTISED_RAD_PATH,/);
  assert.match(relay, /^import \{ RAD_PATHS \} from "\.\/attestation-paths\.mjs";$/m);
  assert.match(relay, /"\/v1\/attestation", \.\.\.RAD_PATHS, "\/v1\/host\/capacity"\]\);/);
  assert.doesNotMatch(sup + relay, /Cloud Provider-attestation|\bRAD_PATH\b/);
  // the published supervisor image ships the module beside net-guard (test/supervisor-image-closure.test.mjs checks the rest)
  assert.match(fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8"), /^COPY relay\/net-guard\.mjs relay\/attestation-paths\.mjs \.\/relay\/$/m);
});

test("the supervisor serves the same document under both paths and advertises the alias", async (t) => {
  const doc = { format: "sev-snp-guest-metal-v1", body: Buffer.from("report").toString("base64") };
  let fetched = 0;
  const rad = http.createServer((req, res) => {           // the guest agent's loopback document (ATTESTATION_URL)
    fetched++;
    res.writeHead(req.url === "/.well-known/enclave-attestation" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  });
  await new Promise((r) => rad.listen(0, "127.0.0.1", r));
  t.after(() => rad.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rad-route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const PUBLIC = "https://relay.test/t/box1";
  const { child, port } = await bootDaemon({
    start: (p) => spawn(process.execPath, [path.join(REPO, "supervisor.js")], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH, PORT: String(p), SECRET: "test-secret", SESSION_KEY_DIR: path.join(dir, "keys"), STATE_FILE: path.join(dir, "state.json"),
      MOCK_SPAWN: "1", BASE_RPC: "http://127.0.0.1:9", PUBLIC_URL: PUBLIC, ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
      ATTESTATION_URL: `http://127.0.0.1:${rad.address().port}/.well-known/enclave-attestation`, RAD_CACHE_MS: "0" } }),
    claimed: (out, p) => out.includes(`enclave supervisor on :${p}`), timeoutMs: 30000,
  });
  t.after(() => child.kill("SIGKILL"));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };
  for (const p of P.RAD_PATHS) assert.deepEqual(await get(p), { status: 200, body: doc }, p);
  assert.ok(fetched >= 2, "each path read the guest agent's document");
  for (const p of [`${P.CANONICAL_RAD_PATH}/x`, `${P.LEGACY_RAD_PATH}x`, "/.well-known/other-attestation"]) assert.equal((await get(p)).status, 404, p);
  const att = await get("/v1/attestation");
  assert.equal(att.status, 200, JSON.stringify(att.body));
  assert.equal(att.body.verification.attestationEndpoint, PUBLIC + P.ADVERTISED_RAD_PATH);
});
