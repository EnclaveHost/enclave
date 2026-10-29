// Embed behind the host's authenticated HTTPS listener, or bind to loopback.
// The assigned operator signs the exact permit; the server never accepts a
// caller-supplied authority snapshot or arbitrary signing payload.
export function lifecycleWitnessHandler(witness, { maxInflight = 8, bodyBytes = 65536, bodyTimeoutMs = 3000 } = {}) {
  let inflight = 0;
  return async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || !['/lifecycle/permit', '/lifecycle/generation'].includes(req.url)) return reply(404, { error: 'not found' });
    if (inflight >= maxInflight) return reply(503, { error: 'witness busy' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return reply(415, { error: 'JSON required' });
    ++inflight;
    const timer = setTimeout(() => req.destroy(Error('request body timeout')), bodyTimeoutMs);
    try {
      let bytes = 0; const parts = [];
      for await (const part of req) {
        bytes += part.length;
        if (bytes > bodyBytes) { req.destroy(); throw Error('request too large'); }
        parts.push(part);
      }
      clearTimeout(timer);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (req.url === '/lifecycle/permit') {
        if (!body || Object.keys(body).sort().join(',') !== 'operatorSignature,record') throw Error('exact permit request required');
        reply(200, await witness.permit(body.record, body.operatorSignature));
      } else {
        if (!body || Object.keys(body).sort().join(',') !== 'actorSignature,intent,predecessors,record') throw Error('exact generation request required');
        reply(200, await witness.generation(body));
      }
    } catch { reply(403, { error: 'permit refused' }); }
    finally { clearTimeout(timer); --inflight; }
  };
}
