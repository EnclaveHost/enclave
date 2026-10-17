// What each kind of host protects, in one place, for the deploy modal and the dashboard rows. Keyed by the relay's verdict on
// how the host attached (its `mode` on /enclaves), never by the host's own word. The wording follows the README's threat
// model and the develop page's evidence note: say what the host keeps out AND whom you still trust, on every tier.
export const PROTECTION = Object.freeze({
  snp: Object.freeze({ label: "Confidential server (AMD SEV-SNP)", cls: "ok",
    line: "Your app gets its own SEV-SNP guest: the processor encrypts its memory and keeps the host and its operator out." }),
  "hv-node": Object.freeze({ label: "Enclave Shield (Windows)", cls: "info",
    line: "Your app gets its own VBS-isolated partition: Microsoft's hypervisor keeps Windows out of its memory (our own test of that has not run yet). The hypervisor, the machine's owner and anyone with physical access stay trusted, and its memory is not encrypted." }),
  avf: Object.freeze({ label: "Phone protected VM (CPU only)", cls: "warn",
    line: "Your app gets its own protected VM: pKVM keeps Android out of its memory. The hypervisor, Google's attestation chain and the phone's hardware stay trusted." }),
});
export const PROTECTION_DOC = "develop#progress";
export const protectionOf = (mode) => PROTECTION[mode] || null;
