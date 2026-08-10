// The /add-image path of scripts/ipfs-add-gateway.py, driven over real HTTP:
// a spawned gateway (UPLOAD_KEY unset = auth off; the signed-upload token is
// covered by the api-relay tests) in front of a stub Kubo /api/v0/add. The
// focus is the strict SVG validator - with Kubo running NoFetch, this
// validator is the ONLY perimeter between publisher uploads and what
// ipfs.enclave.host can ever serve, so the reject matrix IS the security
// property. Policy under test: validate-and-REJECT, never sanitize-and-rewrite.
//
//   run: node --test test/image-gateway.test.mjs   (needs python3 on PATH)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ipfs-add-gateway.py");

let kubo, gwProc, gwPort;
const added = [];   // { filename, size } for each add the stub Kubo saw

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}

test.before(async () => {
  kubo = http.createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    for await (const c of req) body = Buffer.concat([body, c]);
    const m = /filename="([^"]*)"/.exec(body.toString("latin1"));
    added.push({ filename: m ? m[1] : "", size: body.length });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Hash: "bafkteststub" }));
  });
  await new Promise((r) => kubo.listen(0, "127.0.0.1", r));
  // freePort() reserves nothing (binds :0, reads the number, closes), so under a
  // parallel run another server can hold it before python gets there. /healthz
  // is at least this gateway's OWN path - the other daemons in the suite serve
  // /health and would 404 it - but a dead child must not look like a slow one,
  // so give up on a corpse and start over on a fresh port.
  let log = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    gwPort = await freePort();
    gwProc = spawn("python3", [GW], {
      env: { ...process.env, PORT: String(gwPort), UPLOAD_KEY: "",
             KUBO_API: `http://127.0.0.1:${kubo.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    log = "";
    gwProc.stdout.on("data", (d) => (log += d));
    gwProc.stderr.on("data", (d) => (log += d));
    let up = false;
    for (let i = 0; i < 100 && gwProc.exitCode == null; i++) {
      try { const r = await fetch(`http://127.0.0.1:${gwPort}/healthz`); if (r.ok) { up = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (up) return;
    try { gwProc.kill("SIGKILL"); } catch {}
  }
  throw new Error(`gateway never answered /healthz on a port of its own:\n${log}`);
});
test.after(() => { gwProc?.kill("SIGKILL"); kubo?.close(); });

const post = async (bytes) => {
  const r = await fetch(`http://127.0.0.1:${gwPort}/add-image`, {
    method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } });
  return { status: r.status, body: await r.json() };
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const NS = 'xmlns="http://www.w3.org/2000/svg"';

test("raster still pins: PNG -> cid, svg:false, plain filename to Kubo", async () => {
  const r = await post(PNG);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cid, "bafkteststub");
  assert.equal(r.body.svg, false);
  assert.equal(added.at(-1).filename, "image");
});

