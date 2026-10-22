// What production policy configuration each admission bundle resolves (no network: config resolution only).
for (const f of ['./live-66c6e15a.mjs', './faithful-3438cdf2.mjs', './605-6bef372d.mjs']) {
  const m = await import(f);
  let out;
  try { const r = m.resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: 'production' }, chainId: 8453 });
        out = { on: r.on, reason: r.reason, mirrors: r.config?.mirrors?.length, rpcs: r.config?.rpcs?.length, minAgree: r.config?.minAgree }; }
  catch (e) { out = { threw: e.message.slice(0, 160) }; }
  console.log(f, JSON.stringify(out));
}
