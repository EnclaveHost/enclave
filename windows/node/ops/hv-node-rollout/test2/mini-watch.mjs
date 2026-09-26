// mini-watch.mjs - READ-ONLY sampler for TEST2-MINI.md (enclave-5d for enclave-87). It never sends anything but a GET of
// the relay's public /enclaves and WebSocket upgrades to nan's owner-only splice (the xsplice.mjs path), and it holds no key.
//
//   watch:   node mini-watch.mjs watch --test1 <0x…64> --key1 <sha256 hex> [--id2 <0x…64> [--key2 <sha256 hex>]]
//                                      --seconds <n> --out <file.jsonl>
//            One JSON line per sample, each with its own ISO time (warden-host's clock):
//              kind "row": nucbox-k11's row in /enclaves (present, lastSeen, served owners, servesDeployments), every 2 s;
//              kind "t1":  ONE TLS GET to test 1 through /t/nucbox-k11/x/<id>/https, STARTED every 1 s (a probe takes
//                          about 1.5 s, so up to ~2 run at once): x, the HTTP code, the leaf's SPKI sha256, and whether
//                          its chain verifies for <id8>.app.enclave.host (Node's CA store);
//              kind "id2": the same for ID2, every 2 s, but ONLY while the latest row (at most 3 s old) lists ID2 in
//                          servesDeployments. Otherwise the line says `skipped`. So ID2 is never probed when the relay
//                          says it does not serve it: no negative probe is aimed at a live id (enclave-87's hard rule).
//   zero:    node mini-watch.mjs zero
//            The ONE negative probe: the owner-only splice of the ZERO id. The id is hard-wired: it names no deployment,
//            so nothing can be served or changed. With the row attached, the relay's ownerOnlySplice refuses it: 503.
//            (A 404 means the row is absent.)
//   summary: node mini-watch.mjs summary --in <file.jsonl> --key1 <hex> [--id2 <id> --key2 <hex>]
//                                        --add-at <ISO> [--rm-at <ISO>]
//            The PASS lines of TEST2-MINI.md, computed from the JSONL alone (the relay's and warden-host's view; the
//            node.log lines are checked by hand). See summarize().
//
// Run it from a checkout that has `ws` in node_modules (it is resolved from the CURRENT directory, as xsplice.mjs is):
//   cd ~/Projects/enclave && node ~/enclave-bench/wt-hvnode-rollout/windows/node/ops/hv-node-rollout/test2/mini-watch.mjs …
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const ZERO_ID = "0x" + "0".repeat(64);
export const ENCLAVES = "https://api.enclave.host/enclaves";
export const BOX = "https://api.enclave.host/t/nucbox-k11";
export const OPERATOR = "0x389c3f030a209d04d026228d2d053feb75dbadca";
const HEX64 = /^[0-9a-f]{64}$/, ID = /^0x[0-9a-f]{64}$/;

/** nucbox-k11's row, as the relay lists it now -> { present, lastSeen, owners: [{owner, expires}], deps: [{id, until}] } */
export function rowOf(listing) {
  const r = (listing && Array.isArray(listing.enclaves) ? listing.enclaves : []).find((e) => e && e.name === "nucbox-k11");
  if (!r) return { present: false };
  return {
    present: true, lastSeen: r.lastSeen ?? null, ownerOnly: r.ownerOnly === true,
    owners: (Array.isArray(r.served) ? r.served : []).map((e) => ({ owner: String(e.owner).toLowerCase(), expires: e.expires ?? null })),
    deps: (Array.isArray(r.servesDeployments) ? r.servesDeployments : []).map((d) => ({ id: String(d.id).toLowerCase(), until: d.until ?? null })),
  };
}

