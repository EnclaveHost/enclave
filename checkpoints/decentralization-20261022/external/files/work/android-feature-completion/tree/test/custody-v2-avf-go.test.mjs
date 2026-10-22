// The Android pVM's Go custody client (isolation/m2/pvmcustody: the frozen custody.Client.ObtainV2 with the AVF evidence)
// against REAL JS custodians (createCustodianV2 + the AVF adapter, custody/v2/avf-evidence.mjs), over TLS, end to end.
// This file starts the custodians and a control server, writes the scenarios, and runs `go test` on the Go package.
//   REAL:      the custodians, the v2 protocol on both sides, Google's status list (2026-10-21), the operator signature.
//   SYNTHETIC: the AVF chain (an openssl CA; the custodians accept it only through the adapter's test root pins, so every
//              verdict says synthetic), the chain state the custodians read (in memory), the owner authorization on the Go
//              side (a fake startupAuth: bootstrap's own suites cover Authorize), and TLS names (*.test under a test CA).
// Needs openssl and go.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import url from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { sign, X509Certificate } from "node:crypto";
import * as v2 from "../custody/v2/protocol.mjs";
import { createAvfStatusList, serialKey } from "../custody/v2/avf-status.mjs";
import { canonicalAvfRules } from "../custody/v2/avf-rules.mjs";
import { Refusal } from "../custody/v2/custodian.mjs";
import { instanceSigMessage } from "../relay/pvm-evidence-core.mjs";
import * as R from "./helpers/avf-custody-rig.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const haveGo = (() => { try { execFileSync("go", ["version"], { stdio: "pipe" }); return true; } catch { return false; } })();
const skip = R.options.skip || (!haveGo && "go absent");

