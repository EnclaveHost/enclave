// A protocol-exact stand-in for `vbslike-host wmiserve` (WMISERVE-PROTOCOL.md), for wmiserve-run.test.mjs and the
// launcher's tests. It hashes the REAL bundle file it is given, as wmiserve does, and FAKE_WMISERVE (env) makes it
// misbehave in one named way. With `--hold stdin` it serves until a stdin line or EOF, then prints {"step":"closed"}.
import fs from "node:fs";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const mode = process.env.FAKE_WMISERVE || "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// --hold as the real binary takes it (d1's 15338081): "stdin", or whole seconds 1..86400, or absent (120). Anything else
// is refused with exit 2 BEFORE anything is read or printed.
const hold = arg("--hold");
if (hold !== null && hold !== "stdin" && !(/^[0-9]+$/.test(hold) && Number(hold) >= 1 && Number(hold) <= 86400)) {
  process.stderr.write(`wmiserve: --hold ${hold}: expected "stdin" or 1..86400 seconds\n`); process.exit(2);
}
const vm = arg("--vm"), tcp = Number(arg("--tcp"));
const app = crypto.createHash("sha256").update(fs.readFileSync(arg("--bundle"))).digest("hex");
if (process.env.FAKE_WMISERVE_ARGS) fs.writeFileSync(process.env.FAKE_WMISERVE_ARGS, JSON.stringify(argv));

if (mode === "exit-early") { out({ step: "launcher", key: Buffer.alloc(32, 7).toString("base64"), vm }); process.exit(3); }
if (mode === "not-json") { process.stdout.write("launcher key=abc\n"); }
out({ step: "launcher", key: Buffer.alloc(32, 7).toString("base64"), vm: mode === "wrong-vm" ? "00000000-0000-0000-0000-000000000000" : vm });
if (mode === "out-of-order") out({ step: "load", ok: true, id: 1, appSha256: app, guestPort: 40001, agreed: true });
out({ step: "report-service", port: 9001, bound: mode !== "report-unbound", ...(mode === "report-unbound" ? { error: "os error 10013" } : {}) });
if (mode === "load-fail") { out({ step: "load", ok: false, error: "hash disagreement: the domain was destroyed (load-reclaim)" }); process.exit(1); }
out({ step: "load", ok: true, id: 1, guestPort: 40001,
      appSha256: mode === "wrong-app" ? "ee".repeat(32) : app, agreed: mode !== "not-agreed",
      ...(mode === "no-boot" ? {} : { boot: mode === "bad-boot" ? "xyz" : "39725c19e15c91afe488ce62251055f5" }) });
out({ step: "relay", ok: true, tcp: mode === "relay-wrong-port" ? tcp + 1 : tcp, guestPort: 40001 });
if (mode === "hang") { setInterval(() => {}, 1 << 30); }
else {
  out({ step: "ready", note: "T0-hv: launcher-signed, host_excluded=no" });
  if (mode === "ignore-stdin") { process.stdin.resume(); setInterval(() => {}, 1 << 30); }
  else {
    let done = false, pending = "";
    // FAKE_WMISERVE_CLOSED (a file): which path closed it, "line" | "eof" | "time", so a test can tell them apart
    const close = (by) => { if (done) return; done = true; if (process.env.FAKE_WMISERVE_CLOSED) fs.writeFileSync(process.env.FAKE_WMISERVE_CLOSED, by);
                            out({ step: "closed" }); process.exit(0); };
    // stdin, as the real binary reads it: a NON-BLANK line ends serving and a blank one is ignored; with --hold stdin,
    // EOF or an error ends it too. A numeric hold ends at its time, and a non-blank line still ends it early.
    process.stdin.on("data", (d) => { pending += d; let i;
      while ((i = pending.indexOf("\n")) >= 0) { const l = pending.slice(0, i).trim(); pending = pending.slice(i + 1); if (l) return close("line"); } });
    if (hold === "stdin") { process.stdin.on("end", () => close("eof")); process.stdin.on("error", () => close("eof")); }
    else setTimeout(() => close("time"), 1000 * Number(hold ?? 120));
  }
}
