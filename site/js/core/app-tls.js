// A successful browser fetch proves a trusted HTTPS connection, even for a 401/404.
// A rejected fetch cannot distinguish DNS, TLS, timeout, or an app that closes without
// an HTTP response. Keep that outcome unknown; never infer an invalid certificate.
export function openStateOf(tls) {
  return tls?.state === "ok" ? "ok" : "noanswer";
}

export async function probeAppTls(endpoint, { fetchFn = fetch, timeoutMs = 4000 } = {}) {
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
