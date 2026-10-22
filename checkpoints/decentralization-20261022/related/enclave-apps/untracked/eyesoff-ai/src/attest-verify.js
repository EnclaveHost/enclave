// attest-verify.js: the attestation dialog's own reading of the SELF-SERVED document - the one this deployment's
// measured guest front answers at /.well-known/enclave-attestation?nonce=<64 hex> on this very origin (attest.rs).
// No platform API is involved: the nonce is this page's, the report is the hardware's, the VCEK is AMD's (via KDS,
// relayed by GET /attestation/vcek only because KDS sends no CORS), and AMD's roots are pinned below.
//
// A pass is a DIAGNOSTIC reading, not an attestation verdict: browser JavaScript cannot learn the SPKI its own TLS
// connection negotiated, so the key bound into the report is the one the document NAMES, and this file is served by the
// origin it checks. Nothing here may become a trust pin: the measurement is shown, never stored or compared against a
// value the server supplied.
//
// What a pass establishes, each one recomputed here with WebCrypto:
//   document   the guest-domain format, answering THIS page's fresh nonce
//   report     an AMD SEV-SNP ATTESTATION_REPORT, VCEK-signed, ECDSA P-384, a version whose fields are judged (2..5)
//   binding    report_data[0:32] = ABI/1 sha256(key || nonce), or ABI/2 sha256("enclave-bind-v2\n" || key || nonce ||
//              runtime id), over the transport key the document names
//   app        report_data[32:64] names the app the document names
//   runtime    (ABI/2) an admissible runtime identity: W^X enforced, no unauthenticated cache
//   policy     guest policy forbids debug and migration agents
//   vmpl       the report was produced at VMPL 0
//   chain      VCEK -> ASK -> ARK, the ARK pinned by sha256 for its product line, every signature RSASSA-PSS with AMD's
//              stated parameters (SHA-384, MGF1-SHA-384, salt 48), every certificate valid now
//   vcek       the VCEK's AMD extensions name this report's chip and REPORTED_TCB
//   signature  the PSP's signature over report bytes 0..0x2a0 verifies under that VCEK
//   host data  HOST_DATA (set by the host at launch, signed by the PSP) begins with the deployment label this page's
//              own hostname spells, when it spells one
//
// What it does NOT establish, and the verdict always lists: AMD's revocation list was not consulted; no firmware floor
// was applied; the launch MEASUREMENT is shown, not compared (an expectation must come from a reproduction or a party
// you choose, never from the server being judged); and a page cannot read its own TLS handshake, so the transport key is
// the document's, not one this browser saw. Above all: this page was served by the origin it is checking. A verifier
// you run yourself (the enclave repo's verifier/live-domain-check.mjs against this origin, with your own expected
// measurement) is the step that does not take this deployment's word for anything.
(function (root) {
  "use strict";

  const AMD_CHAINS = {
    // AMD KDS GET /vcek/v1/<product>/cert_chain (ASK, then ARK): public, and pinned by ARK_SHA256 below
    Milan: "-----BEGIN CERTIFICATE-----\n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\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIGYzCCBBKgAwIBAgIDAQAAMEYGCSqGSIb3DQEBCjA5oA8wDQYJYIZIAWUDBAIC\nBQChHDAaBgkqhkiG9w0BAQgwDQYJYIZIAWUDBAICBQCiAwIBMKMDAgEBMHsxFDAS\nBgNVBAsMC0VuZ2luZWVyaW5nMQswCQYDVQQGEwJVUzEUMBIGA1UEBwwLU2FudGEg\nQ2xhcmExCzAJBgNVBAgMAkNBMR8wHQYDVQQKDBZBZHZhbmNlZCBNaWNybyBEZXZp\nY2VzMRIwEAYDVQQDDAlBUkstTWlsYW4wHhcNMjAxMDIyMTcyMzA1WhcNNDUxMDIy\nMTcyMzA1WjB7MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMxFDAS\nBgNVBAcMC1NhbnRhIENsYXJhMQswCQYDVQQIDAJDQTEfMB0GA1UECgwWQWR2YW5j\nZWQgTWljcm8gRGV2aWNlczESMBAGA1UEAwwJQVJLLU1pbGFuMIICIjANBgkqhkiG\n9w0BAQEFAAOCAg8AMIICCgKCAgEA0Ld52RJOdeiJlqK2JdsVmD7FktuotWwX1fNg\nW41XY9Xz1HEhSUmhLz9Cu9DHRlvgJSNxbeYYsnJfvyjx1MfU0V5tkKiU1EesNFta\n1kTA0szNisdYc9isqk7mXT5+KfGRbfc4V/9zRIcE8jlHN61S1ju8X93+6dxDUrG2\nSzxqJ4BhqyYmUDruPXJSX4vUc01P7j98MpqOS95rORdGHeI52Naz5m2B+O+vjsC0\n60d37jY9LFeuOP4Meri8qgfi2S5kKqg/aF6aPtuAZQVR7u3KFYXP59XmJgtcog05\ngmI0T/OitLhuzVvpZcLph0odh/1IPXqx3+MnjD97A7fXpqGd/y8KxX7jksTEzAOg\nbKAeam3lm+3yKIcTYMlsRMXPcjNbIvmsBykD//xSniusuHBkgnlENEWx1UcbQQrs\n+gVDkuVPhsnzIRNgYvM48Y+7LGiJYnrmE8xcrexekBxrva2V9TJQqnN3Q53kt5vi\nQi3+gCfmkwC0F0tirIZbLkXPrPwzZ0M9eNxhIySb2npJfgnqz55I0u33wh4r0ZNQ\neTGfw03MBUtyuzGesGkcw+loqMaq1qR4tjGbPYxCvpCq7+OgpCCoMNit2uLo9M18\nfHz10lOMT8nWAUvRZFzteXCm+7PHdYPlmQwUw3LvenJ/ILXoQPHfbkH0CyPfhl1j\nWhJFZasCAwEAAaN+MHwwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBSFrBrRQ/fI\nrFXUxR1BSKvVeErUUzAPBgNVHRMBAf8EBTADAQH/MDoGA1UdHwQzMDEwL6AtoCuG\nKWh0dHBzOi8va2RzaW50Zi5hbWQuY29tL3ZjZWsvdjEvTWlsYW4vY3JsMEYGCSqG\nSIb3DQEBCjA5oA8wDQYJYIZIAWUDBAICBQChHDAaBgkqhkiG9w0BAQgwDQYJYIZI\nAWUDBAICBQCiAwIBMKMDAgEBA4ICAQC6m0kDp6zv4Ojfgy+zleehsx6ol0ocgVel\nETobpx+EuCsqVFRPK1jZ1sp/lyd9+0fQ0r66n7kagRk4Ca39g66WGTJMeJdqYriw\nSTjjDCKVPSesWXYPVAyDhmP5n2v+BYipZWhpvqpaiO+EGK5IBP+578QeW/sSokrK\ndHaLAxG2LhZxj9aF73fqC7OAJZ5aPonw4RE299FVarh1Tx2eT3wSgkDgutCTB1Yq\nzT5DuwvAe+co2CIVIzMDamYuSFjPN0BCgojl7V+bTou7dMsqIu/TW/rPCX9/EUcp\nKGKqPQ3P+N9r1hjEFY1plBg93t53OOo49GNI+V1zvXPLI6xIFVsh+mto2RtgEX/e\npmMKTNN6psW88qg7c1hTWtN6MbRuQ0vm+O+/2tKBF2h8THb94OvvHHoFDpbCELlq\nHnIYhxy0YKXGyaW1NjfULxrrmxVW4wcn5E8GddmvNa6yYm8scJagEi13mhGu4Jqh\n3QU3sf8iUSUr09xQDwHtOQUVIqx4maBZPBtSMf+qUDtjXSSq8lfWcd8bLr9mdsUn\nJZJ0+tuPMKmBnSH860llKk+VpVQsgqbzDIvOLvD6W1Umq25boxCYJ+TuBoa4s+HH\nCViAvgT9kf/rBq1d+ivj6skkHxuzcxbk1xv6ZGxrteJxVH7KlX7YRdZ6eARKwLe4\nAFZEAwoKCQ==\n-----END CERTIFICATE-----\n",
    Genoa: "-----BEGIN CERTIFICATE-----\n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\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n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\n/wMz1R1BHg==\n-----END CERTIFICATE-----\n",
    Turin: "-----BEGIN CERTIFICATE-----\n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\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n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\nzpacMwFusA==\n-----END CERTIFICATE-----\n",
  };
  // sha256 of each ARK's DER (relay/snp-verify.mjs AMD_ARK_SHA256, cross-checked against go-sev-guest)
  const ARK_SHA256 = {
    Milan: "69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd",
    Genoa: "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1",
    Turin: "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a",
  };
  const VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
  const AMD = "1.3.6.1.4.1.3704.1";
  const SPL_OID = { bootloader: AMD + ".3.1", tee: AMD + ".3.2", snp: AMD + ".3.3", microcode: AMD + ".3.8", fmc: AMD + ".3.9" };
  const TCB_FIELDS = { Milan: ["bootloader", "tee", "snp", "microcode"], Genoa: ["bootloader", "tee", "snp", "microcode"],
                       Turin: ["fmc", "bootloader", "tee", "snp", "microcode"] };
  const OID = { rsaEncryption: "1.2.840.113549.1.1.1", rsassaPss: "1.2.840.113549.1.1.10", mgf1: "1.2.840.113549.1.1.8",
                sha384: "2.16.840.1.101.3.4.2.2", ecPublicKey: "1.2.840.10045.2.1", secp384r1: "1.3.132.0.34", cn: "2.5.4.3" };
  const REPORT_SIZE = 0x4a0, SIG_OFFSET = 0x2a0;
  const P384_N = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");
  const ABI1 = "enclave-domain-abi/1", ABI2 = "enclave-domain-abi/2";
  const RUNTIME_FIELDS = ["name", "version", "execution", "targetIsa", "hostIsa", "cpuFeatures", "wx", "cache"];

  const CHECKS = [
    ["document", "the guest-domain document answers this page's fresh nonce"],
    ["report", "an AMD SEV-SNP report, VCEK-signed, ECDSA P-384"],
    ["binding", "report data binds the document's transport key and this page's nonce"],
    ["app", "report data names the app the document names"],
    ["runtime", "the in-guest runtime identity is admissible (W^X enforced)"],
    ["policy", "guest policy forbids debug and migration agents"],
    ["vmpl", "produced at VMPL 0"],
    ["chain", "VCEK chains to AMD's pinned root"],
    ["vcek", "the VCEK names this chip and its reported TCB"],
    ["signature", "AMD's processor signed this report"],
    ["host data", "HOST_DATA names the deployment this hostname spells"],
  ];
  const OMISSIONS = {
    crl: "AMD's revocation list was not consulted.",
    "tcb-floor": "No minimum firmware level was applied.",
    measurement: "The launch measurement is shown, not compared: compare it with a reproduction you trust.",
    "handshake-key": "A page cannot read its own TLS handshake; the transport key is the document's.",
    "self-served-page": "This page came from the origin it checks: its result is a diagnostic reading, not a verification. Run your own verifier to remove that.",
  };

  const subtle = () => {
    const s = root.crypto && root.crypto.subtle;
    if (!s) throw new Error("WebCrypto is not available (a secure context is required)");
    return s;
  };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const unhex = (s) => {
    if (typeof s !== "string" || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("not hex");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
    return out;
  };
  const b64 = (s) => {
    const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const utf8 = (s) => new TextEncoder().encode(s);
  const sha = async (alg, bytes) => new Uint8Array(await subtle().digest(alg, bytes));

  // ---- DER: strict definite lengths, bounded -------------------------------------------------------------------
  function tlv(b, o) {
    if (o + 2 > b.length) throw new Error("DER truncated");
    const tag = b[o];
    let len = b[o + 1], p = o + 2;
    if (len === 0x80) throw new Error("DER indefinite length");
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 3 || p + n > b.length) throw new Error("DER length form");
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[p++];
      if (len < 0x80 || (n > 1 && len < 1 << (8 * (n - 1)))) throw new Error("DER non-minimal length");
    }
    if (p + len > b.length) throw new Error("DER overrun");
    return { tag, start: p, end: p + len, at: o };
  }
  function kids(b, n) {
    const out = [];
    for (let o = n.start; o < n.end;) { const k = tlv(b, o); out.push(k); o = k.end; }
    return out;
  }
  const val = (b, n) => b.subarray(n.start, n.end);
  const whole = (b, n) => b.subarray(n.at, n.end);
  function oidOf(b, n) {
    if (n.tag !== 0x06) throw new Error("not an OID");
    const v = val(b, n), parts = [Math.floor(v[0] / 40), v[0] % 40];
    for (let i = 1, x = 0; i < v.length; i++) { x = x * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(x); x = 0; } }
    return parts.join(".");
  }
  function derTime(b, n) {
    const s = String.fromCharCode(...val(b, n));
    const m = n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
            : n.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : null;
    if (!m) throw new Error("certificate time form");
    let y = +m[1];
    if (n.tag === 0x17) y += y >= 50 ? 1900 : 2000;
    return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  function uintOf(v) {
    const t = tlv(v, 0);
    if (t.tag !== 0x02 || t.end !== v.length || t.end === t.start || (v[t.start] & 0x80)) return null;
    let x = 0;
    for (let i = t.start; i < t.end; i++) x = x * 256 + v[i];
    return x;
  }

  // the pieces of one X.509 certificate this verifier compares or signs over
  function parseCert(der) {
    if (!(der instanceof Uint8Array) || der.length < 64 || der.length > 16384) throw new Error("not a bounded DER certificate");
    const top = tlv(der, 0);
    if (top.tag !== 0x30 || top.end !== der.length) throw new Error("certificate is not exactly one SEQUENCE");
    const [tbs, sigAlg, sigVal] = kids(der, top);
    if (!sigVal || tbs.tag !== 0x30 || sigAlg.tag !== 0x30 || sigVal.tag !== 0x03) throw new Error("certificate shape");
    const k = kids(der, tbs);
    let i = k[0] && k[0].tag === 0xa0 ? 1 : 0;
    const [serial, , issuer, validity, subject, spki] = k.slice(i, i + 6);
    if (!spki || serial.tag !== 0x02 || spki.tag !== 0x30) throw new Error("TBSCertificate shape");
    const [nb, na] = kids(der, validity);
    const ext = new Map();
    const extNode = k.slice(i + 6).find((n) => n.tag === 0xa3);
    if (extNode) {
      for (const e of kids(der, kids(der, extNode)[0])) {
        const ek = kids(der, e), id = oidOf(der, ek[0]), v = ek[ek.length - 1];
        if (v.tag !== 0x04) throw new Error("extension shape");
        ext.set(id, val(der, v));
      }
    }
    const sigAlgKids = kids(der, sigAlg);
    const sig = val(der, sigVal);
    if (!sig.length || sig[0] !== 0) throw new Error("signature BIT STRING with unused bits");
    const [spkiAlg] = kids(der, spki);
    const spkiAlgKids = kids(der, spkiAlg);
    let cn = null;
    for (const rdn of kids(der, subject)) for (const atv of kids(der, rdn)) {
      const [t, v] = kids(der, atv);
      if (oidOf(der, t) === OID.cn) cn = String.fromCharCode(...val(der, v));
    }
    return {
      der, tbs: whole(der, tbs), sigAlg: oidOf(der, sigAlgKids[0]), sigParams: sigAlgKids[1] ? { der, node: sigAlgKids[1] } : null,
      signature: sig.subarray(1), issuer: whole(der, issuer), subject: whole(der, subject), cn,
      notBefore: derTime(der, nb), notAfter: derTime(der, na), spki: whole(der, spki),
      keyAlg: oidOf(der, spkiAlgKids[0]), curve: spkiAlgKids[1] && spkiAlgKids[1].tag === 0x06 ? oidOf(der, spkiAlgKids[1]) : null, ext,
    };
  }
  const pemCerts = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE"))
    .map((s) => b64(s.replace(/-----[^-]+-----/g, "")));

  // RSASSA-PSS with exactly AMD's stated parameters (AMD 57230): SHA-384, MGF1 with SHA-384, salt 48
  function amdPssParams(c) {
    if (c.sigAlg !== OID.rsassaPss || !c.sigParams) return false;
    const { der, node } = c.sigParams;
    const ps = kids(der, node);
    const byTag = Object.fromEntries(ps.map((p) => [p.tag, p]));
    try {
      const h = kids(der, kids(der, byTag[0xa0])[0])[0];
      const mgf = kids(der, kids(der, byTag[0xa1])[0]);
      const mgfHash = kids(der, mgf[1])[0];
      const salt = uintOf(whole(der, kids(der, byTag[0xa2])[0]));
      return oidOf(der, h) === OID.sha384 && oidOf(der, mgf[0]) === OID.mgf1 && oidOf(der, mgfHash) === OID.sha384 && salt === 48;
    } catch (_) { return false; }
  }
  async function signedBy(child, issuer) {
    if (!amdPssParams(child)) return false;
    if (issuer.keyAlg !== OID.rsaEncryption || !eq(child.issuer, issuer.subject)) return false;
    const key = await subtle().importKey("spki", issuer.spki, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]);
    return subtle().verify({ name: "RSA-PSS", saltLength: 48 }, key, child.signature, child.tbs);
  }
  const inWindow = (c, now) => now >= c.notBefore && now <= c.notAfter;

  // VCEK -> ASK -> ARK for one product line; null when it holds, else why not
  async function checkChain(vcekDer, product, now) {
    const pem = AMD_CHAINS[product];
    if (!pem) return "no pinned AMD chain for " + product;
    const [askDer, arkDer] = pemCerts(pem);
    if (hex(await sha("SHA-256", arkDer)) !== ARK_SHA256[product]) return "the bundled ARK is not AMD's pinned " + product + " root";
    let vcek, ask, ark;
    try { vcek = parseCert(vcekDer); ask = parseCert(askDer); ark = parseCert(arkDer); } catch (e) { return "certificate unreadable: " + e.message; }
    if (ark.cn !== "ARK-" + product || ask.cn !== "SEV-" + product || vcek.cn !== "SEV-VCEK") return "certificate subjects are not AMD's " + product + " chain";
    for (const [c, what] of [[ark, "ARK"], [ask, "ASK"], [vcek, "VCEK"]]) if (!inWindow(c, now)) return what + " certificate is not valid now";
    if (!(await signedBy(ark, ark))) return "ARK is not self-signed";
    if (!(await signedBy(ask, ark))) return "ASK is not signed by the ARK";
    if (!(await signedBy(vcek, ask))) return "VCEK is not signed by the " + product + " ASK";
    if (vcek.keyAlg !== OID.ecPublicKey || vcek.curve !== OID.secp384r1) return "VCEK key is not EC P-384";
    return null;
  }

  // ---- the report ------------------------------------------------------------------------------------------------
  function parseReport(r) {
    if (!(r instanceof Uint8Array) || r.length !== REPORT_SIZE) throw new Error("report is not " + REPORT_SIZE + " bytes");
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const u32 = (o) => v.getUint32(o, true), u64 = (o) => v.getBigUint64(o, true);
    const p = {
      bytes: r, version: u32(0), guestSvn: u32(4), policy: u64(8), vmpl: u32(0x30), signatureAlgo: u32(0x34),
      signerInfo: u32(0x48), reportData: r.subarray(0x50, 0x90), measurement: r.subarray(0x90, 0xc0),
      hostData: r.subarray(0xc0, 0xe0), reportedTcb: r.subarray(0x180, 0x188), cpuidFam: r[0x188], cpuidMod: r[0x189],
      chipId: r.subarray(0x1a0, 0x1e0), signature: r.subarray(SIG_OFFSET, SIG_OFFSET + 0x90), signed: r.subarray(0, SIG_OFFSET),
    };
    if (p.version < 2 || p.version > 5) throw new Error("report version " + p.version + " is not one this page judges (2..5)");
    if (p.signatureAlgo !== 1) throw new Error("signature algorithm is not ECDSA P-384 with SHA-384");
    if (!(p.policy & (1n << 17n)) || p.policy >> 26n) throw new Error("guest policy reserved bits are wrong");
    if (((p.signerInfo >>> 2) & 7) !== 0) throw new Error("report is not VCEK-signed");
    p.debug = !!(p.policy & (1n << 19n));
    p.migrateMa = !!(p.policy & (1n << 18n));
    if (p.version >= 3) {
      const f = p.cpuidFam, m = p.cpuidMod;
      p.product = f === 0x19 && m < 0x10 ? "Milan"
        : f === 0x19 && ((m >= 0x10 && m < 0x20) || (m >= 0xa0 && m < 0xb0)) ? "Genoa"
        : f === 0x1a && m < 0x20 ? "Turin" : null;
    } else p.product = null;
    return p;
  }
  function decodeTcb(product, b) {
    if (product === "Turin") return { fmc: b[0], bootloader: b[1], tee: b[2], snp: b[3], microcode: b[7] };
    return { bootloader: b[0], tee: b[1], snp: b[6], microcode: b[7] };
  }
  // the query GET /attestation/vcek takes: what KDS needs to name this chip's VCEK at this TCB
  function vcekQuery(product, p) {
    const t = decodeTcb(product, p.reportedTcb);
    const hw = product === "Turin" ? p.chipId.subarray(0, 8) : p.chipId;
    return "product=" + product + "&hwid=" + hex(hw) + (product === "Turin" ? "&fmc=" + t.fmc : "") +
      "&bl=" + t.bootloader + "&tee=" + t.tee + "&snp=" + t.snp + "&ucode=" + t.microcode;
  }
  function vcekMatches(vcekDer, product, p) {
    const ext = parseCert(vcekDer).ext, want = decodeTcb(product, p.reportedTcb);
    for (const f of TCB_FIELDS[product]) {
      const raw = ext.get(SPL_OID[f]);
      if (!raw) return "VCEK has no " + f + " SPL";
      if (uintOf(raw) !== want[f]) return "VCEK " + f + " SPL does not match the reported TCB";
    }
    const hwLen = product === "Turin" ? 8 : 64;
    let hw = ext.get(AMD + ".4");
    if (!hw) return "VCEK has no hardware id";
    if (hw.length !== hwLen && hw[0] === 0x04) { const t = tlv(hw, 0); hw = hw.subarray(t.start, t.end); }
    if (!eq(hw, p.chipId.subarray(0, hwLen))) return "VCEK hardware id is not this report's chip";
    return null;
  }
  async function reportSigned(vcekDer, p) {
    const rBE = p.signature.slice(0, 48).reverse(), sBE = p.signature.slice(0x48, 0x48 + 48).reverse();
    const R = BigInt("0x" + hex(rBE)), S = BigInt("0x" + hex(sBE));
    if (R === 0n || R >= P384_N || S === 0n || S >= P384_N) return false;
    const key = await subtle().importKey("spki", parseCert(vcekDer).spki, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
    return subtle().verify({ name: "ECDSA", hash: "SHA-384" }, key, concat(rBE, sBE), p.signed);
  }
  function vcekFromAuxblob(aux) {
    if (!(aux instanceof Uint8Array) || aux.length > 65536) return null;
    const dv = new DataView(aux.buffer, aux.byteOffset, aux.byteLength);
    for (let o = 0; o + 24 <= aux.length; o += 24) {
      const guid = hex(aux.subarray(o, o + 16));
      if (/^0+$/.test(guid)) break;
      const off = dv.getUint32(o + 16, true), len = dv.getUint32(o + 20, true);
      if (guid === VCEK_GUID) return len > 0 && off + len <= aux.length ? aux.subarray(off, off + len) : null;
    }
    return null;
  }

  // ---- the ABI/2 runtime identity (isolation/contract/runtime.mjs, byte for byte) --------------------------------
  function runtimeProblem(r) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return "the runtime identity is not an object";
    for (const k of Object.keys(r)) if (!RUNTIME_FIELDS.includes(k)) return "unknown runtime field " + k;
    for (const k of RUNTIME_FIELDS) if (typeof r[k] !== "string") return "runtime field " + k + " missing";
    if (!r.name || !r.version) return "runtime name and version are required";
    if (r.hostIsa !== "x86_64" && r.hostIsa !== "aarch64") return "host ISA is not x86_64 or aarch64";
    if (r.execution === "jit" ? r.targetIsa !== r.hostIsa : r.execution === "interpreter" ? r.targetIsa !== "pulley64" : true)
      return "execution mode and target ISA disagree";
    if (!r.cpuFeatures) return "CPU-feature policy not stated";
    if (r.wx !== "enforced") return "W^X is not enforced";
    if (r.cache !== "none" && r.cache !== "authenticated") return "compiled-code cache is not none or authenticated";
    return null;
  }
  async function runtimeId(r) {
    const why = runtimeProblem(r);
    if (why) throw new Error(why);
    const sorted = {};
    for (const k of [...RUNTIME_FIELDS].sort()) sorted[k] = r[k];
    return sha("SHA-256", utf8(JSON.stringify(sorted)));
  }

  // ---- the verdict ------------------------------------------------------------------------------------------------
  // opts: { nonce: Uint8Array(32) - this page's, fresh; fetchVcek: async (query) => Uint8Array | null;
  //         label: hex deployment label this page's hostname spells, or null; now: Date }
  async function verifyDomainDoc(doc, opts) {
    const o = opts || {}, now = o.now || new Date();
    const checks = Object.fromEntries(CHECKS.map(([k]) => [k, null]));
    const reasons = [], omissions = ["crl", "tcb-floor", "measurement", "handshake-key", "self-served-page"];
    const facts = {};
    const out = (status) => ({ status, checks, labels: Object.fromEntries(CHECKS), order: CHECKS.map(([k]) => k), reasons,
                               omissions, omissionLabels: Object.fromEntries(omissions.map((x) => [x, OMISSIONS[x]])), facts });
    const fail = (k, why) => { checks[k] = false; reasons.push(why); return out("rejected"); };
    const pass = (k, why) => { checks[k] = true; if (why) reasons.push(why); };

    if (!doc || typeof doc !== "object" || doc.format !== "sev-snp-guest-domain-v1" || typeof doc.report !== "string")
      return fail("document", "not an SEV-SNP guest-domain document");
    if (!(o.nonce instanceof Uint8Array) || o.nonce.length !== 32) return fail("document", "no fresh 32-byte nonce to check against");
    if (String(doc.nonce || "").toLowerCase() !== hex(o.nonce)) return fail("document", "the document does not answer this page's nonce");
    pass("document", "answers this page's nonce " + hex(o.nonce).slice(0, 16) + "…");

    let p;
    try { p = parseReport(b64(doc.report)); } catch (e) { return fail("report", e.message); }
    pass("report", "report version " + p.version + (p.product ? ", " + p.product : ""));
    facts.measurement = hex(p.measurement);
    facts.hostData = hex(p.hostData);
    facts.chipId = hex(p.chipId);
    facts.vmpl = p.vmpl;
    facts.product = p.product;
    facts.policy = "0x" + p.policy.toString(16);
    facts.appId = hex(p.reportData.subarray(32));

    let spki;
    try { spki = b64(doc.transportKey || ""); } catch (_) { spki = new Uint8Array(0); }
    if (spki.length < 32) return fail("binding", "the document names no transport key");
    facts.transportKeySha256 = hex(await sha("SHA-256", spki));
    let bind;
    if (doc.abi === ABI2) {
      let rid;
      try { rid = await runtimeId(doc.runtime); } catch (e) { return fail("runtime", "inadmissible runtime identity: " + e.message); }
      facts.runtime = doc.runtime;
      facts.runtimeId = hex(rid);
      pass("runtime", doc.runtime.name + " " + doc.runtime.version + ", " + doc.runtime.execution + ", W^X " + doc.runtime.wx);
      bind = await sha("SHA-256", concat(utf8("enclave-bind-v2\n"), spki, o.nonce, rid));
    } else if (doc.abi === undefined || doc.abi === ABI1) {
      bind = await sha("SHA-256", concat(spki, o.nonce));
    } else return fail("binding", "unknown binding ABI " + doc.abi);
    if (!eq(bind, p.reportData.subarray(0, 32))) return fail("binding", "report data does not bind this key and nonce");
    pass("binding", (doc.abi || ABI1) + " binding recomputed");
    if (String(doc.appSha256 || "").toLowerCase() !== facts.appId) return fail("app", "report data names a different app than the document");
    pass("app");
    if (p.debug || p.migrateMa) return fail("policy", p.debug ? "guest policy ALLOWS debug" : "guest policy allows a migration agent");
    pass("policy");
    if (p.vmpl !== 0) return fail("vmpl", "report produced at VMPL " + p.vmpl);
    pass("vmpl");

    if (o.label) {
      if (!facts.hostData.startsWith(String(o.label).toLowerCase())) return fail("host data", "HOST_DATA does not name deployment " + o.label);
      pass("host data", "HOST_DATA is deployment 0x" + facts.hostData);
    }

    // the hardware half: VCEK from the report's own table, else from KDS through this deployment
    const products = p.product ? [p.product] : ["Milan", "Genoa"];
    let vcekDer = null, product = null, chainWhy = "no VCEK was available", source = null;
    for (const cand of products) {
      let der = null;
      try {
        der = doc.certs ? vcekFromAuxblob(b64(doc.certs)) : null;
        source = der ? "the report's certificate table" : null;
        if (!der && o.fetchVcek) { der = await o.fetchVcek(vcekQuery(cand, p)); source = der ? "AMD KDS, relayed by this deployment" : null; }
      } catch (e) { chainWhy = "VCEK unavailable: " + (e.message || e); der = null; }
      if (!der) continue;
      const why = await checkChain(der, cand, now);
      if (!why) { vcekDer = der; product = cand; break; }
      chainWhy = why;
      if (p.product) return fail("chain", why);
    }
    if (!vcekDer) {
      reasons.push(chainWhy + " - the report's signature is NOT checked; nothing above is hardware-authenticated");
      return out("unsigned");
    }
    facts.product = product;
    facts.vcekSource = source;
    pass("chain", "VCEK -> SEV-" + product + " -> ARK-" + product + " (pinned)");
    let why;
    try { why = vcekMatches(vcekDer, product, p); } catch (e) { why = "VCEK extensions unreadable: " + e.message; }
    if (why) return fail("vcek", why);
    pass("vcek");
    if (!(await reportSigned(vcekDer, p))) return fail("signature", "the VCEK signature over the report does not verify");
    pass("signature");
    return out("limited");
  }

  // The whole retrieval, as the dialog runs it: a fresh nonce, ONE request for the self-served document on this origin
  // (the front answers it ahead of the app; no redirect, no cookies, bounded), the VCEK from this deployment's KDS relay,
  // then the verdict. Resolves null when the origin serves no such document (no measured front: a local run, another
  // runtime), so the caller can fall back and say so; throws only on a transport failure worth reporting.
  async function selfServed(opts) {
    const o = opts || {}, f = o.fetchImpl || root.fetch.bind(root);
    const nonce = o.nonce || root.crypto.getRandomValues(new Uint8Array(32));
    const get = async (url, accept) => {
      const r = await f(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { accept } });
      const body = new Uint8Array(await r.arrayBuffer());
      if (body.length > 256 * 1024) throw new Error(url + " answered more than 256 KiB");
      return { ok: r.ok, status: r.status, body };
    };
    const r = await get(new URL(".well-known/enclave-attestation?nonce=" + hex(nonce), o.origin).href, "application/json");
    if (!r.ok) return null;
    let doc;
    try { doc = JSON.parse(new TextDecoder().decode(r.body)); } catch (_) { return null; }
    if (!doc || doc.format !== "sev-snp-guest-domain-v1") return null;
    const fetchVcek = o.vcekUrl ? async (query) => {
      const v = await get(o.vcekUrl + "?" + query, "application/pkix-cert");
      return v.ok && v.body.length ? v.body : null;
    } : null;
    const verdict = await verifyDomainDoc(doc, { nonce, fetchVcek, label: o.label || null, now: o.now });
    return { doc, verdict, nonce: hex(nonce) };
  }

  root.EnclaveAttest = { verifyDomainDoc, selfServed, parseReport, runtimeId, vcekQuery, ARK_SHA256, CHECKS, OMISSIONS };
})(typeof globalThis !== "undefined" ? globalThis : this);
