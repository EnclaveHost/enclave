// Output guard: nothing the driver prints or journals may carry a canary marker value (or its hex/base64 encodings),
// a private key, raw sealed state or wallet data. Field NAMES that can only hold such material are refused outright; the
// registered secret VALUES (markers, and the signer key while a step runs) are searched for in every encoding we emit.
const FORBIDDEN_KEYS = /^(private[_-]?key|privkey|secret[_-]?key|mnemonic|seed|seed[_-]?phrase|plaintext|marker[_-]?value|values|env|state[_-]?blob|sealed[_-]?state|keystore|password|registry[_-]?key|submitter[_-]?key|auxblob|report|raw[_-]?quote|chip[_-]?id|host[_-]?sig|identity[_-]?sig|raw[_-]?transaction)$/i;

export function encodingsOf(secret) {
  const b = Buffer.from(String(secret), "utf8");
  const out = new Set([String(secret), b.toString("hex"), b.toString("base64"), b.toString("base64url")]);
  const s = String(secret);
  if (/^(0x)?[0-9a-fA-F]+$/.test(s) && s.replace(/^0x/, "").length % 2 === 0) {
    const raw = Buffer.from(s.replace(/^0x/, ""), "hex");
    for (const e of [raw.toString("hex"), raw.toString("hex").toUpperCase(), raw.toString("base64"), raw.toString("base64url")]) out.add(e);
  }
  // the unpadded base64 forms too: a value embedded mid-string loses its padding
  for (const e of [...out]) if (e.endsWith("=")) out.add(e.replace(/=+$/, ""));
  return [...out].filter((e) => e.length >= 16);
}

export function createGuard() {
  const needles = new Set();
  return {
    register(secret) {
      if (typeof secret !== "string" || secret.length < 16) throw new Error("guard: register high-entropy secrets of at least 16 characters");
      for (const e of encodingsOf(secret)) needles.add(e);
    },
    // throws on the first problem; returns the value unchanged for chaining
    check(value, where = "output") {
      const walkKeys = (x, path) => {
        if (Array.isArray(x)) x.forEach((v, i) => walkKeys(v, `${path}[${i}]`));
        else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) {
          if (FORBIDDEN_KEYS.test(k)) throw new Error(`guard: ${where} has a forbidden field ${path}.${k}`);
          walkKeys(v, `${path}.${k}`);
        }
      };
      if (value && typeof value === "object") walkKeys(value, "$");
      const text = typeof value === "string" ? value : JSON.stringify(value, (k, v) => typeof v === "bigint" ? String(v) : v);
      const lower = text.toLowerCase();
      for (const n of needles) if (text.includes(n) || lower.includes(n.toLowerCase())) throw new Error(`guard: ${where} contains registered secret material`);
      return value;
    },
    size: () => needles.size,
  };
}