export async function sampleRow({ fetchImpl = fetch } = {}) {
  const t = new Date().toISOString();
  try {
    const res = await fetchImpl(ENCLAVES, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { t, kind: "row", error: `HTTP ${res.status}` };
    return { t, kind: "row", ...rowOf(await res.json()) };
  } catch (e) { return { t, kind: "row", error: String(e.message || e).slice(0, 60) }; }
}

export const xUrl = (id) => BOX.replace(/^http/, "ws") + `/x/${id}/https`;
export const spkiOfDer = (raw) =>
  crypto.createHash("sha256").update(new crypto.X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })).digest("hex");

/** ONE GET / over TLS inside the splice of `id`. -> { start, end, x, code, spki, ca } (spki = the full sha256, ca = the chain
 *  verified for <id8>.app.enclave.host). deps: { openWs(url) -> ws, wsStream(ws) -> duplex, tlsConnect(opts), spkiOf(raw) } */
export function probeX(id, deps, timeoutMs = 15_000) {
  const host = `${id.slice(2, 10)}.app.enclave.host`, t0 = Date.now();
  return new Promise((resolve) => {
    let done = false, spki = null, ca = null, ws = null;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws && ws.terminate(); } catch {}
      resolve({ start: new Date(t0).toISOString(), end: new Date().toISOString(), spki, ca, ...r });
    };
    const timer = setTimeout(() => finish({ x: "error(timeout)", code: "000" }), timeoutMs);
    try { ws = deps.openWs(xUrl(id)); } catch (e) { return finish({ x: `error(${String(e.message || e).slice(0, 40)})`, code: "000" }); }
    ws.on("unexpected-response", (_q, res) => finish({ x: `refused(${res.statusCode})`, code: "000" }));
    ws.on("error", (e) => finish({ x: `error(${String(e.code || e.message).slice(0, 40)})`, code: "000" }));
    ws.on("open", () => {
      const s = deps.tlsConnect({ socket: deps.wsStream(ws), servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
      s.on("secureConnect", () => {
        ca = s.authorized === true;
        const raw = s.getPeerCertificate(false)?.raw;
        try { if (raw) spki = deps.spkiOf(raw); } catch {}
        s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      s.on("data", (d) => { buf += d; });
      s.on("end", () => finish({ x: "open", code: (/^HTTP\/1\.[01] (\d{3})/.exec(buf) || [])[1] || "000" }));
      s.on("error", (e) => finish({ x: "open", code: "000", cut: String(e.code || e.message).slice(0, 40) }));
    });
  });
}

/** THE negative probe. It takes no id: the zero id is the only target it can reach. */
export async function zeroProbe(deps) { return { t: new Date().toISOString(), kind: "zero", id: ZERO_ID, ...(await probeX(ZERO_ID, deps)) }; }

/** The sampler: `write(line)` gets each JSON object. It ends after `seconds`, or when the `stop` promise resolves. */
export async function watch({ test1, id2 = null, seconds, rowMs = 2000, t1Ms = 1000, id2Ms = 2000, stop = null }, deps, write) {
  if (!ID.test(test1) || test1 === ZERO_ID) throw new Error("--test1 must be test 1's 0x…64 id");
  if (id2 !== null && (!ID.test(id2) || id2 === ZERO_ID || id2 === test1)) throw new Error("--id2 must be ID2's 0x…64 id, not test 1's or zero");
  let row = null;
  const fresh = () => row && row.present && Date.now() - Date.parse(row.t) <= 3000;
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); };
  const timers = [
    setInterval(() => track(sampleRow(deps).then((r) => { row = r; write(r); })), rowMs),
    setInterval(() => track(probeX(test1, deps).then((r) => write({ t: r.start, kind: "t1", ...r }))), t1Ms),
  ];
  if (id2) timers.push(setInterval(() => {
    const t = new Date().toISOString();
    if (!fresh() || !row.deps.some((d) => d.id === id2)) return write({ t, kind: "id2", skipped: "not in the relay's servesDeployments (or no fresh row)" });
    track(probeX(id2, deps).then((r) => write({ t: r.start, kind: "id2", ...r })));
  }, id2Ms));
  track(sampleRow(deps).then((r) => { row = r; write(r); }));
  let end; await Promise.race([new Promise((r) => { end = setTimeout(r, seconds * 1000); }), stop || new Promise(() => {})]); clearTimeout(end);
  for (const t of timers) clearInterval(t);
  // the in-flight samples end on their own timeouts (10 s, 15 s); never wait on a stuck one for ever
  let cap; await Promise.race([Promise.allSettled([...pending]), new Promise((r) => { cap = setTimeout(r, 20_000); })]); clearTimeout(cap);
}

