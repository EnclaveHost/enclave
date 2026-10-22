// Public, keyless: ZeroSSL ACME newNonce HEAD and GET (the relay's takeNonce requests), Node fetch like the relay,
// 6 rounds 10 s apart, 25 s per request (relay: 20 s). Records time, status, whether a replay-nonce came back (never the
// value), error name/message. No account, no signed request, no order.
const DIR = "https://acme.zerossl.com/v2/DV90", T = 25000, out = { vantage: process.argv[2], node: process.version, rounds: [] };
const t0 = () => performance.now();
async function one(url, method) {
  const s = t0(), at = new Date().toISOString();
  try { const r = await fetch(url, { method, signal: AbortSignal.timeout(T) }); if (method === "GET") await r.arrayBuffer().catch(() => {});
        return { at, method, status: r.status, nonce: !!r.headers.get("replay-nonce"), ms: Math.round(t0() - s) }; }
  catch (e) { return { at, method, error: `${e.name}: ${String(e.message).slice(0, 120)}`, ms: Math.round(t0() - s) }; }
}
let nonceUrl = null;
const d = await one(DIR, "GET"); out.directory = d;
try { const r = await fetch(DIR, { signal: AbortSignal.timeout(T) }); nonceUrl = (await r.json()).newNonce; } catch (e) { out.directoryJson = e.name; }
nonceUrl ||= DIR + "/newNonce";
out.newNonceUrl = nonceUrl;
for (let i = 0; i < 6; i++) {
  out.rounds.push([await one(nonceUrl, "HEAD"), await one(nonceUrl, "GET")]);
  if (i < 5) await new Promise((r) => setTimeout(r, 10000));
}
console.log(JSON.stringify(out));
