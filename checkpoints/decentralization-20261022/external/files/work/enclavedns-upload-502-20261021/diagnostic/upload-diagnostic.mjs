// DIAGNOSTIC ONLY (EnclaveDNS 0.1.5 upload HTTP 502, 2026-10-21). Wraps the handoff's fetch so that an HTTP error answer
// to the EXACT upload POST (t.upload.addUrl) is classified into fixed fields. Everything else passes straight through.
//   - The request is sent once, by the original fetch, with the original arguments: never repeated, retried or changed.
//   - The original Response object is returned unaltered. A CLONE is read: at most `limit` bytes, at most `readMs` ms.
//   - The emitted record holds only numbers, booleans and labels chosen HERE. It never holds request headers, the
//     signature, the token, URLs, paths or any remote text.
//   - Any diagnostic failure (clone, read, oversize, timeout, emit) is swallowed: it never breaks the upload flow.
export const LIMIT = 4096, READ_MS = 3000;

// The adapter's error string (s3-ipfs-adapter upload.rs fail(): {"error":"pin failed: <e>"}) is matched against these
// patterns in order. Only the label leaves this module.
const CATEGORIES = [
  ["writer-quorum", /quorum/i],
  ["fenced", /fenc/i],
  ["out-of-funds", /out of funds|insufficient (?:funds|balance|allowance)|not enough funds/i],
  ["access-denied", /AccessDenied|access denied|InvalidAccessKeyId|SignatureDoesNotMatch|forbidden/i],
  ["badTLS", /\btls\b|certificate|handshake/i],
  ["range", /Range header|resuming at byte|short body|InvalidRange/i],
  ["refused", /connection refused|os error 111\b|os error 10061\b/i],
  ["timeout", /read timeout|deadline exceeded|timed out|timeout/i],
  ["connect", /^pin failed: (?:connect |egress front )|unreachable|connection reset|broken pipe/i],
];
const S3_ANSWERED = /^pin failed: (?:resuming at byte [0-9]{1,15}: )?S3 answered ([1-5][0-9]{2}): /;
const S3_HEAD = /^pin failed: S3 HEAD answered ([1-5][0-9]{2})$/;

/** Fixed fields from what was read. `text` is used for matching only and is never returned. */
export function classify({ status, serverHeader, readState, bytes, text }) {
  const sh = String(serverHeader || "");
  const d = {
    status: Number.isInteger(status) ? status : -1,
    serverHeader: sh === "" ? "absent" : /^caddy$/i.test(sh) ? "caddy" : /^s3-ipfs-adapter\/[0-9.]{1,20}$/.test(sh) ? "adapter" : "other",
    server: "other", readState, bodyBytes: readState === "complete" ? bytes : -1,
    body: readState !== "complete" ? "unread" : bytes === 0 ? "empty" : "nonJSON",
    pinFailed: false, s3Status: null, s3Op: null, category: "other",
  };
  if (readState === "complete" && bytes > 0) {
    let v; try { v = JSON.parse(text); d.body = "JSON"; } catch {}
    const e = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.error === "string" ? v.error : null;
    if (e !== null) {
      d.server = "adapter";
      d.pinFailed = e.startsWith("pin failed: ");
      let m = S3_ANSWERED.exec(e); if (m) { d.s3Status = Number(m[1]); d.s3Op = "answered"; }
      else if ((m = S3_HEAD.exec(e))) { d.s3Status = Number(m[1]); d.s3Op = "head"; }
      for (const [label, re] of CATEGORIES) if (re.test(e)) { d.category = label; break; }
    }
  }
  if (d.server === "other" && d.serverHeader !== "absent" && d.serverHeader !== "other") d.server = d.serverHeader;
  return d;
}

/** Read a clone of `res`: -> { readState: complete|oversize|timeout|error|clone-failed, bytes, text }. Never throws. */
async function readClone(res, limit, readMs) {
  let declared = NaN; try { declared = Number(res.headers.get("content-length") ?? NaN); } catch {}
  if (Number.isFinite(declared) && declared > limit) return { readState: "oversize", bytes: -1, text: "" };
  let clone; try { clone = res.clone(); } catch { return { readState: "clone-failed", bytes: -1, text: "" }; }
  let reader, timer, readState = "complete", n = 0; const parts = [];
  try {
    if (clone.body) {
      reader = clone.body.getReader();
      const deadline = new Promise((r) => { timer = setTimeout(() => r(null), readMs); });
      for (;;) {
        const r = await Promise.race([reader.read(), deadline]);
        if (r === null) { readState = "timeout"; break; }
        if (r.done) break;
        n += r.value.byteLength;
        if (n > limit) { readState = "oversize"; break; }
        parts.push(Buffer.from(r.value));
      }
    }
  } catch { readState = "error"; }
  finally { clearTimeout(timer); try { reader?.cancel().catch(() => {}); } catch {} }
  const text = readState === "complete" ? Buffer.concat(parts).toString("utf8") : "";
  parts.length = 0;
  return { readState, bytes: readState === "complete" ? n : -1, text };
}

/** fetchFn wrapper: only an HTTP >= 400 answer to POST exactly `addUrl` is inspected; `emit(record)` gets fixed fields. */
export function diagnosticFetch(fetchFn, { addUrl, emit, limit = LIMIT, readMs = READ_MS }) {
  return async function fetchWithDiagnostic(url, init) {
    const res = await fetchFn(url, init);   // the one request; a fetch error propagates untouched
    try {
      if (typeof url === "string" && url === addUrl && init?.method === "POST" && Number.isInteger(res?.status) && res.status >= 400) {
        let serverHeader = ""; try { serverHeader = res.headers.get("server") ?? ""; } catch {}
        const r = await readClone(res, limit, readMs);
        const record = classify({ status: res.status, serverHeader, ...r });
        r.text = "";
        emit(record);
      }
    } catch { /* the diagnostic never affects the upload */ }
    return res;
  };
}
