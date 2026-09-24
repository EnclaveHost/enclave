// What the dashboard's Open control is allowed to say about TLS.
//
// The bug, from a real screenshot: ipns-publisher (d9798e4c) and s3-ipfs-adapter (7ae476a3) showed
// amber unlocked, disabled Open buttons titled "waiting for the app's TLS certificate". Both serve
// valid ZeroSSL ECC DV certificates that chain and match the hostname, verified independently, and
// both answer NO HTTP response on `/` - on HEAD or GET. Jot returns 404 and RISC Box 401 on the
// same path and were fine, which is the tell: the control was reading "the app answered something"
// as "the certificate exists", and every other outcome as "the certificate does not".
//
// _probeTls uses one `no-cors` HEAD. A no-cors fetch resolves or rejects and tells the page nothing
// else, so a rejection cannot distinguish a missing certificate from an app that does not serve its
// root, from a dropped connection, from a network error. Nothing in a deployment record says
// whether issuance is pending either. So the page must not claim it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "site/components/deployments/deployments.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "site/components/deployments/deployments.css"), "utf8");

// the mapping under test, lifted from the module it lives in (the file imports browser globals)
const openStateOf = new Function("tls", 'return (tls && tls.state === "ok") ? "ok" : "noanswer";');

test("a resolved probe is ok; every other outcome is 'no answer', not a certificate verdict", () => {
  assert.equal(openStateOf({ state: "ok" }), "ok");
  // valid TLS, app refuses the root path: the reported bug, for both apps
  assert.equal(openStateOf({ state: "noanswer", error: "TypeError" }), "noanswer");
  // a network error is the same one bit of information, and gets the same non-claim
  assert.equal(openStateOf({ state: "noanswer", error: "AbortError" }), "noanswer");
  assert.equal(openStateOf(null), "noanswer", "not yet probed is not a certificate problem either");
  assert.equal(openStateOf(undefined), "noanswer");
});

test("no outcome is labelled a certificate problem any more (pinned in source)", () => {
  const fn = src.slice(src.indexOf("function openCtl(d, ep, tls)"), src.indexOf("\n}", src.indexOf("function openCtl(d, ep, tls)")));
  assert.doesNotMatch(fn, /waiting for/i, "the control must not say a certificate is being waited on");
  assert.doesNotMatch(fn, /usually ready within a minute/i);
  assert.match(fn, /no answer to a readiness check/i, "it says what was actually observed");
  assert.match(fn, /cannot tell them apart, so it does not guess/i,
               "and that the three causes are indistinguishable from here");
});

test("the control no longer claims where the key is held", () => {
  assert.doesNotMatch(src, /issued inside the enclave/,
    "a publicly chaining certificate is not evidence of key custody; on a consumer node the app-zone key is in the host process");
  assert.doesNotMatch(src, /certificate is minted in-enclave either way/);
  assert.match(src, /TLS verified by this browser/, "it claims the browser's own trust decision, which is what it has");
});

test("a probe failure records one bit and claims nothing more (pinned in source)", () => {
  const probe = src.slice(src.indexOf("async _probeTls(rows)"), src.indexOf("_fillTls()"));
  assert.match(probe, /state: "noanswer"/, "the failure state is not named after a certificate");
  assert.doesNotMatch(probe, /state: "wait"/, "the old state asserted issuance was pending");
  assert.match(probe, /A no-cors rejection is one bit: no answer/);
});

test("an unanswered app is amber and pulsing, and is still a real link", () => {
  const fn = src.slice(src.indexOf("function openCtl(d, ep, tls)"), src.indexOf("\n}", src.indexOf("function openCtl(d, ep, tls)")));
  assert.doesNotMatch(fn, /<button[^>]*disabled/, "offered, not disabled: the app may serve every path but its root");
  assert.match(fn, /enc-open-unknown/);
  assert.match(css, /\.enc-open\.enc-open-unknown\{color:var\(--amber\)/, "Steven asked for the orange back");
  assert.match(css, /\.enc-open\.enc-open-unknown \.enc-lock\{animation:encpulse/, "and the pulse with it");
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.enc-open\.enc-open-unknown \.enc-lock\{animation:none/,
               "reduced motion still turns it off");
});

test("amber is a colour, not a claim: the meaning from e9fca58e is unchanged", () => {
  const fn = src.slice(src.indexOf("function openCtl(d, ep, tls)"), src.indexOf("\n}", src.indexOf("function openCtl(d, ep, tls)")));
  assert.doesNotMatch(fn, /waiting for/i, "amber must not go back to meaning a certificate is pending");
  assert.doesNotMatch(src, /issued inside the enclave/, "nor to claiming where the key is held");
  assert.match(fn, /no answer to a readiness check/i);
  assert.match(css, /says "this browser\n   got no answer", not "a certificate is being issued"/,
               "and the stylesheet says which of the two the colour means");
});

test("the repaint compares the state, not the tag, now that both render a link", () => {
  const i = src.indexOf("_fillTls() {");
  const fill = src.slice(i, src.indexOf("/* ---- pager", i));
  assert.match(fill, /el\.classList\.contains\("enc-open-unknown"\)/,
               "keying on tagName === 'A' would never repaint once both states are anchors");
});
