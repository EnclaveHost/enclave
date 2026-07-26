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
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootDaemon } from "./helpers/daemon.mjs";

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
  } finally {
    child.kill("SIGKILL");
  }
});
