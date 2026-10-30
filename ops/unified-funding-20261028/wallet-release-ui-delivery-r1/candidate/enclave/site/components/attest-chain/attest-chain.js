/* ============================================================
   <c-attest-chain> - the verification walkthrough:
   the chain-of-measurements links on the left, and the selected
   link's artifact (json / verifier code) on the right.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { hlJson, hlCode, copyText } from "../../js/core/util.js";

/* the artifact shown for each template link, in template order (the link
   titles/descriptions live in the TEMPLATE so the build can prerender them) */
const LINKS = [
  { fn: "policy.json",
    j: { example: true, sevSnp: { measurement: "1260788e…f879d384", minTcb: "2026.05" }, expectedMeasurementSource: "operator allowlist (limited unless independently pinned)" } },
  { fn: "vm.json",
    j: { technology: "amd-sev-snp", quote: "AwAAAAAAAAAA…", measurements: { measurement: "1260788e…f879d384" }, reportData: "beff22c9…e2978a4a",
         app: { kind: "ipfs", cid: "bafybeib…q2d4", verifiedAgainstCid: true, coverage: "bytes hash-verified in-enclave against this CID; the CID itself is not in a hardware register" } } },
  { fn: "shield-offload.example.json",
    j: { example: true, deploymentRecord: "2026-10-14", mode: "Shield masked offload", gpuInsideConfidentialBoundary: false, gpuHardwareAttestation: false, protection: "masked inputs; results checked by the trusted CPU component", review: "internal only; no external audit" } },
  { fn: "tls.json",
    j: { tlsKeyFingerprint: "sha256:4b8c…e2a1", boundTo: "reportData[0:32] = sha256(TLS pubkey SPKI)" } },
  { fn: "verify.js",
    code: "// the verifier this page ships (same-origin, hash-pinned): verifier/web in the EnclaveHost/enclave repo\n// pin a measurement you derived independently (confidential-server check): enclave attest --expect <measurement>\nimport { verifyMetalBoxWeb } from '/vendor/enclave-verifier.js';\n\nconst r = await verifyMetalBoxWeb({ name: 'metal0' });   // a fresh nonce is drawn here and sent to the box\nconsole.log(r.status, r.measurement, r.omissions);       // without an independent pin, a successful check is limited\n" },
];

class AttestChain extends EnclaveElement {
  static _tpl = "<div class=\"attest-wrap\">\n  <ol class=\"chain\" aria-label=\"Chain of measurements\">\n    <li class=\"link active\"><h3 class=\"lk-h\"><button class=\"lk-btn\" type=\"button\" aria-pressed=\"true\" aria-controls=\"attest-artifact\"><span class=\"lk-n\" aria-hidden=\"true\">01</span><span class=\"lk-t\">Hardware root of trust</span></button></h3><p class=\"lk-d\">On the documented confidential server, the CPU’s AMD SEV-SNP attestation chains to AMD’s hardware root. GPU work uses Shield’s masked offload outside that confidential boundary; no deployed GPU is attesting in NVIDIA confidential mode.</p></li>\n    <li class=\"link\"><h3 class=\"lk-h\"><button class=\"lk-btn\" type=\"button\" aria-pressed=\"false\" aria-controls=\"attest-artifact\"><span class=\"lk-n\" aria-hidden=\"true\">02</span><span class=\"lk-t\">The VM measures itself</span></button></h3><p class=\"lk-d\">On boot the AMD secure processor signs a report over the launch measurement, a SHA-384 digest of the firmware, the kernel, and the exact runtime image. Change one byte and it changes. Your app is deliberately <i>not</i> in it: the app arrives later by CID, and the runtime refuses any bytes that don't match the CID in your deployment record. (On Intel TDX: a DCAP quote over MRTD + RTMRs.)</p></li>\n    <li class=\"link\"><h3 class=\"lk-h\"><button class=\"lk-btn\" type=\"button\" aria-pressed=\"false\" aria-controls=\"attest-artifact\"><span class=\"lk-n\" aria-hidden=\"true\">03</span><span class=\"lk-t\">The GPU uses masked offload</span></button></h3><p class=\"lk-d\">The deployed GPUs receive masked inputs through Shield, and the trusted CPU component checks returned results. This is not GPU hardware attestation. Its security depends on the trusted CPU component and Shield’s documented assumptions; review has been internal only. The NVIDIA confidential-GPU fleet was retired on 2026-10-14.</p></li>\n    <li class=\"link\"><h3 class=\"lk-h\"><button class=\"lk-btn\" type=\"button\" aria-pressed=\"false\" aria-controls=\"attest-artifact\"><span class=\"lk-n\" aria-hidden=\"true\">04</span><span class=\"lk-t\">TLS is born inside</span></button></h3><p class=\"lk-d\">The enclave generates its TLS keypair in sealed memory and folds the public-key hash into the quote's report_data. The private key never leaves the boundary, so the operator can't sit in the middle.</p></li>\n    <li class=\"link\"><h3 class=\"lk-h\"><button class=\"lk-btn\" type=\"button\" aria-pressed=\"false\" aria-controls=\"attest-artifact\"><span class=\"lk-n\" aria-hidden=\"true\">05</span><span class=\"lk-t\">Your browser verifies</span></button></h3><p class=\"lk-d\">Enclave's source-available verifier (<code>verifier/</code> in the repo, served from this site) checks it in your browser: it sends the box a fresh nonce, then verifies the signed report up to AMD's root, the firmware floor, the guest policy, the key binding to your nonce and the launch measurement. The API’s selfCheck is only a diagnostic. By default, the expected measurement comes from Enclave’s allowlist, so a successful check is <b>limited</b>. For the confidential-server check, use <code>enclave attest --expect &lt;measurement&gt;</code> with a measurement you derived independently. Pinning does not remove other trust assumptions.</p></li>\n  </ol>\n  <div class=\"attest-side\">\n    <div class=\"as-h\"><span>Illustrative policy and evidence</span></div>\n    <div class=\"code\" id=\"attest-artifact\" style=\"border:0;border-radius:0;\"><div class=\"codebar\"><span class=\"fn attest-fn\" aria-live=\"polite\"></span><button class=\"copybtn\" type=\"button\">⧉ copy</button></div><pre><code class=\"attest-out\"></code></pre></div>\n  </div>\n</div>\n";

  show(i) {
    const l = LINKS[i];
    this.querySelector(".attest-fn").textContent = l.fn;
    const out = this.querySelector(".attest-out");
    if (l.code) { out.innerHTML = hlCode(l.code); this._raw = l.code; }
    else { out.innerHTML = hlJson(l.j); this._raw = JSON.stringify(l.j, null, 2); }
  }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const wrap = this.querySelector(".chain");
    const links = [...wrap.querySelectorAll(".link")];
    links.forEach((el, i) => {
      // one handler serves both: whole-card pointer clicks and the real
      // <button> inside the heading (keyboard) — button clicks bubble here
      el.addEventListener("click", () => {
        links.forEach((x, j) => {
          x.classList.toggle("active", j === i);
          const b = x.querySelector(".lk-btn");
          if (b) b.setAttribute("aria-pressed", String(j === i));
        });
        this.show(i);
      });
    });
    this.show(0);
    const cp = this.querySelector(".copybtn");
    cp.addEventListener("click", () => copyText(this._raw, cp));
  }
}
register("c-attest-chain", AttestChain);