function tlsFor(dir, names) {
  const x = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  x("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=pvmcustody e2e test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  fs.writeFileSync(path.join(dir, "srv.cnf"), `[s]\nbasicConstraints=CA:FALSE\nsubjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\nextendedKeyUsage=serverAuth\n`);
  x("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=custodians.test");
  x("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "srv.cnf", "-extensions", "s", "-out", "srv.pem");
  return { ca: fs.readFileSync(path.join(dir, "ca.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "srv.key")), cert: fs.readFileSync(path.join(dir, "srv.pem")) };
}
const body = (req) => new Promise((res, rej) => { const c = []; req.on("data", (b) => c.push(b)); req.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch (e) { rej(e); } }); });
const send = (res, status, o) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(status, { "content-type": "application/json", "content-length": b.length }); res.end(b); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("the pVM Go custody client against REAL JS custodians (SYNTHETIC AVF chain): quorum, Enclave seat, liar, revocation, config, revalidation, operator", { skip, timeout: 600_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvmc-e2e-"));
  const world = R.avfWorld(fs.mkdtempSync(path.join(os.tmpdir(), "pvmc-avf-")));
  const keys = R.vmKeys();
  const interSerial = serialKey(new X509Certificate(world.inter).serialNumber);
  const S = [
    { name: "honest", flags: [true, false, false, false] },
    { name: "enclave-replicas", flags: [true, true, false, false, false] },
    { name: "liar", flags: [true, false, false, false, false], liar: 1 },
    { name: "enclave-offline", flags: [true, false, false, false], down: [0] },
    { name: "quorum-lost", flags: [true, false, false, false], down: [1, 2], expectErr: "valid share indices|machines that issued a challenge" },
    { name: "revoked", flags: [true, false, false, false], revoked: true, expectErr: "REVOKED \\(KEY_COMPROMISE\\)" },
    { name: "config-mismatch", flags: [true, false, false, false], configText: '{"api":"$API_KEY"}', expectErr: "owner-committed config is not" },
    { name: "revalidate-fails", flags: [true, false, false, false], revalidate: "the lease moved", expectErr: "owner startup changed" },
    { name: "wrong-instance", flags: [true, false, false, false], instances: ["88".repeat(32)], expectErr: "not one the owner bound" },
    { name: "stranger-operator", flags: [true, false, false, false], stranger: true, expectErr: "operator_sig" },
  ];
  const names = S.flatMap((s, si) => s.flags.map((_, i) => `c${si}-${i}.test`));
  const tls = tlsFor(dir, names);
  const servers = [], scenarios = [], byName = new Map();
  try {
    for (const [si, s] of S.entries()) {
      const com = R.committee(s.flags), { bundle } = R.ownerBundle(com);
      const statusList = createAvfStatusList({ fetchImpl: R.statusFetch(s.revoked ? { extra: { [interSerial]: { status: "REVOKED", reason: "KEY_COMPROMISE" } } } : {}) });
      const rules = canonicalAvfRules(R.avfRules(s.instances ? { instances: s.instances } : {}));
      const cs = R.custodians(com, { bundle, roots: world, statusList, rules, liar: s.liar ?? -1 });
      const hosts = {};
      for (const [i, c] of cs.entries()) {
        if ((s.down || []).includes(i)) continue;
        const srv = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
          try {
            const b = await body(req);
            if (req.url === "/v2/custody/challenge") return send(res, 200, c.challenge({ client: "go" }));
            if (req.url === "/v2/custody/release") return send(res, 200, await c.release(b));
            send(res, 404, { error: "not_found", message: req.url });
          } catch (e) { if (e instanceof Refusal) send(res, e.status, { error: e.code, message: e.message }); else send(res, 500, { error: "internal", message: e.message }); }
        });
        servers.push(srv);
        hosts[`c${si}-${i}.test`] = await listen(srv);
      }
      const pointer = { v: 2, chainId: R.CHAIN_ID, vault: R.VAULT, policyRev: "1", secretRev: "1", epoch: 1, committeeId: R.COMMITTEE, t: com.t,
        bundle: R.hex(bundle), commitments: com.commitments.map(R.hex).join(""),
        machines: com.machines.map((m, i) => ({ encKey: m.encKeyHex, endpoint: `https://c${si}-${i}.test`, enclave: m.enclave, indices: m.indices })) };
      byName.set(s.name, s);
      scenarios.push({ name: s.name, deployment: R.DEP, configText: s.configText || R.CONFIG_TEXT, pointer, hosts,
        ...(s.expectErr ? { expectErr: s.expectErr } : { expect: R.SECRETS }), ...(s.revalidate ? { revalidate: s.revalidate } : {}) });
    }
    // the control server: AVmPayload_requestAttestation's SYNTHETIC stand-in, the VM's public keys, the phone's operator
    const control = http.createServer(async (req, res) => {
      const b = await body(req);
      if (req.url === "/vm") return send(res, 200, { appId: R.APP, identity: R.IDENTITY, selftest: R.SELFTEST, spki: R.hex(keys.transport.spki), instanceKey: R.hex(keys.instance.spki) });
      if (req.url === "/attest") {
        const ch = Buffer.from(b.challenge, "hex");
        return send(res, 200, { chain: world.attest(ch).map(R.b64), instanceSig: R.hex(sign(null, instanceSigMessage(ch), keys.instance.privateKey)) });
      }
      if (req.url === "/authorize") {
        const signer = byName.get(b.scenario)?.stranger ? R.stranger : R.operator;
        const expiry = Math.floor(Date.now() / 1000) + 120;
        const sig = await signer.signMessage({ message: v2.operatorMessage({ chainId: R.CHAIN_ID, vault: b.vault, id: b.id, endpoint: R.ENDPOINT, binding: Buffer.from(b.binding, "hex"), expiry }) });
        return send(res, 200, { endpoint: R.ENDPOINT, sig, expiry });
      }
      send(res, 404, {});
    });
    servers.push(control);
    const cport = await listen(control);
    const cfgFile = path.join(dir, "e2e.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ caPem: tls.ca, control: `http://127.0.0.1:${cport}`, scenarios }, null, 1));
    const out = await new Promise((resolve) => {
      const p = spawn("go", ["test", "-count=1", "-v", "./pvmcustody/"], { cwd: path.join(ROOT, "isolation", "m2"), env: { ...process.env, PVMC_E2E: cfgFile } });
      let o = ""; p.stdout.on("data", (b) => { o += b; }); p.stderr.on("data", (b) => { o += b; });
      p.on("close", (code) => resolve({ code, o }));
    });
    if (process.env.PVMC_E2E_LOG) fs.writeFileSync(process.env.PVMC_E2E_LOG, out.o);   // the Go side's verbose output, when asked
    assert.equal(out.code, 0, out.o.slice(-4000));
    for (const s of S) assert.match(out.o, new RegExp(`--- PASS: TestEndToEndAgainstJSCustodians/${s.name} `), `scenario ${s.name}`);
    assert.doesNotMatch(out.o, /--- SKIP: TestEndToEndAgainstJSCustodians/);
    // the guest's own log names the dropped liar and the Enclave seat's single partial
    assert.match(out.o, /machine 1 dropped/);
  } finally { for (const s of servers) s.close(); }
});
