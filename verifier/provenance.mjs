// verifier/provenance.mjs: release provenance, verified against a policy WE state.
//
// A release is trusted because a Sigstore bundle proves that a specific GitHub Actions identity (this
// repository, this workflow file, a tag matching our pattern, GitHub's OIDC issuer) signed an in-toto
// statement whose subject is the release digest and whose predicate carries the measurements. The
// repository the server names is never an input here; only the policy's repository is. The Sigstore
// trusted root is supplied by the caller (test/fixtures/verifier/sigstore/trusted_root.json, reached
// through Sigstore's TUF metadata), never taken from the bundle.
//
// Library: @freedomofpress/sigstore-browser (the same one @tinfoilsh/verifier uses and the site already
// ships; LICENSE file Apache-2.0, package.json says MIT). It verifies the Fulcio chain, SCTs, the Rekor
// inclusion proof/promise, the DSSE signature and the tlog body. This file owns the identity policy, the
// statement shape, the predicate allowlist, the subject digest and the release-version floor.
import { SigstoreVerifier, AllOf, OIDCIssuer, GitHubWorkflowRepository, GITHUB_OIDC_ISSUER } from "@freedomofpress/sigstore-browser";

export const DEFAULT_RELEASE_POLICY = Object.freeze({
  repository: "EnclaveHost/enclave",
  workflowPath: ".github/workflows/tinfoil-release-publish.yml",
  refPattern: "^refs/tags/v(\\d+)\\.(\\d+)\\.(\\d+)(-cpu|-gpu8)?$",
  issuer: GITHUB_OIDC_ISSUER,
  predicateTypes: ["https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1"],
  minimumRelease: [0, 5, 0],             // [major, minor, patch]: an older GENUINE release is a rollback, refused
  allowedTriggers: ["workflow_dispatch"],
  requireVisibility: "public",
});
export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";

const ext = (cert, name, key) => { const e = cert[name]; return e ? e[key] : undefined; };
class Rule { constructor(name, fn) { this.name = name; this.fn = fn; } verify(cert) { const why = this.fn(cert); if (why) throw new Error(`${this.name}: ${why}`); } }

export function releasePolicyRules(pol) {
  const re = new RegExp(pol.refPattern);
  const refOf = (cert) => ext(cert, "extGitHubWorkflowRef", "workflowRef") ?? ext(cert, "extSourceRepositoryRef", "sourceRepositoryRef");
  return new AllOf([
    new OIDCIssuer(pol.issuer),
    new GitHubWorkflowRepository(pol.repository),
    new Rule("tag ref", (c) => { const ref = refOf(c); return !ref ? "missing workflow ref" : re.test(ref) ? null : `ref ${JSON.stringify(ref)} does not match ${pol.refPattern}`; }),
    new Rule("workflow path", (c) => { const ref = refOf(c); const want = `https://github.com/${pol.repository}/${pol.workflowPath}@${ref}`; const got = ext(c, "extBuildConfigURI", "buildConfigURI"); return got === want ? null : `build config ${JSON.stringify(got)} != ${want}`; }),
    new Rule("source repository", (c) => { const got = ext(c, "extSourceRepositoryURI", "sourceRepositoryURI"); return got === `https://github.com/${pol.repository}` ? null : `source repository ${JSON.stringify(got)}`; }),
    new Rule("trigger", (c) => { const got = ext(c, "extBuildTrigger", "buildTrigger") ?? ext(c, "extGitHubWorkflowTrigger", "workflowTrigger"); return !pol.allowedTriggers || pol.allowedTriggers.includes(got) ? null : `trigger ${JSON.stringify(got)} not allowed`; }),
    new Rule("visibility", (c) => { const got = ext(c, "extSourceRepositoryVisibility", "sourceRepositoryVisibility"); return !pol.requireVisibility || got === pol.requireVisibility ? null : `repository visibility ${JSON.stringify(got)}`; }),
  ]);
}

