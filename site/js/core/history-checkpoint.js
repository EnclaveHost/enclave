/* Attested history checkpoints in the browser (work/history-checkpoint-transport-interface.txt): the owner's Startup tab
   fetches the envelope a running SEV-SNP guest serves (CHECKPOINT_PATH) or opens a file, checks it here the way the
   guest's checkpoint.go and verifier/history-checkpoint.mjs read it (exact members, the statement canonical, this
   chain/ledger/deployment, every log inside the range and this deployment's, REPORT_DATA binding exactly this statement,
   HOST_DATA = this deployment), and saves it for the owner's mirror. The AMD evidence itself (the chain to AMD's pinned
   root, a fresh CRL, the measurement and TCB) is NOT judged on this page: the guest that adopts a checkpoint judges it
   against its own measurement and TCB, and `enclave history checkpoint verify` judges it on the owner's machine. The
   result says so every time. */
export const CHECKPOINT_PATH = "/.well-known/enclave-history-checkpoint";
export const MAX_CHECKPOINT_BYTES = 32 << 20;
const TOPICS = new Set([
  "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", // Claimed
  "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e", // Renewed
  "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882", // Released
]);
const word = (s) => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
const b64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const NOT_JUDGED_HERE = "The AMD evidence (its chain to AMD's root, a fresh revocation list, the measurement and TCB) is not judged on this page: the guest that adopts the checkpoint judges it against its own, and `enclave history checkpoint verify` judges it on your machine.";

// JSON.parse, refusing a duplicated key at any depth (the guest refuses one).
function uniqueParse(text){
  const out = JSON.parse(text);
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { const s = i++; while (i < text.length){ if (text[i] === "\\") { i += 2; continue; } if (text[i++] === '"') break; } return JSON.parse(text.slice(s, i)); };
  const walk = (d) => {
    if (d > 64) throw new Error("nesting");
    ws(); const c = text[i];
    if (c === "{"){ i++; const seen = new Set(); ws(); if (text[i] === "}"){ i++; return; }
      for (;;){ ws(); const k = str(); if (seen.has(k)) throw new Error("duplicate key"); seen.add(k); ws(); i++; walk(d + 1); ws(); if (text[i++] === "}") return; } }
    if (c === "["){ i++; ws(); if (text[i] === "]"){ i++; return; } for (;;){ walk(d + 1); ws(); if (text[i++] === "]") return; } }
    if (c === '"'){ str(); return; }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  };
  walk(0);
  return out;
}
// the top-level member `key` as its exact text (the binding covers those bytes)
function rawMember(text, key){
  let i = 0, depth = 0;
  while (i < text.length){
    const c = text[i];
    if (c === '"'){
      let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const s = text.slice(i, j + 1); i = j + 1;
      if (depth === 1 && JSON.parse(s) === key){
        let k = i; while (/\s/.test(text[k])) k++;
        if (text[k] !== ":") continue;
        i = k + 1; while (/\s/.test(text[i])) i++;
        const start = i; let d = 0;
        for (; i < text.length; i++){
          const ch = text[i];
          if (ch === '"'){ i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; continue; }
          if (ch === "{" || ch === "[") d++;
          else if (ch === "}" || ch === "]"){ d--; if (d === 0) return text.slice(start, i + 1); }
        }
        return null;
      }
      continue;
    }
    if (c === "{" || c === "[") depth++; else if (c === "}" || c === "]") depth--;
    i++;
  }
  return null;
}
export const canonicalStatement = (st) => JSON.stringify({ v: st.v, chainId: st.chainId, ledger: st.ledger, deployment: st.deployment, lo: st.lo, hi: st.hi,
  logs: st.logs.map((l) => ({ block: l.block, index: l.index, blockHash: l.blockHash, topics: l.topics, data: l.data })) });
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/* checkCheckpoint(text, { chainId, ledger, deployment }) -> { lo, hi, logs, claims, measurement, product line hint, ... };
   throws the guest's refusal. */