const ok200 = (p, key) => p.x === "open" && p.code === "200" && p.spki === key;
const within = (t, a, b) => { const x = Date.parse(t); return x >= a && x <= b; };
const hasOwner = (r, o) => (r.owners || []).some((e) => e.owner === o);
const hasDep = (r, id) => (r.deps || []).some((d) => d.id === id);

/**
 * The PASS lines of TEST2-MINI.md from the JSONL (the node.log lines are checked by hand):
 *  ADD, window [addAt - 30 s, min(addAt + 240 s, rmAt)]:
 *   - handover = the first row sample listing the delegated owner. The relay bound the new attach between the sample
 *     before it and this one;
 *   - A1 no gap: NO row sample absent; NO test-1 probe refused or unable to open (x != open); and every opened test-1
 *     probe is 200 on key1, EXCEPT at most 2 cut in flight (x=open, no 200, no key but key1's) whose [start, end] overlaps
 *     the handover interval (the relay's newest-wins bind ends the old tunnel's streams: INFO, listed);
 *   - A2 the served owners after the handover are EXACTLY {the operator, the delegated owner}.
 *  REMOVE, from rmAt:
 *   - break = the first row sample at or after rmAt that is absent (break-before-make ends the tunnel first);
 *   - A4 from the break on, NO row sample lists the delegated owner or ID2, and the row is back (present, owners =
 *     [the operator]) within 60 s of the break;
 *   - A5 test 1's gap: first failed probe to first 200 on key1 after it, <= 60 s; every probe started after that is 200;
 *   - ID2 is never probed after the break (the gate).
 *  ID2 (A3): at least 3 consecutive probes 200 on key2 between the handover and rmAt; C1 (the cert) = any of them with ca.
 */
