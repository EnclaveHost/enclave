// Response headers the supervisor must NOT volunteer.
//
// This process answers on the public data path: api-relay proxies /v1 and /x
// straight through, so whatever Express puts on a response reaches the internet
// verbatim. `X-Powered-By: Express` was observable on api.enclave.host, which
// names the server framework of code running INSIDE the CVM - a free hint about
// which CVE list to try against a box whose entire pitch is that you cannot see
// in. Nothing reads the header.
//
// Asserted over a REAL boot rather than by grepping for the disable() call,
// because the thing that matters is what goes out on the wire: an express
// upgrade that changed the default, or a later `res.set` that puts it back,
// should fail this test. A 404 is a perfectly good probe - Express's
// expressInit middleware stamps the header on every response it produces,
// including ones from the default not-found handler - so this needs no route
// and no auth, which is exactly what keeps it stable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootDaemon } from "./helpers/daemon.mjs";

const pexec = promisify(execFile);

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

// Boot with every outbound feature off: no chain reads, no ACME, no DNS. The
// point is the HTTP surface, and a supervisor that dials Base on start would
// make this test a network test.
const ENV = {
  SECRET: "test-secret", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
  ACME_SELFTEST: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
  SWEEP_SELFTEST: "", REACH_SELFTEST: "", WAF_SELFTEST: "",
};

test("the supervisor does not advertise its framework in X-Powered-By", async () => {
  const { child, port, log } = await bootDaemon({
    start: (p) => spawn(process.execPath, [SUPERVISOR], {
      env: { ...process.env, ...ENV, PORT: String(p) }, stdio: ["ignore", "pipe", "pipe"],
    }),
    // The listen CALLBACK line - printed only if this child actually won the
    // port, which is the whole reason the helper exists.
    claimed: (out, p) => out.includes(`enclave supervisor on :${p}`),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__no_such_route__`);
    // Positive control: if this were not our supervisor, or Express never ran,
    // the absence below would prove nothing.
    assert.ok(res.status >= 200, `expected a real HTTP response, got ${res.status}`);
    assert.ok(log().includes("enclave supervisor on :"), "the response must come from the supervisor we started");

    const powered = res.headers.get("x-powered-by");
    assert.equal(powered, null, `X-Powered-By must not be sent (got ${JSON.stringify(powered)})`);

    // ...and the two it MUST send. api.enclave.host is not the apex, so it never
    // inherited the site vhost's headers: a caller that reaches the API directly
    // (CLI, MCP, a browser that has not first seen enclave.host) had no HSTS pin
    // at all, and JSON answers went out sniffable.
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("strict-transport-security") || "", /^max-age=31536000; includeSubDomains$/);

    // The tenant data path is EXCLUDED: those bytes are the app's, and nosniff
    // can change how its own content renders. 404 here (no such deployment) is
    // produced by the /x handler, which is what makes it the right probe.
    const x = await fetch(`http://127.0.0.1:${port}/x/0x${"ab".repeat(32)}/`);
    assert.equal(x.status, 404, "expected the /x handler's own not-found");
    assert.equal(x.headers.get("x-content-type-options"), null, "tenant responses keep their own headers");
    assert.equal(x.headers.get("strict-transport-security"), null);
  } finally {
    child.kill("SIGKILL");
  }
});

// ---- tenant responses: the WebAuthn Permissions-Policy default --------------
// Why this matters is written at tenantHeaders(): every tenant app is served
// under enclave.host, a passkey's rpId IS enclave.host, and WebAuthn lets any
// origin under a registrable domain drive that domain's credentials. The vault
// (on-chain) and relay auth.js both refuse such an assertion by origin already,
// so this header is the browser-side layer in front of them.
async function tenantHeaders(...upstreams) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, ...ENV, TENANT_HEADERS_SELFTEST: JSON.stringify(upstreams) },
  });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("tenant responses block WebAuthn by default", async () => {
  const [plain] = await tenantHeaders({ "content-type": "text/html" });
  assert.equal(plain["permissions-policy"],
    "publickey-credentials-get=(), publickey-credentials-create=()");
  // both directions of the credential API: get() harvests an existing passkey,
  // create() is what would register an attacker's own (the terminal escalation
  // in cb68e88e's addKey case)
  assert.match(plain["permissions-policy"], /publickey-credentials-get=\(\)/);
  assert.match(plain["permissions-policy"], /publickey-credentials-create=\(\)/);
  // the app's own headers must survive untouched
  assert.equal(plain["content-type"], "text/html");
});

test("an app that sets its own Permissions-Policy keeps it (the opt-out)", async () => {
  // This is the escape hatch instead of a new options-envelope namespace: an
  // app that legitimately wants WebAuthn under its OWN subdomain says so in a
  // standard header, and we must not override it — otherwise the default would
  // be an unfixable break rather than a safe default.
  const [own] = await tenantHeaders({ "permissions-policy": "publickey-credentials-get=(self)" });
  assert.equal(own["permissions-policy"], "publickey-credentials-get=(self)");
});

test("the default cannot be smuggled past by header case", async () => {
  // Node lower-cases incoming header names, so an upstream can only ever
  // present this key in one spelling. Pin that assumption: if it ever stopped
  // holding, a tenant could ship `Permissions-Policy:` and get BOTH values.
  const [mixed] = await tenantHeaders({ "Permissions-Policy": "camera=()" });
  const keys = Object.keys(mixed).filter((k) => k.toLowerCase() === "permissions-policy");
  assert.equal(keys.length, 1, `exactly one permissions-policy key, got ${JSON.stringify(keys)}`);
});