export async function checkCheckpoint(text, { chainId, ledger, deployment }){
  if (typeof text !== "string" || !text.length || text.length > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint size");
  let env;
  try { env = uniqueParse(text); } catch { throw new Error("checkpoint envelope: not an unambiguous JSON object"); }
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("checkpoint envelope: not an unambiguous JSON object");
  for (const k of Object.keys(env)) if (!["statement", "report", "certs", "crl"].includes(k)) throw new Error('checkpoint envelope: unknown member "' + k + '"');
  for (const k of ["report", "certs"]) if (typeof env[k] !== "string") throw new Error("checkpoint envelope: " + k + " missing");
  for (const k of ["report", "certs", "crl"]) if (env[k] !== undefined && (typeof env[k] !== "string" || !b64.test(env[k]))) throw new Error("checkpoint evidence is not base64");
  const statementText = rawMember(text, "statement");
  const st = env.statement;
  if (!statementText || !st || typeof st !== "object" || Array.isArray(st) || !Array.isArray(st.logs)) throw new Error("checkpoint envelope: statement missing");
  if (canonicalStatement(st) !== statementText) throw new Error("checkpoint statement is not in canonical form");
  if (st.v !== 1 || st.chainId !== chainId || st.ledger !== String(ledger).toLowerCase() || st.deployment !== String(deployment).toLowerCase())
    throw new Error("checkpoint statement names another chain, ledger or deployment");
  if (!uint(st.lo) || !uint(st.hi) || st.lo < 1 || st.lo > st.hi || st.logs.length > 100000) throw new Error("checkpoint statement range is invalid");
  let prev = null;
  for (const l of st.logs){
    if (!uint(l.block) || !uint(l.index) || l.block < st.lo || l.block > st.hi || (prev && (l.block < prev.block || (l.block === prev.block && l.index <= prev.index))))
      throw new Error("checkpoint logs are outside the range or out of order");
    if (!Array.isArray(l.topics) || l.topics.length < 2 || l.topics[1] !== st.deployment || !TOPICS.has(l.topics[0])) throw new Error("checkpoint holds a log that is not this deployment's lease log");
    if (!word(l.blockHash) || typeof l.data !== "string" || !/^0x[0-9a-f]*$/.test(l.data) || !l.topics.every(word)) throw new Error("checkpoint log is not canonical");
    prev = l;
  }
  const report = fromB64(env.report);
  if (report.length !== 0x4a0) throw new Error("checkpoint report is not an SEV-SNP attestation report");
  const pre = new TextEncoder().encode("enclave-history-checkpoint-v1\0"), body = new TextEncoder().encode(statementText);
  const msg = new Uint8Array(pre.length + body.length); msg.set(pre); msg.set(body, pre.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
  const rd = report.subarray(0x50, 0x90);
  if (hex(rd) !== hex(digest) + "00".repeat(32)) throw new Error("binding: REPORT_DATA is not this statement's binding");
  if ("0x" + hex(report.subarray(0xc0, 0xe0)) !== st.deployment) throw new Error("host data: HOST_DATA is not the expected deployment");
  return { lo: st.lo, hi: st.hi, logs: st.logs.length, claims: st.logs.filter((l) => l.topics[0] === "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0").length,
    measurement: hex(report.subarray(0x90, 0xc0)), hasCertificates: fromB64(env.certs).length > 0, hasCrl: !!env.crl, notJudged: NOT_JUDGED_HERE };
}

/* The deployment's own name (front/certs.go: the first 4 bytes of its id under the app zone), the default place to fetch. */
export const defaultFront = (deployment) => "https://" + String(deployment).slice(2, 10).toLowerCase() + ".app.enclave.host";

/* fetchCheckpoint(origin) -> text: the running guest's checkpoint (the guest serves it to any origin), bounded. */
export async function fetchCheckpoint(origin, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}){
  const u = new URL(String(origin));
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("the deployment's address must be https, without credentials");
  if (u.pathname === "/" || u.pathname === "") u.pathname = CHECKPOINT_PATH;
  const res = await fetchImpl(u.href, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(u.origin + ": HTTP " + res.status + (res.status === 404 ? " (no checkpoint yet: the guest serves one only once it verified its lease's history)" : ""));
  const len = Number(res.headers.get("content-length"));
  if (len > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint size");
  const text = await res.text();
  if (text.length > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint size");
  return text;
}
