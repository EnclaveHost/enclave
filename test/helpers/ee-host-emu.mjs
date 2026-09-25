// test/helpers/ee-host-emu.mjs -- a loopback stand-in for ONE ee-host process's app line protocol,
// epoch included, for driving the node's real funnel (appframe.mjs makeHostCmd) across restarts.
// It mirrors ee-host.c: appopen mints the next id and answers "<id> <load_us> <epoch>"; apphandle/
// apprun/appstop/appclose must carry "<epoch> <id>" and a stale epoch is refused before any side
// effect. It MIRRORS the C; it does not run it.
import net from "node:net";

export const RESP_200 = Buffer.concat([
  (() => { const b = Buffer.alloc(2); b.writeUInt16LE(200, 0); return b; })(),
  Buffer.alloc(4), Buffer.alloc(4),
]).toString("hex");

// One ee-host process. `port` 0 picks a free port; a restart passes the old one.
export async function emuHost({ port = 0, checkEpoch = true, avoidEpoch = 0 } = {}) {
  let epoch; do { epoch = (Math.random() * 0xffffffff) >>> 0; } while (!epoch || epoch === avoidEpoch);
  const apps = new Map();          // id -> world
  const effects = [];              // side effects executed: { cmd, epoch, id }
  const refused = [];              // commands refused for a stale epoch: { cmd, epoch, id }
  const holds = [];
  const conns = new Set();
  let nextId = 0;
  const answer = (line) => {
    const [cmd, ...a] = line.split(" ");
    if (cmd === "appabi") return "ok 5 7 0";
    if (cmd === "appopen") { const id = ++nextId; apps.set(id, Number(a[0])); effects.push({ cmd, epoch, id }); return `ok ${id} 1000 ${epoch}`; }
    if (["apphandle", "apprun", "appstop", "appclose"].includes(cmd)) {
      // ee-host.c: apphandle needs "<epoch> <id> <hex>" ("bad request"), the rest "<epoch> <id>" ("bad id")
      if (!/^\d+$/.test(a[0] || "") || !/^\d+$/.test(a[1] || "") || (cmd === "apphandle" && a.length < 3))
        return cmd === "apphandle" ? "err bad request" : "err bad id";
      const e = Number(a[0]), id = Number(a[1]);
      if (checkEpoch && e !== epoch) { refused.push({ cmd, epoch: e, id }); return "err stale epoch"; }
      if (!apps.has(id)) return "err no such app";
      effects.push({ cmd, epoch: e, id });
      if (cmd === "appstop" || cmd === "appclose") apps.delete(id);
      return cmd === "apphandle" ? `ok ${RESP_200} 5` : "ok";
    }
    return "err unknown command";
  };
  const server = net.createServer((sock) => {
    conns.add(sock); sock.on("close", () => conns.delete(sock)); sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const reply = () => sock.write(answer(line) + "\n");
        const h = holds.find((x) => !x.taken && x.pred(line));
        if (h) { h.taken = true; h.arrive(reply); } else reply();
      }
    });
  });
  await new Promise((res, rej) => {
    let tries = 0;
    const go = () => {
      const onErr = (e) => { if (e.code === "EADDRINUSE" && tries++ < 100) setTimeout(go, 10); else rej(e); };
      server.once("error", onErr);
      server.listen(port, "127.0.0.1", () => { server.off("error", onErr); res(); });
    };
    go();
  });
  return {
    epoch, apps, effects, refused, port: server.address().port,
    /** The next command matching `pred` is held: its processing and reply wait for release(). */
    hold(pred) {
      const h = { pred, taken: false };
      h.arrived = new Promise((r) => { h.arrive = (reply) => { h.release = reply; r(); }; });
      holds.push(h);
      return h;
    },
    /** The process is going: it accepts nothing more; connections it already accepted live on. */
    stopListening() { server.close(); },
    close() { server.close(); for (const c of conns) c.destroy(); },
  };
}

// An ee-host restart as the agent does it: the generation is bumped first (start.host), the old
// process stops accepting, and a new one binds the same port with ids from 1 and a new epoch.
export async function restart(h1, bumpGen, opts = {}) {
  bumpGen();
  h1.stopListening();
  return await emuHost({ port: h1.port, avoidEpoch: h1.epoch, ...opts });
}