export function summarize(lines, { key1, key2 = null, id2 = null, addAt, rmAt = null, owner = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c" }) {
  const out = [], verdicts = {};
  const rows = lines.filter((l) => l.kind === "row" && !l.error), t1 = lines.filter((l) => l.kind === "t1"), p2 = lines.filter((l) => l.kind === "id2");
  // the ADD window ends at the REMOVE, whichever comes first (enclave-bf's W2: a REMOVE 2-4 min after the ADD is allowed)
  const a = Date.parse(addAt) - 30_000, b = Math.min(Date.parse(addAt) + 240_000, rmAt ? Date.parse(rmAt) - 1 : Infinity);
  const rowsA = rows.filter((r) => within(r.t, a, b)), t1A = t1.filter((p) => within(p.start, a, b));
  const hi = rowsA.findIndex((r) => r.present && hasOwner(r, owner));
  const hand = hi > 0 ? [Date.parse(rowsA[hi - 1].t) - 1000, Date.parse(rowsA[hi].t) + 1000] : null;
  const absentA = rowsA.filter((r) => !r.present), notOpenA = t1A.filter((p) => p.x !== "open");
  const badOpenA = t1A.filter((p) => p.x === "open" && !ok200(p, key1));
  // a CUT (enclave-bf's W1): no 200, and no key but test 1's (none, if cut before the handshake), overlapping the handover.
  // A 200 on any other key is never a cut. At most 2: one in flight at the bind, and one started as it happened.
  const cut = hand ? badOpenA.filter((p) => p.code !== "200" && (p.spki === null || p.spki === key1)
    && Date.parse(p.start) <= hand[1] && Date.parse(p.end) >= hand[0]) : [];
  const unexplained = badOpenA.filter((p) => !cut.includes(p));
  verdicts.A1 = hand && !absentA.length && !notOpenA.length && !unexplained.length && cut.length <= 2 && t1A.length >= 60 ? "PASS" : "FAIL";
  out.push(`A1 ADD no gap: ${verdicts.A1} - ${rowsA.length} row samples (${absentA.length} absent), ${t1A.length} test-1 probes `
    + `(${notOpenA.length} not opened, ${unexplained.length} opened but not 200 on key1 outside the handover, ${cut.length} cut at the handover: INFO); `
    + `handover ${hand ? new Date(hand[0] + 1000).toISOString() + " .. " + new Date(hand[1] - 1000).toISOString() : "NOT SEEN (the owner never appeared)"}`);
  for (const p of [...notOpenA, ...unexplained].slice(0, 5)) out.push(`   FAIL probe ${p.start}..${p.end} x=${p.x} code=${p.code} spki=${String(p.spki).slice(0, 16)}${p.cut ? " cut=" + p.cut : ""}`);
  for (const p of cut) out.push(`   INFO cut at the handover: ${p.start}..${p.end} x=${p.x} code=${p.code}${p.cut ? " cut=" + p.cut : ""}`);
  const after = hi >= 0 ? rowsA.slice(hi).filter((r) => r.present) : [];
  const exact = after.length > 0 && after.every((r) => r.owners.length === 2 && hasOwner(r, OPERATOR) && hasOwner(r, owner));
  verdicts.A2 = exact ? "PASS" : "FAIL";
  out.push(`A2 served owners after the ADD exactly {operator, ${owner.slice(0, 6)}}: ${verdicts.A2} (${after.length} samples)`);
  if (id2) {
    const end = rmAt ? Date.parse(rmAt) : Infinity, start = hand ? hand[0] : Infinity;
    const run = p2.filter((p) => !p.skipped && Date.parse(p.start) >= start && Date.parse(p.start) < end);
    let best = 0, cur = 0; for (const p of run) { cur = ok200(p, key2) ? cur + 1 : 0; best = Math.max(best, cur); }
    verdicts.A3 = best >= 3 ? "PASS" : "FAIL";
    const withCa = run.filter((p) => ok200(p, key2) && p.ca === true);
    verdicts.C1 = withCa.length ? "PASS" : "NOT SEEN";
    out.push(`A3 ID2 served on its own key: ${verdicts.A3} (${run.length} probes, longest run of 200 on key2: ${best})`);
    out.push(`C1 ID2's chain verified: ${verdicts.C1}${withCa.length ? " (first " + withCa[0].start + ")" : ""}`);
  }
  if (rmAt) {
    const r0 = Date.parse(rmAt), rowsR = rows.filter((r) => Date.parse(r.t) >= r0);
    const bi = rowsR.findIndex((r) => !r.present);
    const brk = bi >= 0 ? Date.parse(rowsR[bi].t) : null;
    const since = bi >= 0 ? rowsR.slice(bi) : [];
    const leaked = since.filter((r) => r.present && (hasOwner(r, owner) || (id2 && hasDep(r, id2))));
    const back = since.find((r) => r.present && r.owners.length === 1 && hasOwner(r, OPERATOR));
    const backIn = back ? (Date.parse(back.t) - brk) / 1000 : null;
    verdicts.A4 = bi >= 0 && !leaked.length && back && backIn <= 60 ? "PASS" : "FAIL";
    out.push(`A4 REMOVE break-before-make: ${verdicts.A4} - break ${bi >= 0 ? rowsR[bi].t : "NOT SEEN"}; ${leaked.length} later samples still list ${owner.slice(0, 6)} or ID2; row back with owners [operator] after ${backIn ?? "-"} s`);
    const t1R = t1.filter((p) => Date.parse(p.start) >= r0);
    const f = t1R.findIndex((p) => !ok200(p, key1));
    const rec = f >= 0 ? t1R.findIndex((p, i) => i > f && ok200(p, key1)) : -1;
    const gap = f >= 0 && rec >= 0 ? (Date.parse(t1R[rec].start) - Date.parse(t1R[f].start)) / 1000 : f < 0 ? 0 : null;
    const laterBad = rec >= 0 ? t1R.slice(rec).filter((p) => !ok200(p, key1)) : [];
    verdicts.A5 = gap !== null && gap <= 60 && !laterBad.length && t1R.length >= 60 ? "PASS" : "FAIL";
    out.push(`A5 test 1 across the REMOVE: ${verdicts.A5} - gap ${gap ?? "NOT RECOVERED"} s (expected: break-before-make ends every tunnel), ${laterBad.length} failures after it, ${t1R.length} probes`);
    if (id2) {
      const probed = p2.filter((p) => !p.skipped && brk !== null && Date.parse(p.start) > brk);
      verdicts.gate = probed.length ? "FAIL" : "PASS";
      out.push(`ID2 never probed after the break: ${verdicts.gate} (${probed.length})`);
    }
  }
  return { verdicts, lines: out };
}

function arg(argv, name, def = undefined) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
function realDeps() {
  const req = createRequire(path.join(process.cwd(), "noop.js"));
  const { WebSocket, createWebSocketStream } = req("ws");
  return {
    openWs: (url) => new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10_000 }),
    wsStream: (ws) => createWebSocketStream(ws), tlsConnect: (o) => tls.connect(o), spkiOf: spkiOfDer, fetchImpl: fetch,
  };
}

