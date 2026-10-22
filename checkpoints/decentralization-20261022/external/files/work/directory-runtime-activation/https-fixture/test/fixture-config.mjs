// TEST-ONLY rewrite of a REAL host Caddyfile (baseline/<host>.Caddyfile or result/<host>.Caddyfile) into a runnable
// loopback fixture. Every substitution is enumerated, counted and applied identically to baseline and result, so the two
// fixture configs differ by exactly the reviewed fragment (directory port substituted). Nothing here is deployed.
//   - admin socket, http/https ports -> per-run values; local_certs + skip_install_trust + file storage in the run dir
//   - every `tls { issuer acme {...} }` -> `tls internal` (no ACME, no network)
//   - /opt/enclave-site/ -> a fixture tree
//   - control tunnel https://127.0.0.1:30443 -> a fake legacy API (TLS for api.enclave.host from a per-run CA, which the
//     transport trusts via tls_trust_pool); tls_server_name and Host api.enclave.host are kept
//   - 127.0.0.1:8189 (IPFS bootstrap gateway) -> fixture; 127.0.0.1:8188 (local directory) -> the real directory server
//   - external upstreams (https://7ae476a3.app.enclave.host, peer http://<ip> ACME hops) -> a recording sink
export function fixtureConfig(text, {adminSock, httpPort, httpsPort, storage, siteRoot, legacyPort, legacyCaFile, ipfsPort, directoryPort, sinkPort}) {
  const counts = {};
  const sub = (name, re, to, expect) => {
    let n = 0;
    text = text.replace(re, (...m) => { n++; return typeof to === 'function' ? to(...m) : to; });
    counts[name] = n;
    if (expect !== undefined && n !== expect) throw Error(`fixture substitution ${name}: ${n} != ${expect}`);
  };
  sub('admin', /^    admin unix\/\/run\/enclave-bootstrap-tls\/admin\.sock$/m,
    `    admin unix/${adminSock}\n    local_certs\n    skip_install_trust\n    storage file_system ${storage}`, 1);
  sub('http_port', /^    http_port 28080$/m, `    http_port ${httpPort}`, 1);
  sub('https_port', /^    https_port 28443$/m, `    https_port ${httpsPort}`, 1);
  sub('tls_acme', /    tls \{\n        issuer acme \{\n(?:            [a-z_ ]+\n)+        \}\n    \}\n/g, '    tls internal\n', 4);
  sub('site_root', /\/opt\/enclave-site\//g, siteRoot.replace(/\/?$/, '/'));
  sub('control_tunnel', /reverse_proxy https:\/\/127\.0\.0\.1:30443 \{\n            transport http \{\n                tls_server_name api\.enclave\.host\n/g,
    `reverse_proxy https://127.0.0.1:${legacyPort} {\n            transport http {\n                tls_server_name api.enclave.host\n                tls_trust_pool file ${legacyCaFile}\n`, 1);
  sub('ipfs_gateway', /reverse_proxy 127\.0\.0\.1:8189\b/g, `reverse_proxy 127.0.0.1:${ipfsPort}`, 2);
  sub('directory', /reverse_proxy 127\.0\.0\.1:8188\b/g, `reverse_proxy 127.0.0.1:${directoryPort}`);
  sub('external_app', /reverse_proxy https:\/\/7ae476a3\.app\.enclave\.host\b/g, `reverse_proxy http://127.0.0.1:${sinkPort}`, 2);
  sub('peer_acme', /reverse_proxy http:\/\/(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, `reverse_proxy http://127.0.0.1:${sinkPort}`, 3);
  // Anything still pointing off-box would be a fixture escape.
  const left = text.match(/reverse_proxy (?!127\.0\.0\.1:|http:\/\/127\.0\.0\.1:|https:\/\/127\.0\.0\.1:)\S+/g);
  if (left) throw Error('fixture leaves non-loopback upstreams: ' + left.join(', '));
  if (/issuer acme/.test(text)) throw Error('fixture leaves an ACME issuer');
  return {text, counts};
}
