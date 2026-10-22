// The phone's half of a pVM custody v2 release (docs/security/custody-avf-recipients.md): the host agent carries the owner's
// startup package (public bytes) and signs the operator's custody-auth-v2 for its own launch only; the payload and the Java
// host route both. What it pins:
//   - egress.mjs CUSTODYAUTH: only this launch's token AND its deployment; malformed refused; no signer = refused; nothing
//     dialled, no route needed;
//   - host-agent.mjs: a guestBootstrap envelope is an owner startup (no inline/CID config beside it), the package must be
//     the committed bytes, a sealed release and a startup package never mix;
//   - the Java host and the measured payload (source shape): STARTUP -> APPSTARTUP, the egress pattern, and the payload's
//     refusals (host ENCLAVE_CONFIG, a sealed release, no instance key, no egress) and its app check on every challenge.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { createEgressServer } from "../shielded/anchor/avf/runner/egress.mjs";
import { parseOptions, optionsFile, startupPackage } from "../shielded/anchor/avf/runner/host-agent.mjs";

const D = "0x" + "f1".repeat(32), OTHER = "0x" + "f2".repeat(32), TOKEN = "ab".repeat(16);
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", BINDING = "cd".repeat(32);
const SIG = "0x" + "11".repeat(65);
function ask(port, line) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1"); let buf = "";
    c.on("data", (b) => { buf += b; }); c.on("end", () => resolve(buf.replace(/\n$/, "")));
    c.setTimeout(3000, () => { c.destroy(); resolve(buf); }); c.on("error", reject);
    c.write(line + "\n");
  });
}
async function server(authorize) {
  const asked = [];
  const srv = createEgressServer({ routesFile: "/nonexistent/egress-routes.json", current: () => ({ token: TOKEN, deployment: D }),
    connect: async () => { asked.push("connect"); throw new Error("no"); }, resolve: async () => { asked.push("resolve"); throw new Error("no"); },
    ...(authorize ? { authorize: async (a) => { asked.push(a); return authorize(a); } } : {}) });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, asked, close: () => srv.close() };
}

test("CUSTODYAUTH: the operator signs this launch's custody release, for its own deployment only; nothing is dialled", async () => {
  const s = await server(async ({ deployment, vault, binding }) => ({ endpoint: "https://pixel.example.org", expiry: 1790000000, sig: SIG, _: [deployment, vault, binding] }));
  try {
    assert.equal(await ask(s.port, `EGRESS ${TOKEN} CUSTODYAUTH ${VAULT} ${D} ${BINDING}`), `OK https://pixel.example.org 1790000000 ${SIG}`);
    assert.deepEqual(s.asked, [{ deployment: D, vault: VAULT, id: D, binding: BINDING }], "no route read, nothing dialled; the agent saw exactly the request");
    assert.equal(await ask(s.port, `EGRESS ${TOKEN} CUSTODYAUTH ${VAULT} ${OTHER} ${BINDING}`), "ERR not this launch's deployment");
    assert.equal(await ask(s.port, `EGRESS ${"cd".repeat(16)} CUSTODYAUTH ${VAULT} ${D} ${BINDING}`), "ERR not this launch's egress");
    for (const bad of [`CUSTODYAUTH ${VAULT} ${D}`, `CUSTODYAUTH ${VAULT.toUpperCase()} ${D} ${BINDING}`, `CUSTODYAUTH ${VAULT} ${D} ${BINDING} extra`, `CUSTODYAUTH ${VAULT} ${D} ${BINDING.slice(2)}`])
      assert.equal(await ask(s.port, `EGRESS ${TOKEN} ${bad}`), "ERR malformed", bad);
    assert.equal(s.asked.length, 1);
  } finally { s.close(); }
  const none = await server(null);
  try { assert.equal(await ask(none.port, `EGRESS ${TOKEN} CUSTODYAUTH ${VAULT} ${D} ${BINDING}`), "ERR this host signs no custody release"); }
  finally { none.close(); }
  const refuses = await server(async () => { throw new Error("not a reviewed custody vault"); });
  try { assert.equal(await ask(refuses.port, `EGRESS ${TOKEN} CUSTODYAUTH ${VAULT} ${D} ${BINDING}`), "ERR not a reviewed custody vault"); }
  finally { refuses.close(); }
  const malformed = await server(async () => ({ endpoint: "https://x.example", expiry: 1, sig: "0x12" }));
  try { assert.equal(await ask(malformed.port, `EGRESS ${TOKEN} CUSTODYAUTH ${VAULT} ${D} ${BINDING}`), "ERR the operator's authorization is malformed"); }
  finally { malformed.close(); }
});

