// Canonical JSON and hashes for plans and journals. Keys are sorted, bigints become decimal strings tagged "n:", and
// undefined is refused, so a plan hash never depends on insertion order or on a value that JSON would drop silently.
import { createHash } from "node:crypto";

export function canonical(value) {
  const walk = (x) => {
    if (x === undefined) throw new Error("canonical: undefined is not allowed");
    if (typeof x === "bigint") return `n:${x}`;
    if (typeof x === "number" && !Number.isSafeInteger(x)) throw new Error("canonical: only safe integers");
    if (typeof x === "function" || typeof x === "symbol") throw new Error("canonical: not data");
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      if (Buffer.isBuffer(x) || x instanceof Uint8Array) throw new Error("canonical: encode bytes as 0x hex first");
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    }
    return x;
  };
  return JSON.stringify(walk(value));
}

export const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
export const hashOf = (domain, value) => sha256hex(`${domain}\n${canonical(value)}`);
