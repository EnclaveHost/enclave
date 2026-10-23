"""The ONE manual resolution of composing A df8fbafae onto C/F: runner.mjs policyCarrierFetch. C (0757085e) added an
injected `snapshot` (its gate's own authority, the verifier seam); A added the configured chainAuthority. Keep both:
injected snapshot first, else the configured authority; the RPC requirement only in legacy mode. stdin -> stdout."""
import sys
s = sys.stdin.read()
a = s.index("<<<<<<< ours\n  const { book, hostOwnership, rpcs, minAgree } = resolved.config;")
b = s.index(">>>>>>> A-df8fbafae\n", a) + len(">>>>>>> A-df8fbafae\n")
s = s[:a] + """  // the authority: an injected snapshot (the caller's gate's own) wins; else the configured one - the local verifier when
  // chainAuthority is 'verifier' (no RPC used), or the policy's RPC quorum (never relaxed)
  const { book, hostOwnership, rpcs, minAgree, chainAuthority, chainVerifier } = resolved.config;
  if (!snapshot && chainAuthority !== 'verifier' && (!rpcs || !rpcs.length)) fail('platform host policy carriers need the policy\\'s RPC quorum (platformHostPolicyRpcs or the platform\\'s rpcs)');
""" + s[b:]
i = s.index("<<<<<<< ours\n  const verify"); j = s.index(">>>>>>> A-df8fbafae\n", i) + len(">>>>>>> A-df8fbafae\n")
s = s[:i] + "  const verify = pcm.freshVerifier({ snapshot: snapshot || hostPolicySnapshot({ rpcs, minAgree, chainAuthority, chainVerifier }), book, hostOwnership });\n" + s[j:]
assert '<<<<<<<' not in s and '>>>>>>>' not in s
sys.stdout.write(s)
