#!/usr/bin/env node
// The actual ipns-publisher wasm component's anchor reader (src/anchor.rs over src/webreq.rs + rustls) against the
// owner-chosen PUBLIC Base RPCs, read-only. No ReleaseAnchor exists on Base yet, so the probe points `releaseAnchor` at
// a pinned, existing contract (the deployments ledger, codeHash from the owner profile): a round then exercises chain
// identity, heads, quorum agreement on one block and eth_getCode BY THAT BLOCK HASH (keccak checked in wasm against
// the pin), and stops at eth_call(state()) by the same hash, which the ledger reverts (it has no state()). With a
// wrong codeHash pin the round must refuse every endpoint on the code hash instead.
//
// Three runs: (1) wasmtime with host sockets (-Sinherit-network; the local path, not the fleet), (2) the same with a
// wrong pin, (3) through a LOOPBACK SOCKS5 front speaking the fleet egress protocol (user/pass, ATYP DOMAIN), which
// exercises src/egress.rs socks_connect: the code path a fleet deployment uses, not the fleet's own front.
// The probe key is random, there are no delegates and no DHT: nothing can be published anywhere.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHER_WASM, WORKSPACE_PROFILE } from "../lib/paths.mjs";
const WS = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const WASM = PUBLISHER_WASM;
const profile = JSON.parse(readFileSync(process.env.AUTHORITY_PROFILE ?? WORKSPACE_PROFILE, "utf8"));
const ledger = profile.contracts.deployments;
const TMP = mkdtempSync(join(tmpdir(), "wasm-probe-"));
const CWASM = join(TMP, "p.cwasm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/** A minimal SOCKS5 front: user/pass auth (RFC 1929) then CONNECT, logging each target; pipes to the real host. */
function socksFront(log) {
  return new Promise((resolve) => {
    const srv = net.createServer((c) => {
      let buf = Buffer.alloc(0), stage = 0;
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 3) { // greeting
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
          c.write(Buffer.from([5, 2])); stage = 1;
        }
        if (stage === 1 && buf.length >= 2) { // user/pass
          const ul = buf[1]; if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
          const user = buf.subarray(2, 2 + ul).toString();
          buf = buf.subarray(3 + ul + pl);
          c.write(Buffer.from([1, user === "probe" ? 0 : 1])); stage = 2;
        }
        if (stage === 2 && buf.length >= 5) { // CONNECT
          const atyp = buf[3];
          let host, off;
          if (atyp === 3) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
          else if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join("."); off = 8; }
          else { c.destroy(); return; }
          const port = buf.readUInt16BE(off);
          const rest = buf.subarray(off + 2);
          log.push({ atyp: atyp === 3 ? "DOMAIN" : "IPv4", host, port });
          stage = 3;
          c.removeListener("data", onData);
          const up = net.connect(port, host, () => {
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) up.write(rest);
            c.pipe(up); up.pipe(c);
          });
          up.on("error", () => { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); });
          c.on("error", () => up.destroy());
        }
      };
      c.on("data", onData);
      c.on("error", () => {});
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function run(label, { codeHash, egress }) {
  const port = await freePort();
  const cfg = {
    ipnsKey: randomBytes(32).toString("hex"), delegates: [], dht: false, lifetimeSecs: 172800,
    releaseAnchor: {
      chainId: profile.chainId, contract: ledger.address, codeHash,
      rpcs: profile.review.rpcHosts.map((h) => `https://${h}`), quorum: 2, confirmations: 6,
      maxBlockAgeSecs: 120, authorityTtlSecs: 43200, pollSecs: 120, sequenceOffset: 0, rpcTimeoutSecs: 10,
    },
  };
  const args = ["run", "-Scli", "-Stcp", "-Sinherit-network", "-Sallow-ip-name-lookup",
    "--env", `ENCLAVE_PORTS=http:8000=${port}`, "--env", `IPNSPUB_CONFIG=${JSON.stringify(cfg)}`];
  if (egress) args.push("--env", `ENCLAVE_EGRESS=${egress}`);
  args.push("--allow-precompiled", CWASM);
  const logFile = join(TMP, `${label}.log`);
  const chunks = [];
  const p = spawn("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => chunks.push(d)); p.stderr.on("data", (d) => chunks.push(d));
  const t0 = Date.now();
  let s = null;
  try {
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      try {
        s = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
        if (s.anchor.roundsOk + s.anchor.roundsFailed >= 1) break;
      } catch {}
    }
  } finally { p.kill("SIGKILL"); }
  const log = Buffer.concat(chunks).toString();
  writeFileSync(logFile, log);
  return {
    label, roundSecs: (Date.now() - t0) / 1000, egress: egress ? "loopback SOCKS5 front (fleet egress protocol)" : "host sockets (wasmtime -Sinherit-network)",
    authorityMode: s?.authorityMode, roundsOk: s?.anchor.roundsOk, roundsFailed: s?.anchor.roundsFailed, lastError: s?.anchor.lastError,
    endpoints: s?.anchor.endpoints, publishedAt: s?.publishedAt, logTail: log.trim().split("\n").filter((l) => /anchor/.test(l)).slice(-3),
  };
}

const out = { kind: "wasm-probe", wasm: WASM.replace(WS + "/", ""), wasmSha256: execFileSync("sha256sum", [WASM], { encoding: "utf8" }).split(" ")[0],
  wasmtime: execFileSync("wasmtime", ["--version"], { encoding: "utf8" }).trim(), contract: ledger.address, codeHash: ledger.codeHash,
  rpcs: profile.review.rpcHosts, startedAt: new Date().toISOString(), runs: [] };
execFileSync("wasmtime", ["compile", WASM, "-o", CWASM]);
out.runs.push(await run("native-sockets", { codeHash: ledger.codeHash }));
out.runs.push(await run("wrong-pin", { codeHash: "0x" + "00".repeat(31) + "01" }));
const connects = [];
const front = await socksFront(connects);
out.runs.push({ ...(await run("socks-front", { codeHash: ledger.codeHash, egress: `socks5://probe:token@127.0.0.1:${front.address().port}` })), socksConnects: connects });
front.close();
out.finishedAt = new Date().toISOString();
rmSync(TMP, { recursive: true, force: true });
const file = process.argv[2];
if (file) writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
