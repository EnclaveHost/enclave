// Fixed categories only. Never emit request data or arbitrary response text.
export function classifyUploadFailure(status, server, body, readState = 'read') {
  const d = {status, server: /s3-ipfs-adapter/i.test(server) ? 'adapter' : /caddy/i.test(server) ? 'caddy' : 'other', readState, body: body === '' ? 'empty' : 'non-json', pinFailed: false, category: 'other'};
  let e = ''; try { const v = JSON.parse(body); d.body = 'json'; e = typeof v.error === 'string' ? v.error : ''; } catch {}
  d.pinFailed = e.startsWith('pin failed:');
  const m = e.match(/\bS3 (?:HEAD )?answered ([1-5][0-9]{2})\b/); if (m) d.s3Status = Number(m[1]);
  const cats = [['timeout', /timeout|timed out|deadline/i], ['access-denied', /access.?denied|forbidden|unauthorized/i], ['out-of-funds', /insufficient.*fund|out of funds|insufficient balance/i], ['writer-quorum', /write.*quorum|quorum.*writ/i], ['fenced', /fenc/i], ['range', /range/i], ['bad-tls', /TLS|certificate/i], ['refused', /refused/i], ['connect', /connect|dial/i]];
  for (const [category, re] of cats) if (re.test(e)) { d.category = category; break; }
  return d;
}
export function diagnosticFetch(fetchFn, uploadUrl, emit) {
  return async (url, init) => {
    const res = await fetchFn(url, init);
    if (String(url) !== uploadUrl || init?.method !== 'POST' || res.status < 400) return res;
    let reader, timer, body = '', state = 'read';
    try {
      reader = res.clone().body?.getReader();
      if (reader) {
        const chunks = []; let n = 0;
        const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('bounded')), 3000); });
        while (true) {
          const r = await Promise.race([reader.read(), limit]); if (r.done) break;
          n += r.value.byteLength; if (n > 4096) { state = 'oversize'; break; } chunks.push(r.value);
        }
        if (state === 'read') body = Buffer.concat(chunks).toString('utf8');
      }
    } catch { state = 'unavailable'; }
    finally { clearTimeout(timer); try { reader?.cancel().catch(() => {}); } catch {} }
    try { emit(classifyUploadFailure(res.status, res.headers.get('server') || '', body, state)); } catch {}
    return res;
  };
}
