// The ONE node:crypto use the host-capacity reader modules make, for the browser bundle (scripts/build-host-capacity-vendor.mjs):
// createHash("sha256").update(text, "utf8").digest("hex") in network/host-capacity-record.mjs hostCapacityHash (replay and
// equivocation floors). Same bytes in, same hex out: viem's SHA-256 (@noble/hashes) over the UTF-8 encoding. Anything else
// throws rather than guess. test/site-host-liveness.test.mjs compares it with Node's createHash.
import { sha256, toBytes } from "viem";

export function createHash(algorithm){
  if (algorithm !== "sha256") throw new Error("the browser bundle provides sha256 only");
  const parts = [];
  return {
    update(data, encoding = "utf8"){
      if (typeof data !== "string" || encoding !== "utf8") throw new Error("the browser bundle hashes UTF-8 text only");
      parts.push(data);
      return this;
    },
    digest(encoding){
      if (encoding !== "hex") throw new Error("the browser bundle returns hex digests only");
      return sha256(toBytes(parts.join(""))).slice(2);
    },
  };
}
