#!/usr/bin/env node
import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);

// network/host-service-ingress.mjs
import fs from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// network/wg-provider/router.mjs
import net from "node:net";

// network/client-hello.mjs
function clientHelloName(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 22 || buf.readUInt16BE(3) > 18432) return false;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return null;
  try {
    let p = 5;
    if (buf[p++] !== 1) return false;
    const length = buf.readUIntBE(p, 3);
    p += 3;
    if (p + length !== end) return false;
    p += 34;
    const sid = buf[p++];
    p += sid;
    const cipher = buf.readUInt16BE(p);
    p += 2 + cipher;
    const comp = buf[p++];
    p += comp;
    if (p === end) return "";
    const extEnd = p + 2 + buf.readUInt16BE(p);
    p += 2;
    if (extEnd !== end) return false;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2);
      p += 4;
      if (p + len > end) return false;
      if (type === 0) {
        if (len < 5 || buf.readUInt16BE(p) !== len - 2 || buf[p + 2] !== 0) return false;
        const n = buf.readUInt16BE(p + 3);
        if (n !== len - 5) return false;
        const name = buf.subarray(p + 5, p + 5 + n).toString("ascii").toLowerCase();
        return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) ? name : false;
      }
      p += len;
    }
    if (p === end) return "";
  } catch {
  }
  return false;
}

// network/wg-provider/router.mjs
function hostHeader(buf) {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return buf.length > 16384 ? "" : null;
  const m = /\r\nhost:[ \t]*([^\r\n:]+)(?::\d+)?[ \t]*\r\n/i.exec(buf.subarray(0, end + 2).toString("latin1"));
  return m ? m[1].trim().toLowerCase() : "";
}
async function createRouter({ port: port2, host = "0.0.0.0", route, tls = true, noSniRoute = null, count = () => {
}, maxConnections = 8192, log = () => {
} }) {
  if (noSniRoute !== null && (!tls || !noSniRoute || !/^127\.\d+\.\d+\.\d+$/.test(noSniRoute.host) || !Number.isInteger(noSniRoute.tls) || noSniRoute.tls < 1 || noSniRoute.tls > 65535)) throw Error("no-SNI recovery route must be a loopback TLS service");
  const sockets = /* @__PURE__ */ new Set();
  const server = net.createServer((socket) => {
    if (sockets.size >= maxConnections) return socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {
    });
    socket.setTimeout(1e4, () => socket.destroy());
    let head = Buffer.alloc(0);
    const read = (chunk) => {
      head = Buffer.concat([head, chunk]);
      if (head.length > 65536) return socket.destroy();
      const name = tls ? clientHelloName(head) : hostHeader(head);
      if (name === null) return;
      socket.removeListener("data", read);
      socket.pause();
      const to = tls && name === "" ? noSniRoute : name && route(name.toLowerCase());
      if (!to) return socket.destroy();
      const local = typeof to === "object";
      const up = local ? net.connect({ host: to.host, port: tls ? to.tls : to.http }) : net.connect({ host: to, port: tls ? 443 : 80 });
      sockets.add(up);
      up.once("close", () => sockets.delete(up));
      const close = () => {
        socket.destroy();
        up.destroy();
      };
      up.on("error", close);
      socket.once("close", close);
      up.once("close", close);
      up.setTimeout(15e3, () => up.destroy());
      const meter = local ? () => {
      } : count;
      up.once("connect", () => {
        up.setTimeout(0);
        socket.setTimeout(0);
        up.write(head);
        meter(to, head.length, 0);
        socket.on("data", (b) => meter(to, b.length, 0));
        up.on("data", (b) => meter(to, 0, b.length));
        socket.pipe(up);
        up.pipe(socket);
        socket.resume();
      });
    };
    socket.on("data", read);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port2, host, resolve);
  });
  return { port: server.address().port, close() {
    server.close();
    for (const s of sockets) s.destroy();
  } };
}

// network/host-service-names.mjs
var HOST_SERVICE_LABELS = Object.freeze({ dir: "directory-replica", boot: "bootstrap-replica", policy: "policy-mirror" });
var HOST_SERVICE_ROLES = Object.freeze(Object.fromEntries(Object.entries(HOST_SERVICE_LABELS).map(([l, r]) => [r, l])));
function isHostServiceName(name, zone = null) {
  const n = String(name || "").toLowerCase();
  const m = /^(dir|boot|policy)-([a-z2-7]{52})\.(.+)$/.exec(n);
  return !!m && (zone === null || m[3] === zone);
}

// network/host-service-ingress.mjs
var port = (v, what, optional = false) => {
  if (optional && (v === null || v === void 0)) return null;
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`host service ingress: ${what} must be a port`);
  return v;
};
function serviceTable(names) {
  if (!names || typeof names !== "object" || Array.isArray(names)) throw new Error("host service ingress: names must map names to ports");
  const entries = Object.entries(names);
  if (!entries.length || entries.length > 8) throw new Error("host service ingress: 1 to 8 names");
  return new Map(entries.map(([n, t]) => {
    if (n !== n.toLowerCase() || !isHostServiceName(n)) throw new Error(`host service ingress: ${JSON.stringify(n)} is not a host service name`);
    if (!t || typeof t !== "object" || Object.keys(t).some((k) => !["http", "tls"].includes(k))) throw new Error(`host service ingress: ${n}: {http, tls?}`);
    return [n, { host: "127.0.0.1", http: port(t.http, `${n}.http`), tls: port(t.tls, `${n}.tls`, true) }];
  }));
}
async function createHostServiceIngress({ names, tlsPort = 0, httpPort = 0, maxConnections = 512, log = () => {
} }) {
  const table = serviceTable(names);
  const tls = await createRouter({
    port: tlsPort,
    host: "127.0.0.1",
    tls: true,
    maxConnections,
    log,
    route: (n) => {
      const t = table.get(n);
      return t && t.tls ? { host: t.host, tls: t.tls, http: t.http } : null;
    }
  });
  const http = await createRouter({
    port: httpPort,
    host: "127.0.0.1",
    tls: false,
    maxConnections,
    log,
    route: (n) => {
      const t = table.get(n);
      return t ? { host: t.host, tls: t.tls || 0, http: t.http } : null;
    }
  });
  return { tlsPort: tls.port, httpPort: http.port, close() {
    tls.close();
    http.close();
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const ingress = await createHostServiceIngress({ names: cfg.names, tlsPort: port(cfg.tlsPort, "tlsPort"), httpPort: port(cfg.httpPort, "httpPort") });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ingress.close();
    process.exit(0);
  };
  const commands = createInterface({ input: process.stdin });
  commands.on("line", (line) => {
    try {
      if (JSON.parse(line).type === "stop") close();
    } catch {
      close();
    }
  });
  commands.once("close", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  console.log(JSON.stringify({ type: "ready", ingress: ingress.tlsPort, redirect: ingress.httpPort }));
}
export {
  createHostServiceIngress,
  serviceTable
};
