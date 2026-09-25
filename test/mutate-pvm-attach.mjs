#!/usr/bin/env node
// mutate-pvm-attach.mjs -- the mutation check behind the owner-side attach co-signer (shielded/anchor/avf/runner/
// attach-cosigner.mjs) and the payload's boot-time instance proof (shielded/anchor/avf/payload/anchor_attach_instance.h,
// anchor_payload.c): each mutation breaks ONE refusal or property the reviewed design states, and the test it names must fail.
// Same shape as test/mutate-pvm-serving.mjs: a COPY of the tree in a temp directory, a CONTROL first, a mutation whose text is
// not found exactly once fails the run. From the repo root:  node test/mutate-pvm-attach.mjs [C01 P02 ...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = { cosign: "test/pvm-attach-cosigner.test.mjs", payload: "test/anchor-attach-instance.test.mjs" };
const T = { ok: "a registered name: no operator signature, no attach", refuse: "the co-signer refuses, and signs nothing", hub: "the hub: a co-signature for nonce N",
            http: "the HTTP wrapper", conc: "never twice, under concurrency", native: "anchor_attach_instance.h, natively", secret: "the instance SECRET never leaves the payload" };
const CS = "shielded/anchor/avf/runner/attach-cosigner.mjs", H = "shielded/anchor/avf/payload/anchor_attach_instance.h", PL = "shielded/anchor/avf/payload/anchor_payload.c";
const MUTATIONS = [
  ["C01", "a nonce signed twice", CS, [["if (signed.has(nonceSha256)) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C02", "a phone-supplied name signed", CS, [["if (req.name !== name) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C03", "the rad not verified (build, authority, nonce, transport key)", CS, [["if (!v.ok) return no(`the rad:", "if (false) return no(`the rad:"]], "cosign", T.refuse],
  ["C04", "another rad format accepted", CS, [["rad.format !== AVF_PAD_FORMAT) return no(", "false) return no("]], "cosign", T.refuse],
  ["C05", "an instance that is not the owner's", CS, [["if (!instanceIds.includes(instanceId)) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C06", "the instance signature not verified", CS, [["if (!iok) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C07", "a non-canonical nonce", CS, [["nonce.toString(\"base64\") !== req.nonce", "false"]], "cosign", T.refuse],
  ["C08", "no rate", CS, [["if (++window.n > rate.max) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C09", "the journal forgotten across a restart", CS, [["const signed = new Set(fs.existsSync(journalFile) ?", "const signed = new Set(false ?"]], "cosign", T.refuse],
  ["C10", "the configured relay not checked (the sanity check)", CS, [["if (req.relay !== relay) return no(", "if (false) return no("]], "cosign", T.refuse],
  ["C11", "the wrapper listens beyond loopback", CS, [["if (![\"127.0.0.1\", \"::1\", \"localhost\"].includes(host))", "if (false)"]], "cosign", T.http],
  ["C12", "the instance signature over B without its domain", CS, [["Buffer.concat([Buffer.from(ATTACH_INSTANCE_DOMAIN), B])", "B"]], "cosign", T.ok],
  ["C13", "the nonce recorded only AFTER the signing await (two concurrent requests both signed)", CS, [["    signed.add(nonceSha256);\n    const operatorSig = await account.signMessage({ message });", "    const operatorSig = await account.signMessage({ message });\n    signed.add(nonceSha256);"]], "cosign", T.conc],
  ["P01", "the payload signs a transcript that is not its own", H, [["|| !sh_avf_pad_binding_valid(bound, blen, tpk, ppk)) return 0;", ") return 0;"]], "payload", T.native],
  ["P02", "the payload signs under another domain", H, [["#define ANCHOR_ATTACH_INSTANCE_DOMAIN \"enclave-pvm-attach-instance-v1\\n\"", "#define ANCHOR_ATTACH_INSTANCE_DOMAIN \"enclave-pvm-instance-sig-v1\\n\""]], "payload", T.native],
  ["P03", "the instance secret printed by the payload", PL, [["            OUT(\"INSTANCEATTACH key=%s sig=%s\", isph, isigh);", "            OUT(\"INSTANCEATTACH key=%s sig=%s\", isph, isigh); { char k[129]; sh_pads_bin2hex(g_isk, 64, k); OUT(\"DEBUG isk=%s\", k); }"]], "payload", T.secret],
  ["P04", "INSTANCEATTACH carries more than the SPKI and the signature", PL, [["OUT(\"INSTANCEATTACH key=%s sig=%s\", isph, isigh);", "OUT(\"INSTANCEATTACH key=%s sig=%s bound=%s\", isph, isigh, bound_hex);"]], "payload", T.secret],
];

const pick = process.argv.slice(2);
const todo = pick.length ? MUTATIONS.filter((m) => pick.includes(m[0])) : MUTATIONS;
if (pick.length && todo.length !== pick.length) { console.error(`unknown mutation id in ${pick.join(" ")}`); process.exit(2); }
const nm = path.join(ROOT, "node_modules"), rnm = path.join(ROOT, "relay", "node_modules");
if (!fs.existsSync(nm) || !fs.existsSync(rnm)) { console.error("the tests need node_modules at the repo root and in relay/ (a worktree: symlink the main checkout's)"); process.exit(2); }
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), "mutate-pvm-attach-"));
const cleanup = () => fs.rmSync(COPY, { recursive: true, force: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const noMods = (src) => path.basename(src) !== "node_modules" && !/\.o$/.test(src);
for (const d of ["relay", "test", "shielded/anchor/avf/runner", "shielded/anchor/avf/payload", "wasm/ggml-shielded/tweetnacl.c", "wasm/ggml-shielded/tweetnacl.h",
                 "wasm/ggml-shielded/shielded-avf-binding.h", "package.json"])
  fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true, filter: noMods });
fs.symlinkSync(fs.realpathSync(nm), path.join(COPY, "node_modules")); fs.symlinkSync(fs.realpathSync(rnm), path.join(COPY, "relay", "node_modules"));
function run(suite) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", SUITES[suite]], { cwd: COPY, encoding: "utf8", timeout: 600000 });
  const out = r.stdout || "";
  return { failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]), ran: /^# tests [1-9]/m.test(out), skipped: /^# skipped [1-9]/m.test(out) };
}
let bad = 0;
try {
  for (const s of Object.keys(SUITES)) {
    const c = run(s), ok = c.ran && !c.skipped && c.failed.length === 0;
    console.log(`${ok ? "ok  " : "FAIL"} control: ${SUITES[s]} passes unmutated, nothing skipped${ok ? "" : ` -- failing: ${c.failed.join(" | ") || "(did not run or skipped)"}`}`);
    if (!ok) bad++;
  }
  if (bad) throw new Error("the control failed: no mutation result would mean anything");
  for (const [id, what, file, edits, suite, expect] of todo) {
    const f = path.join(COPY, file), orig = fs.readFileSync(f, "utf8");
    let src = orig, missing = null;
    for (const [from, to] of edits) { const n = src.split(from).length - 1; if (n !== 1) { missing = `its text occurs ${n} times, not once: ${JSON.stringify(from.slice(0, 60))}`; break; } src = src.replace(from, to); }
    if (missing) { console.log(`FAIL ${id} ${what}: ${missing}`); bad++; continue; }
    fs.writeFileSync(f, src);
    const r = run(suite);
    fs.writeFileSync(f, orig);
    const caught = r.failed.some((t) => t.includes(expect));
    console.log(`${caught ? "ok  " : "FAIL"} ${id} ${what}: ${caught ? `caught by "${expect}…"` : `NOT caught by "${expect}…" (failing: ${r.failed.join(" | ") || "none"})`}`);
    if (!caught) bad++;
  }
} catch (e) { console.log(`FAIL ${e.message}`); bad++; }
finally { cleanup(); }
console.log(bad ? `FAIL: ${bad} problem(s)` : `PASS: controls clean, ${todo.length} of ${todo.length} mutations caught`);
process.exitCode = bad ? 1 : 0;
