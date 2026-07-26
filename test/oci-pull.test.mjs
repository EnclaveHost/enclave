// metal/oci-pull.mjs — a @sha256: reference must be BINDING.
//
// This is the tool that assembles the measured enclave image. Blobs were always
// digest-verified, but the manifest naming them was taken on the registry's
// word (docker-content-digest is a header the registry writes). A registry
// serving a different manifest body at the pinned path yields an image whose
// every layer self-verifies and which is not the one you asked for. Driven
// against a fake registry that does exactly that.
//
//   run: node --test test/oci-pull.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const PULLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "metal", "oci-pull.mjs");
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");

// a one-layer image: an empty-ish tar.gz plus a config blob
function buildImage() {
  const header = Buffer.alloc(512);                       // a single all-zero tar block is a valid empty archive
  const layer = zlib.gzipSync(Buffer.concat([header, Buffer.alloc(512)]));
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha(config), size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha(layer), size: layer.length }],
  }));
  return { layer, config, manifest };
}

// A throwaway TLS cert, so the puller's hardcoded https:// is exercised as-is.
// Deliberately NOT an insecure-transport switch in the tool: an env var that
// turns off TLS in the image builder is precisely the thing that gets set by
// accident. Only the spawned child relaxes verification.
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
  "-nodes", "-keyout", path.join(certDir, "k.pem"), "-out", path.join(certDir, "c.pem"),
  "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
  { stdio: "ignore" });
const TLS = { key: fs.readFileSync(path.join(certDir, "k.pem")), cert: fs.readFileSync(path.join(certDir, "c.pem")) };

// `serve` decides what body to return for a manifest request, so a test can lie
async function registry(serve) {
  const srv = https.createServer(TLS, (req, res) => {
    if (req.url.startsWith("/token")) {                     // the puller asks for a pull token first
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "test-token" }));
    }
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const [, , kind, ref] = m;
    const body = serve(kind, decodeURIComponent(ref));
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/vnd.oci.image.manifest.v1+json",
                         "docker-content-digest": serve.claim || sha(body) });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, host: `127.0.0.1:${srv.address().port}` };
}

const run = (ref, dest) => pexec(process.execPath, [PULLER, ref, dest],
  { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });   // the throwaway cert, child only

test("oci-pull: an honest registry pulls, and the reported digest is the manifest's", async (t) => {
  const img = buildImage();
  const { srv, host } = await registry((kind, ref) =>
    kind === "manifests" ? img.manifest
      : ref === sha(img.config) ? img.config
      : ref === sha(img.layer) ? img.layer : null);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "oci-"));
  t.after(() => { srv.close(); fs.rmSync(dest, { recursive: true, force: true }); });

  const { stderr } = await run(`${host}/lib/app@${sha(img.manifest)}`, dest);
  assert.match(stderr, new RegExp(sha(img.manifest)), "the digest it reports for pinning is the one it verified");
});

test("oci-pull: a substituted manifest at the pinned digest is REFUSED", async (t) => {
  const real = buildImage();
  const evil = buildImage();
  evil.manifest = Buffer.from(JSON.stringify({ ...JSON.parse(evil.manifest), annotations: { swapped: "yes" } }));
  assert.notEqual(sha(evil.manifest), sha(real.manifest));

  // the registry answers EVERY manifest request with the evil body, and even
  // claims the real digest in the header — exactly the substitution a pin exists to stop
  const serve = (kind, ref) =>
    kind === "manifests" ? evil.manifest
      : ref === sha(evil.config) ? evil.config
      : ref === sha(evil.layer) ? evil.layer : null;
  serve.claim = sha(real.manifest);
  const { srv, host } = await registry(serve);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "oci-"));
  t.after(() => { srv.close(); fs.rmSync(dest, { recursive: true, force: true }); });

  await assert.rejects(() => run(`${host}/lib/app@${sha(real.manifest)}`, dest),
    (e) => /manifest digest mismatch/.test(e.stderr || e.message),
    "the pin must bind: a different manifest body at that digest is refused");
});
