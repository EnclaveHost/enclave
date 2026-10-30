// A successful browser fetch proves a trusted HTTPS connection, even for a 401/404.
// A rejected fetch cannot distinguish DNS, TLS, timeout, or an app that closes without
// an HTTP response. Keep that outcome unknown; never infer an invalid certificate.
export function openStateOf(tls) {
  return tls?.state === "ok" ? "ok" : "noanswer";
}

// A slow answer still proves the connection: a busy single-threaded app (the s3-ipfs-adapter while it re-hashes its bucket
// answers in 5-8 s, 2026-10-13) must not read as "no certificate" on the dashboard, so the probe waits up to 15 s.
export const PROBE_TIMEOUT_MS = 15000;
export async function probeAppTls(endpoint, { fetchFn = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const origin = new URL(endpoint);
  if (origin.protocol !== "https:") throw new TypeError("TLS probes require HTTPS");
  // The adapter and publisher have lightweight GET health routes. They need not
  // implement HEAD or serve their root; other apps retain the root HEAD fallback.
  let error;
  for (const [path, method] of [["/healthz", "GET"], ["/", "HEAD"]]) {
    try {
      await fetchFn(new URL(path, origin).href, {
        method, mode: "no-cors", cache: "no-store", credentials: "omit",
        // no-cors requires follow. The HTTPS dashboard blocks mixed-content redirects.
        redirect: "follow", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { state: "ok" };
    } catch (e) { error = e?.name || "Error"; }
  }
  return { state: "noanswer", error };
}
