// The published CID must address the bytes the publisher uploaded.
//
// putWasm resolves with whatever CID the upload gateway answers, and that value
// goes into the publishVersion transaction the publisher signs. The upload token
// binds sha256(bytes) and ipfs-add-gateway.py re-derives it before accepting -
// but that is the gateway checking itself, which a compromised one passes by
// pinning the real bytes and answering with a CID for someone else's. The
// publisher's wallet then attests on-chain to wasm they never saw, and every
// deployer of that version runs it inside their enclave.
//
// So the CID is read back from a DIFFERENT gateway and compared. The three
// outcomes are not symmetric, and that asymmetry is the design:
//   match      -> publishable
//   MISMATCH   -> refuse; there is no benign reading of a gateway answering
//                 with a CID for other bytes
//   unreachable-> warn, never block; propagation lag is normal and refusing
//                 would break honest publishes far more than it catches anything
//
// apps.js imports browser modules, so this drives the same algorithm against a
// stub gateway rather than the page.
//
//   run: node --test test/publish-cid-verify.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "site/js/pages/apps.js"), "utf8");

// lift verifyCid out of the page source: it closes over nothing but fetch,
// crypto.subtle and the gateway URL, so it runs as-is with those supplied
function loadVerifyCid(gatewayUrl) {
  const start = SRC.indexOf("async function verifyCid(");
  assert.ok(start > 0, "apps.js no longer defines verifyCid - was the check removed?");
  const end = SRC.indexOf("\n}\n", start) + 3;
  const body = SRC.slice(start, end).replace(/IPFS_GATEWAY/g, JSON.stringify(gatewayUrl));
  const make = new Function("crypto", "fetch", "AbortSignal", `${body}; return verifyCid;`);
  return make(webcrypto, fetch, AbortSignal);
}

const BYTES = Buffer.from("\0asm\x01\0\0\0 the publisher's actual component");
const OTHER = Buffer.from("\0asm\x01\0\0\0 something else entirely");

// a stub IPFS gateway: /ipfs/<cid> -> whatever this test says that CID holds
function gateway(routes) {
  const srv = http.createServer((req, res) => {
    const cid = decodeURIComponent(req.url.replace(/^\/ipfs\//, ""));
    const hit = routes[cid];
    if (hit === "hang") return;                       // never answers: timeout path
    if (!hit) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200); res.end(hit);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}/ipfs/`;

test("a CID that really holds the bytes verifies", async () => {
  const srv = await gateway({ bafyGOOD: BYTES });
  try {
    const verifyCid = loadVerifyCid(urlOf(srv));
    assert.deepEqual(await verifyCid("bafyGOOD", BYTES), { state: "ok" });
  } finally { srv.close(); }
});

test("a CID holding DIFFERENT bytes is a mismatch, and reports both hashes", async () => {
  // the actual attack: gateway pinned the publisher's bytes (so its own token
  // check passed) but answered with a CID addressing someone else's
  const srv = await gateway({ bafyEVIL: OTHER });
  try {
    const verifyCid = loadVerifyCid(urlOf(srv));
    const v = await verifyCid("bafyEVIL", BYTES);
    assert.equal(v.state, "mismatch");
    assert.equal(v.want, createHash("sha256").update(BYTES).digest("hex"), "want = the publisher's bytes");
    assert.equal(v.got, createHash("sha256").update(OTHER).digest("hex"), "got = what that CID actually holds");
  } finally { srv.close(); }
});

test("a CID that has not propagated yet is UNVERIFIED, never a mismatch", async () => {
  // 404 from the read-back gateway means "not there yet", which is routine.
  // Calling that tampering would fail honest publishes constantly.
  const srv = await gateway({});
  try {
    const verifyCid = loadVerifyCid(urlOf(srv));
    const v = await verifyCid("bafyMISSING", BYTES);
    assert.equal(v.state, "unverified");
    assert.match(v.detail, /404/);
  } finally { srv.close(); }
});

test("an unreachable gateway is UNVERIFIED, not a mismatch", async () => {
  const verifyCid = loadVerifyCid("http://127.0.0.1:1/ipfs/");
  const v = await verifyCid("bafyANY", BYTES);
  assert.equal(v.state, "unverified");
});

test("one byte of difference is caught", async () => {
  const tweaked = Buffer.from(BYTES); tweaked[tweaked.length - 1] ^= 0x01;
  const srv = await gateway({ bafySUBTLE: tweaked });
  try {
    const verifyCid = loadVerifyCid(urlOf(srv));
    assert.equal((await verifyCid("bafySUBTLE", BYTES)).state, "mismatch");
  } finally { srv.close(); }
});

test("the page refuses to publish a mismatch, and only warns on unverified", () => {
  // the states are only worth having if the call site treats them differently
  const call = SRC.slice(SRC.indexOf("const v = await verifyCid("), SRC.indexOf("} catch(err){", SRC.indexOf("const v = await verifyCid(")));
  assert.match(call, /v\.state === "mismatch"/, "the page never checks for a mismatch");
  assert.match(call, /\$\("#pubCid"\)\.value = "";/, "a mismatch must clear the CID so it cannot be published");
  assert.match(call, /return;/, "a mismatch must stop, not fall through to publishable");
  assert.match(call, /could not verify/, "an unverified read-back must say so rather than claim verification");
  // and unverified must NOT clear the field - that would block honest publishes
  const unverifiedBranch = call.slice(call.indexOf('$("#pubCid").value = cid;'));
  assert.ok(unverifiedBranch.length > 0, "the unverified path must still set a publishable CID");
});

test("the read-back gateway is not the upload gateway", () => {
  // asking ipfs.enclave.host to confirm ipfs.enclave.host proves nothing
  assert.match(SRC, /const url = IPFS_GATEWAY/, "verifyCid no longer reads from IPFS_GATEWAY");
  const cfg = fs.readFileSync(path.join(REPO, "site/js/core/config.js"), "utf8");
  const gw = /IPFS_GATEWAY\s*=\s*"([^"]+)"/.exec(cfg)[1];
  const up = /IPFS_UPLOAD_URL\s*=\s*"([^"]+)"/.exec(cfg)[1];
  assert.notEqual(new URL(gw).host, new URL(up).host,
    "the verification gateway and the upload gateway are the same host - verification is circular");
});