test("a clean SVG pins: cid + svg:true, .svg filename to Kubo", async () => {
  const r = await post(Buffer.from(
    `<?xml version="1.0"?><svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"/>` +
    `<path id="p" d="M0 0h10v10z"/></defs><style>.a{fill:url(#g)}</style>` +
    `<use href="#p" class="a"/><rect fill="url(#g)" filter="url( #f )"/>` +
    `<image href="data:image/png;base64,iVBOR"/></svg>`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.svg, true);
  assert.equal(added.at(-1).filename, "image.svg");
});

test("the SVG reject matrix: script-capable and externally-referencing constructs are all 415", async () => {
  const cases = [
    ["script element",        `<svg ${NS}><script>alert(1)</script></svg>`],
    ["event handler",         `<svg ${NS} onload="alert(1)"/>`],
    ["foreignObject",         `<svg ${NS}><foreignObject/></svg>`],
    ["javascript: href",      `<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a></svg>`],
    ["entity-encoded js",     `<svg ${NS}><a href="jav&#97;script:alert(1)"><text>x</text></a></svg>`],
    ["tab-split js",          `<svg ${NS}><a href="java\tscript:alert(1)"><text>x</text></a></svg>`],
    ["external href",         `<svg ${NS}><image href="https://evil.example/x.png"/></svg>`],
    ["nested svg data: URI",  `<svg ${NS}><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>`],
    ["DOCTYPE/entities",      `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}/>`],
    ["xml-stylesheet PI",     `<?xml version="1.0"?><?xml-stylesheet href="http://e/x.css"?><svg ${NS}/>`],
    ["foreign namespace",     `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"><div>x</div></g></svg>`],
    ["style url(external)",   `<svg ${NS}><style>.a{background:url(http://e/x)}</style></svg>`],
    ["style attr external",   `<svg ${NS}><rect style="fill:url('https://e/x')"/></svg>`],
    // funciri lives in presentation ATTRIBUTES too, not only in CSS: fill,
    // stroke, filter, mask, clip-path, marker-*. An external one beacons the
    // viewer's IP on a direct /ipfs/<cid> navigation, where the sandbox CSP
    // stops script but not subresource loads.
    ["fill attr external",    `<svg ${NS}><rect fill="url(https://e/x)"/></svg>`],
    ["filter attr external",  `<svg ${NS}><rect filter="url(//e/x#f)"/></svg>`],
    ["mask attr external",    `<svg ${NS}><rect mask="url( 'http://e/m' )"/></svg>`],
    ["clip-path external",    `<svg ${NS}><rect clip-path="url(data:image/svg+xml,x)"/></svg>`],
    ["style @import",         `<svg ${NS}><style>@import "http://e/x.css";</style></svg>`],
    ["animated href",         `<svg ${NS}><a href="#x"><animate attributeName="href" values="javascript:alert(1)"/></a></svg>`],
    ["animated xlink:href",   `<svg ${NS}><animate attributeName="xlink:href" to="#z"/></svg>`],
    ["no namespace",          `<svg><path d="M0 0"/></svg>`],
    ["malformed XML",         `<svg ${NS}><path`],
  ];
  for (const [name, doc] of cases) {
    const r = await post(Buffer.from(doc));
    assert.equal(r.status, 415, `${name} must be refused (got ${r.status}: ${JSON.stringify(r.body)})`);
  }
});

test("non-image bytes name every accepted format", async () => {
  const r = await post(Buffer.from("definitely not an image, and not xml either"));
  assert.equal(r.status, 415);
  assert.match(r.body.error, /PNG, JPEG, WebP, GIF, or SVG/);
});

test("the image size cap still applies to SVG", async () => {
  const big = Buffer.concat([Buffer.from(`<svg ${NS}><path d="`), Buffer.alloc(4 * 1024 * 1024 + 100, 0x30), Buffer.from(`"/></svg>`)]);
  const before = added.length;
  // the gateway answers 413 off Content-Length WITHOUT reading the body (the
  // 2 GB wasm cap makes read-then-reject a DoS); fetch may surface the early
  // close as an error instead of the response - either way it must not pin
  let refused = false;
  try { refused = (await post(big)).status === 413; } catch { refused = true; }
  assert.ok(refused, "an over-cap SVG must be refused");
  assert.equal(added.length, before, "nothing may reach Kubo");
});

// ---- /add-json: the app-config pin route -----------------------------------
// It is wallet-signed now (catalog rev 7 raised its cap to 1 MB, which made the
// old unsigned trade indefensible), but the per-IP bucket stays in FRONT of the
// auth as the cheap pre-filter — so the bucket's KEY still has to be a value
// the caller cannot pick. X-Forwarded-For is written by the client and APPENDED
// to by the proxy in front of this gateway (it binds 127.0.0.1), so the first
// entry is whatever the sender typed and the last is the real peer.
// (This harness runs with UPLOAD_KEY unset = auth disabled, which is what lets
// the bucket be exercised on its own; the signed path is covered below.)
test("the /add-json rate limit keys on the proxy-appended address, not the caller's claim", async () => {
  const pin = (xff) => fetch(`http://127.0.0.1:${gwPort}/add-json`, {
    method: "POST", body: JSON.stringify({ a: 1 }),
    headers: { "content-type": "application/json", "x-forwarded-for": xff } });

  // Same real peer (the last entry), a different claimed one each time: these
  // must share ONE bucket. The default bucket is 60/hr, so 80 requests drains
  // it if — and only if — the claim is ignored.
  let refused = 0;
  for (let i = 0; i < 80; i++) {
    const r = await pin(`10.0.0.${i % 250}, 203.0.113.9`);
    if (r.status === 429) refused++;
    await r.arrayBuffer();
  }
  assert.ok(refused > 0, "a varied X-Forwarded-For must not mint a fresh bucket per request");

  // ...and a genuinely different peer still gets its own bucket (the limit is
  // per-source, not a global stop-the-world).
  const other = await pin("198.51.100.7");
  assert.equal(other.status, 200, "a different real peer must still be served");
  await other.arrayBuffer();
});