// verifyReleaseAttestation({ bundle, digestHex, trustedRoot, policy }) -> { ok, reasons, claims }
export async function verifyReleaseAttestation({ bundle, digestHex, trustedRoot, policy = DEFAULT_RELEASE_POLICY }) {
  const pol = { ...DEFAULT_RELEASE_POLICY, ...policy };
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, `REJECT: ${m}`], claims: null });
  if (!bundle || typeof bundle !== "object") return fail("bundle is not an object");
  if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") return fail(`bundle mediaType ${JSON.stringify(bundle.mediaType)} is not v0.3 (single-certificate form)`);
  if (bundle.verificationMaterial?.x509CertificateChain) return fail("bundle carries an x509CertificateChain (legacy form) and is refused");
  if (!bundle.verificationMaterial?.certificate?.rawBytes) return fail("bundle has no signing certificate");
  if (!bundle.dsseEnvelope || (bundle.dsseEnvelope.signatures || []).length !== 1) return fail("bundle must carry one DSSE envelope with exactly one signature");
  if (!Array.isArray(bundle.verificationMaterial.tlogEntries) || !bundle.verificationMaterial.tlogEntries.length) return fail("bundle carries no transparency-log entry");
  if (!/^[0-9a-f]{64}$/.test(String(digestHex))) return fail("digest must be 64 hex characters");
  if (!trustedRoot || !Array.isArray(trustedRoot.certificateAuthorities)) return fail("no Sigstore trusted root supplied (it must come from Sigstore's TUF repository, never from the bundle)");

  const verifier = new SigstoreVerifier({ tlogThreshold: 1, ctlogThreshold: 1, tsaThreshold: 0 });
  try { await verifier.loadSigstoreRoot(trustedRoot); } catch (e) { return fail(`trusted root unusable: ${e.message}`); }
  let payloadType, payloadBytes;
  try { ({ payloadType, payload: payloadBytes } = await verifier.verifyDsse(bundle, releasePolicyRules(pol))); }
  catch (e) { return fail(`Sigstore verification failed: ${e.message}`); }
  reasons.push(`Sigstore: Fulcio chain to the pinned root, SCT, Rekor inclusion, DSSE signature, and the identity policy (repo ${pol.repository}, workflow ${pol.workflowPath}, tag pattern, issuer ${pol.issuer}) all hold`);
  if (payloadType !== "application/vnd.in-toto+json") return fail(`payload type ${payloadType} is not an in-toto statement`);
  let st; try { st = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return fail("statement is not JSON"); }
  const extra = Object.keys(st).filter((k) => !["_type", "subject", "predicateType", "predicate"].includes(k));
  if (extra.length) return fail(`statement carries unknown top-level fields ${extra.join(", ")}`);
  if (st._type !== IN_TOTO_STATEMENT_V1) return fail(`statement _type ${JSON.stringify(st._type)} is not ${IN_TOTO_STATEMENT_V1}`);
  if (!Array.isArray(st.subject) || st.subject.length !== 1 || !st.subject[0]?.digest?.sha256) return fail("statement must have exactly one subject with a sha256 digest");
  if (st.subject[0].digest.sha256.toLowerCase() !== digestHex.toLowerCase()) return fail(`statement subject ${st.subject[0].digest.sha256.slice(0, 16)}... is not the release digest ${digestHex.slice(0, 16)}...`);
  if (!pol.predicateTypes.includes(st.predicateType)) return fail(`predicate type ${JSON.stringify(st.predicateType)} is not accepted (${pol.predicateTypes.join(", ")})`);
  const pr = st.predicate || {};
  if (!/^[0-9a-f]{96}$/.test(String(pr.snp_measurement || ""))) return fail("predicate has no 48-byte snp_measurement");
  reasons.push(`in-toto v1 statement: subject ${st.subject[0].name} sha256:${digestHex.slice(0, 16)}..., predicate ${st.predicateType}`);

  // identity claims from the signing certificate, for the caller's record (all already enforced by the policy)
  const certB64 = bundle.verificationMaterial.certificate.rawBytes;
  const { X509Certificate } = await import("@freedomofpress/sigstore-browser");
  const cert = X509Certificate.parse(Uint8Array.from(Buffer.from(certB64, "base64")));
  const ref = ext(cert, "extGitHubWorkflowRef", "workflowRef");
  const m = new RegExp(pol.refPattern).exec(ref);
  const ver = m ? [+m[1], +m[2], +m[3]] : null, flavor = m ? (m[4] ? m[4].slice(1) : "gpu") : null;
  if (!ver) return fail(`ref ${ref} did not yield a version`);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (cmp(ver, pol.minimumRelease) < 0) return fail(`release v${ver.join(".")} is below the minimum release v${pol.minimumRelease.join(".")} (a genuine but rolled-back release)`);
  reasons.push(`release v${ver.join(".")} (${flavor}) meets the minimum v${pol.minimumRelease.join(".")}`);
  const integratedTime = bundle.verificationMaterial.tlogEntries[0]?.integratedTime;
  return { ok: true, reasons, claims: {
    repository: pol.repository, ref, tag: ref.replace(/^refs\/tags\//, ""), version: ver, flavor, digest: digestHex.toLowerCase(),
    workflow: ext(cert, "extBuildConfigURI", "buildConfigURI"), sha: ext(cert, "extGitHubWorkflowSHA", "workflowSHA") ?? ext(cert, "extSourceRepositoryDigest", "sourceRepositoryDigest"),
    trigger: ext(cert, "extBuildTrigger", "buildTrigger"), runInvocation: ext(cert, "extRunInvocationURI", "runInvocationURI"),
    signedAt: cert.notBefore?.toISOString?.() ?? null, integratedTime: integratedTime ? new Date(Number(integratedTime) * 1000).toISOString() : null,
    snpMeasurement: pr.snp_measurement, tdxMeasurement: pr.tdx_measurement ?? null, cmdline: pr.cmdline ?? null, imageHashes: pr.hashes ?? null,
    configSha256: pr.config ? Buffer.from(require_sha256(Buffer.from(pr.config, "base64"))).toString("hex") : null,
  } };
}
import { createHash } from "node:crypto";
const require_sha256 = (b) => createHash("sha256").update(b).digest();