test("an owner startup envelope: parsed as such, never beside inline or CID config; the package must be the committed bytes", () => {
  const pkg = Buffer.from(JSON.stringify({ version: 1, deployment: D }));
  const sha = createHash("sha256").update(pkg).digest("hex");
  assert.deepEqual(parseOptions(JSON.stringify({ guestBootstrap: { version: 1, sha256: sha } })).startup, { version: 1, sha256: sha });
  assert.throws(() => parseOptions(JSON.stringify({ guestBootstrap: { version: 1, sha256: sha }, config: { a: 1 } })), /owner startup commitment is invalid/);
  assert.throws(() => parseOptions(JSON.stringify({ guestBootstrap: { version: 2, sha256: sha } })), /owner startup commitment is invalid/);
  assert.equal(parseOptions(JSON.stringify({ config: { a: 1 } })).startup, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-startup-"));
  assert.throws(() => startupPackage(dir, D, { version: 1, sha256: sha }), /not on this host/);
  fs.mkdirSync(path.join(dir, "startup")); fs.writeFileSync(path.join(dir, "startup", `${D}.json`), pkg);
  assert.deepEqual(startupPackage(dir, D.toUpperCase().replace("0X", "0x"), { version: 1, sha256: sha }), pkg);
  fs.writeFileSync(path.join(dir, "startup", `${D}.json`), Buffer.concat([pkg, Buffer.from(" ")]));
  assert.throws(() => startupPackage(dir, D, { version: 1, sha256: sha }), /not the one the owner committed/);
  const f = optionsFile({ env: Buffer.from("ENCLAVE_HOSTS=x\0"), startup: pkg, egress: { port: 18190, token: TOKEN } });
  assert.match(f, new RegExp(`^STARTUP ${pkg.toString("hex")}$`, "m"));
  assert.doesNotMatch(f, /ENCLAVE_CONFIG/);
  assert.throws(() => optionsFile({ sealed: "ab", startup: pkg }), /do not mix/);
});

test("source shape: the Java host routes STARTUP and CUSTODYAUTH; the measured payload refuses what custody must not take", () => {
  const read = (p) => fs.readFileSync(new URL(`../shielded/anchor/avf/${p}`, import.meta.url), "utf8");
  const main = read("host/app/Main.java"), pool = read("host/app/EgressPool.java"), pay = read("payload/anchor_payload.c");
  assert.match(main, /t\[0\]\.equals\("STARTUP"\)\) && t\[1\]\.matches\("\(\[0-9a-f\]\{2\}\)\+"\)/);
  assert.match(main, /: "APPSTARTUP "/);
  assert.match(pool, /\|CUSTODYAUTH 0x\[0-9a-f\]\{40\} 0x\[0-9a-f\]\{64\} \[0-9a-f\]\{64\}\)"\)/);
  for (const why of ["a relay-sealed release and an owner startup package do not mix", "custody needs this VM's instance key", "custody needs egress",
                     "the owner-committed config is the app's ENCLAVE_CONFIG: a host-set one is refused", "custody needs the deployment's proof pins",
                     "this build carries no custody library (libpvmcustody.so)", "custody needs the runtime's W^X self-test"])
    assert.ok(pay.includes(why), why);
  assert.match(pay, /if \(memcmp\(ch \+ 32, g_custody_app, 32\) != 0\)/, "every custody challenge names the loaded app");
  assert.match(pay, /dlsym\(ch, "pvmc_start"\)/);
  assert.match(pay, /if \(g_app_startup_len\) memset\(g_custody_env, 0, sizeof g_custody_env\);/, "the opened values are zeroed once the runtime holds them");
  assert.match(pay, /static const char cfgk\[\] = "ENCLAVE_CONFIG=";/, "the resolved owner config is the app's ENCLAVE_CONFIG");
  assert.match(pay, /o\.env = g_custody_env; o\.env_len = el;/, "values reach the app through the environment block pvm-rt already checks");
  // PVM_RELEASE_KEYS still exists for the legacy relay path; the custody path never consults it
  const custodyBlock = pay.slice(pay.indexOf("if (g_app_startup_len) {   /* owner startup"), pay.indexOf("if (ca) OUT(\"APP options:"));
  assert.ok(custodyBlock.length > 500);
  assert.doesNotMatch(custodyBlock, /PVM_RELEASE_KEYS|rel_keys/);
});
