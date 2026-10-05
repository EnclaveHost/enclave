export function localUpstream(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('upstream must be a loopback HTTP origin');
  return u.origin;
}
