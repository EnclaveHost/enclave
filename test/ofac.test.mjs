// OFAC SDN screening (relay/ofac.js): parser on a real-shaped XML fragment,
// the fail-closed stale/hit/clear answers, and the refresh sanity gates
// (empty and shrunken parses must never blank the live screen).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// a trimmed real sdn.xml shape (the Tornado Cash entry's structure)
const SDN_XML = (addrs) => `<?xml version="1.0"?>
<sdnList>
  <publshInformation><Publish_Date>07/18/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry><uid>39796</uid><lastName>TORNADO CASH</lastName><sdnType>Entity</sdnType>
    <idList>
      ${addrs.map((a, i) => `<id><uid>${i}</uid><idType>Digital Currency Address - ETH</idType><idNumber>${a}</idNumber></id>`).join("\n      ")}
      <id><uid>90</uid><idType>Digital Currency Address - XBT</idType><idNumber>12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h</idNumber></id>
      <id><uid>91</uid><idType>Website</idType><idNumber>tornado.cash</idNumber></id>
    </idList>
  </sdnEntry>
</sdnList>`;
const A1 = "0x8589427373D6D84E98730D7795D8f6f8731FDA16";
const A2 = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";

test("ofac: parser extracts EVM addresses (lowercased) and the publish date; non-EVM stays out of the ETH set", async () => {
  const { parseSdnXml } = await import("../relay/ofac.js");
  const p = parseSdnXml(SDN_XML([A1, A2]));
  assert.deepEqual(p.eth, [A1.toLowerCase(), A2.toLowerCase()]);
  assert.equal(p.publishDate, "07/18/2026");
  assert.equal(p.other.length, 1);
  assert.match(p.other[0], /^XBT:/);
});

test("ofac: cache-seeded screen answers hit/clear; absent or old data answers stale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofac-"));
  process.env.OFAC_SDN_URLS = "http://127.0.0.1:1/x";        // dead: only the cache answers
  const { initOfac, screenAddress } = await import("../relay/ofac.js?seed");
  assert.equal(screenAddress(A1).result, "stale");           // nothing loaded yet

  fs.writeFileSync(path.join(dir, "ofac-sdn.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(), publishDate: "test", source: "seed",
    eth: [A1.toLowerCase()], other: [] }));
  initOfac(dir);
  assert.equal(screenAddress(A1).result, "hit");
  assert.equal(screenAddress(A1.toUpperCase().replace("0X", "0x")).result, "hit");   // case-insensitive
  assert.equal(screenAddress(A2).result, "clear");

  // age the cache past OFAC_MAX_AGE_SEC (48h): stale again, fails closed
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ofac-"));
  fs.writeFileSync(path.join(dir2, "ofac-sdn.json"), JSON.stringify({
    fetchedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), publishDate: "old", source: "seed",
    eth: [A1.toLowerCase()], other: [] }));
  initOfac(dir2);
  assert.equal(screenAddress(A1).result, "stale");
  assert.equal(screenAddress(A2).result, "stale");
});

test("ofac: a refresh that parses empty or sharply shrunken is refused; a sane one is adopted", async (t) => {
  let payload = SDN_XML([]);                                  // no EVM addresses at all
  const server = http.createServer((req, res) => { res.end(payload); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  process.env.OFAC_SDN_URLS = `http://127.0.0.1:${server.address().port}/sdn.xml`;
  const { initOfac, refreshSdn, screenAddress } = await import("../relay/ofac.js?guard");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofac-"));
  const cacheFile = path.join(dir, "ofac-sdn.json");
  const seeded = { fetchedAt: new Date().toISOString(), publishDate: "seed", source: "seed",
    eth: [A1, A2, "0x" + "33".repeat(20), "0x" + "44".repeat(20)].map((a) => a.toLowerCase()), other: [] };
  fs.writeFileSync(cacheFile, JSON.stringify(seeded));
  initOfac(dir);                                              // also fires a refresh against the empty payload
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(screenAddress(A1).result, "hit", "empty parse must not blank the screen");
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).eth.length, 4, "cache untouched");

  payload = SDN_XML([A1]);                                    // 4 -> 1 = >50% shrink: refused
  assert.equal(await refreshSdn(), false);
  assert.equal(screenAddress(A2).result, "hit", "shrunken parse refused, old set still live");

  payload = SDN_XML([A1, A2, "0x" + "55".repeat(20)]);        // 4 -> 3: plausible daily change, adopted
  assert.equal(await refreshSdn(), true);
  assert.equal(screenAddress("0x" + "55".repeat(20)).result, "hit");
  assert.equal(screenAddress("0x" + "33".repeat(20)).result, "clear");   // delisted address dropped
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).eth.length, 3, "cache rewritten atomically");
});
