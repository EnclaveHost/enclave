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
  static templateUrl = new URL("./attest-chain.html", import.meta.url);

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
