// linux-record.mjs: build the Linux conformance record (record.mjs) from a linux.sh workdir. Every
// verdict and binding fact is read from client.mjs's RESULT/VERDICT lines (judge.mjs is the judge); the
// document-level negatives are judged here by calling judge.mjs itself on the saved document.
//   node isolation/conformance/linux-record.mjs <workdir> <out.json>
import fs from "node:fs";
import path from "node:path";
import { emptyRecord } from "./record.mjs";
import { judge } from "../m2/judge.mjs";
import { seedCertChain } from "../../relay/snp-verify.mjs";

const [W, OUT] = process.argv.slice(2);
if (!W || !OUT) { console.error("usage: linux-record.mjs <workdir> <out.json>"); process.exit(2); }
const rd = (f) => { try { return fs.readFileSync(path.join(W, f), "utf8"); } catch { return ""; } };
const results = (f) => { const o = {}; for (const m of rd(f).matchAll(/^RESULT (\S+?)=(.*)$/gm)) { let v = m[2]; try { v = JSON.parse(v); } catch {} o[m[1]] = v; } const vm = rd(f).match(/^VERDICT (\S+)/m); o.verdict = vm ? vm[1] : null; return o; };
const jsonLine = (f) => { try { return JSON.parse(rd(f).trim().split("\n")[0]); } catch { return null; } };

const r = emptyRecord("linux-snp-guest");
r.tier = "T1"; r.format = "sev-snp-guest-domain-v1";
const sha = Object.fromEntries(rd("inputs.sha256").trim().split("\n").map((l) => { const [h, f] = l.split(/\s+/); return [path.basename(f), h]; }));
r.image = { sha256: sha["mon.cpio.gz"], kernelSha256: null };
r.backend = { measurement: rd("predicted.txt").trim(), vmpl: 0, chain: "AMD (test/fixtures/amd), VCEK held, min-TCB = the box's own" };
for (const L of ["A", "B"]) {
  const load = jsonLine(`${L}.load`), c = results(`${L}.client`);
  r.bundles[L] = { appId: sha[`app${L}.bundle`], bytes: fs.statSync(path.join(W, `app${L}.bundle`)).size };
  const rdHex = String(c.report_data || "");
  r.attest[L] = { verdict: c.verdict, abi: c.abi ?? null, runtime: c.runtime ?? null, selfTest: c.runtime_selftest ?? null,
    appIdInReport: rdHex.length === 128 ? rdHex.slice(64) : null, appIdFromMonitor: load && load.appSha256,
    bindingOk: c.verdict === "attested" && c.doc_key_matches_handshake === 1 };
  r.app[L] = { hello: c.app_body ?? null, echoIntact: c.echo_intact === 1, echoNote: "client.mjs --perf: 4 x 16 MiB" };
  r.timings[`load_${L}_ms`] = Number((rd("timings.txt").match(new RegExp(`load_${L}_ms=(\\d+)`)) || [])[1]);
  r.timings[`first_attestation_${L}_ms`] = c.first_attestation_ms ?? null;
  r.timings[`first_app_response_${L}_ms`] = c.first_app_response_ms ?? null;
  r.timings[`latency_p50_${L}_ms`] = c.latency_p50_ms ?? null;
  r.timings[`echo_${L}_mb_per_s`] = c.echo_mb_per_s ?? null;
}
r.timings.boot_to_monitor_ms = Number((rd("timings.txt").match(/boot_to_mon_ready_ms=(\d+)/) || [])[1]);
r.timings.contention = rd("contention.txt").trim();
// negatives: the wrong-app client (client.mjs), the tampered bundle (the in-guest monitor's answer), and
// the document-level ones judged by judge.mjs on A's saved document
r.negatives.wrongApp = results("A-as-B.client").verdict;
const t = jsonLine("T.load");
r.negatives.tamperedBundle = t && t.error ? t.error : "ACCEPTED";
r.provenance.tamperedBundleRefusedBy = "in-guest monitor (isolation/contract Parse, Go)";
r.provenance.crash = "a bare artifact that is not wasm: the runtime fails and the domain's init exits";
try {
  const saved = JSON.parse(rd("A.doc.json"));
  const spki = Buffer.from(saved.spki, "base64"), nonce = Buffer.from(saved.nonce, "hex");
  const want = { measurement: r.backend.measurement, appSha: r.bundles.A.appId, mode: "trusted", kds: false, runtime: JSON.parse(rd("runtime.json")),
    vcek: fs.readFileSync(path.join(W, "vcek.der")), minTcb: JSON.parse(rd("min-tcb.json")) };
  const product = Object.keys(want.minTcb)[0];
  // AMD's chain for this product line, held locally as client.mjs --amd-chain holds it (the ARK must be the pin)
  const here = path.dirname(new URL(import.meta.url).pathname);
  seedCertChain(product, fs.readFileSync(path.join(here, "..", "..", "test", "fixtures", "amd", `${product}-cert_chain.pem`), "utf8"));
  const v = async (doc) => (await judge(doc, spki, nonce, want)).verdict;
  const d = saved.doc;
  r.negatives.restatedRuntimeVersion = await v({ ...d, runtime: { ...d.runtime, version: "0.0.0" } });
  r.negatives.unauthenticatedCache = await v({ ...d, runtime: { ...d.runtime, cache: "unauthenticated" } });
  const abi1 = { ...d, abi: "enclave-domain-abi/1" }; delete abi1.runtime; delete abi1.runtimeSelfTest;
  r.negatives.abi1Downgrade = await v(abi1);
  r.provenance.baselineVerdict = await v(d);
} catch (e) { r.negatives.documentNegatives = "not judged: " + e.message; }
// lifecycle: from the monitor's own state answers and the serial console
const before = jsonLine("state-before"), afterCrash = jsonLine("state-after-crash"), afterDestroy = jsonLine("state-after-destroy");
const serial = rd("conf.serial");
const badid = (rd("BAD.load").match(/"id":(\d+)/) || [])[1];
r.lifecycle.crashRetiredOnce = (serial.match(new RegExp(`MON domain ${badid} ended`, "g")) || []).length === 1;
r.lifecycle.crashLeavesNothing = !!before && !!afterCrash && before.domains === afterCrash.domains && before.cgroups === afterCrash.cgroups && before.mounts === afterCrash.mounts && before.userspace_procs === afterCrash.userspace_procs;
r.lifecycle.otherUnaffectedAfterCrash = results("B-after-crash.client").verdict === "attested";
r.lifecycle.destroyRemovesFromTable = !!afterDestroy && afterDestroy.domains === 1 && !/"label":"A"/.test(rd("list-after-destroy"));
r.lifecycle.destroyClosesPort = /curl_rc=/.test(rd("A.after-destroy")) && !/APP AAAAA/.test(rd("A.after-destroy"));
r.lifecycle.otherUnaffectedAfterDestroy = results("B-after-destroy.client").verdict === "attested";
r.notes.push("T1: the report is PSP-signed and the AMD chain verified; the monitor image is in the launch measurement on this kernel-hashes path (plain SNP guest, VMPL0)");
fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(JSON.stringify({ platform: r.platform, attest: Object.fromEntries(Object.entries(r.attest).map(([k, v]) => [k, v.verdict])), app: r.app, negatives: r.negatives, lifecycle: r.lifecycle, timings: r.timings }, null, 1));
