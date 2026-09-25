// windows/node/apptool.mjs -- drive an app inside the enclave by hand, over the enclave host's
// loopback protocol. The bring-up and proof tool for the in-enclave path.
//
//   node apptool.mjs abi
//   node apptool.mjs run  <world> <cwasm> [K=V ...]   (world 4 = a server on its own socket)
//   node apptool.mjs open <world> C:\path\hello.cwasm
//   node apptool.mjs get  <epoch> <id> /hello?name=enclave
//   node apptool.mjs close <epoch> <id>
//
// run/open print the app's id AND the ee-host boot epoch it was opened under; every id-scoped
// command takes both, because ee-host refuses an id presented under another boot's epoch
// ("stale epoch") - an id alone is only unique within one ee-host process.
import net from "node:net";
import { encodeRequest, decodeResponse, parseAppOpenReply } from "./appframe.mjs";

const PORT = Number(process.env.HOST_PORT || 9596);   // the ENCLAVE host's loopback protocol, not the agent's HTTP

function cmd(line) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, "127.0.0.1", () => s.write(line + "\n"));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      s.end();
      const r = buf.slice(0, nl);
      if (r.startsWith("ok")) resolve(r.slice(2).trim());
      else reject(new Error(r.replace(/^err\s*/, "")));
    });
    s.on("error", reject);
    s.setTimeout(120_000, () => { s.destroy(new Error("the enclave host did not answer")); });
  });
}

/** appopen, answered "<id> <load_us> <epoch>" (appframe.mjs parseAppOpenReply). An ee-host without
 *  a valid epoch is refused: its ids cannot be told apart from another process's. */
async function open(world, file, hex = "") {
  const r = parseAppOpenReply(await cmd(`appopen ${world} ${file}${hex ? " " + hex : ""}`));
  if (!r) throw new Error("the enclave host returned no valid app id and epoch (ee-host.exe older than this tool?)");
  return { id: r.id, us: r.loadUs, epoch: r.epoch };
}
const num = (v, what) => { if (!/^[1-9]\d{0,9}$/.test(v || "")) { console.error(`${what} must be a positive number`); process.exit(2); } return v; };
const epochArg = (v) => { if (!/^[0-9a-f]{32}$/.test(v || "")) { console.error("epoch must be the 32 lowercase hex digits run/open printed"); process.exit(2); } return v; };

const [verb, a, b, c] = process.argv.slice(2);
try {
  if (verb === "abi") console.log(`app runtime abi ${await cmd("appabi")}`);
  else if (verb === "run" || verb === "open") {
    const world = Number(a), file = b;
    const envBlob = verb === "run" ? process.argv.slice(5).map((kv) => `${kv}\0`).join("") : "";
    const hex = envBlob ? Buffer.from(envBlob + "\0", "utf8").toString("hex") : "";
    const { id, us, epoch } = await open(world, file, hex);
    console.log(`loaded as app ${id} (epoch ${epoch}) in ${(Number(us) / 1000).toFixed(1)} ms, inside the enclave`);
    if (verb === "run" && world === 4) { await cmd(`apprun ${epoch} ${id}`); console.log(`running: it binds its own port inside the enclave`); }
  } else if (verb === "get") {
    const frame = encodeRequest({ method: "GET", path: c || "/", headers: { "x-from": "apptool" } });
    const t0 = Date.now();
    const [hex, us] = (await cmd(`apphandle ${epochArg(a)} ${num(b, "id")} ${frame.toString("hex")}`)).split(" ");
    const r = decodeResponse(Buffer.from(hex, "hex"));
    console.log(`status ${r.status} in ${(Number(us) / 1000).toFixed(3)} ms inside the enclave (${Date.now() - t0} ms round trip)`);
    for (const [k, v] of Object.entries(r.headers)) console.log(`  ${k}: ${v}`);
    console.log(`body: ${r.body.toString("utf8")}`);
  } else if (verb === "close") { await cmd(`appclose ${epochArg(a)} ${num(b, "id")}`); console.log("unloaded"); }
  else { console.error("usage: apptool.mjs abi | run <world> <cwasm> [K=V ...] | open <world> <cwasm> | get <epoch> <id> <path> | close <epoch> <id>"); process.exit(2); }
} catch (e) { console.error(`failed: ${e.message}`); process.exit(1); }