export async function main(argv, deps = null) {
  const cmd = argv[0];
  if (cmd === "zero") { const r = await zeroProbe(deps || realDeps()); console.log(JSON.stringify(r)); return r.x === "refused(503)" ? 0 : 1; }
  if (cmd === "watch") {
    const test1 = String(arg(argv, "--test1", "")).toLowerCase(), id2 = arg(argv, "--id2") ? String(arg(argv, "--id2")).toLowerCase() : null;
    const out = arg(argv, "--out"), seconds = Number(arg(argv, "--seconds"));
    if (!out || !(seconds > 0 && seconds <= 7200)) throw new Error("watch needs --out <file> and --seconds <1..7200>");
    const fd = fs.openSync(out, "a");
    // Ctrl-C ends the run early and cleanly: the timers stop, the in-flight samples finish, every line is whole
    const stop = new Promise((r) => process.once("SIGINT", r));
    await watch({ test1, id2, seconds, stop }, deps || realDeps(), (l) => { fs.writeSync(fd, JSON.stringify(l) + "\n"); });
    fs.closeSync(fd); return 0;
  }
  if (cmd === "summary") {
    const key1 = String(arg(argv, "--key1", "")).toLowerCase(), key2 = arg(argv, "--key2") ? String(arg(argv, "--key2")).toLowerCase() : null;
    if (!HEX64.test(key1) || (key2 !== null && !HEX64.test(key2))) throw new Error("--key1/--key2 are full sha256 hex");
    const lines = fs.readFileSync(arg(argv, "--in"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const s = summarize(lines, { key1, key2, id2: arg(argv, "--id2") ? String(arg(argv, "--id2")).toLowerCase() : null, addAt: arg(argv, "--add-at"), rmAt: arg(argv, "--rm-at") || null });
    for (const l of s.lines) console.log(l);
    const bad = Object.entries(s.verdicts).filter(([k, v]) => k !== "C1" && v !== "PASS");
    console.log(`TEST2-MINI (from the relay's and warden-host's view): ${bad.length ? "FAIL (" + bad.map(([k]) => k).join(", ") + ")" : "PASS"}`);
    return bad.length ? 1 : 0;
  }
  console.error("usage: mini-watch.mjs watch|zero|summary …  (see the header)"); return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
}
