#!/usr/bin/env python3
"""UNREVIEWED, NOT RUN. Hash-guarded staging of the /funding site integration.

Reads originals from ../../source (never writes there), refuses unless each original's sha256 equals the value ROOT put in
prepare-expect.json (nulls refuse), applies anchor-exact ADDITIVE edits, and writes results under ./staging/ only.
Every anchor must occur exactly once; all original lines are preserved.
"""
from pathlib import Path
import hashlib
import json
import sys

HERE = Path(__file__).resolve().parent
SRC = (HERE / "../../source").resolve()
OUT = HERE / "staging"

BOOT_ANCHOR = '  sessions:  () => import("./pages/sessions.js"),  // every session that can act for the wallet; owner controls\n'
BOOT_ADD = '  funding:   () => import("./pages/funding.js"),   // UNREVIEWED: budget migration + successor gas.fund; refuses while FUNDING_RUNTIME is null\n'
CONFIG_ADD = '''
// Successor funding (/funding). All null/empty = the page refuses; root sets them only from deployment receipts + review.
export const FUNDING_RUNTIME = null;              // { schema: "enclave-funding-browser-runtime-r1", ... } (lib/funding-client.mjs parseRuntimePins)
export const FUNDING_MIGRATION_APPROVAL = null;   // { rootReviewed: true, termsHash: "0x..." } of ONE reviewed migration plan
export const FUNDING_RECOVERY_DEPLOYMENTS = [];   // deployment ids, re-read on chain before every use (provisional)
'''
VENDOR_ANCHOR = "// Fail loud if an upgrade ever drops an export the callers destructure, so a\n"
VENDOR_ADD = '''// site/vendor/funding.js <- an esbuild bundle of client-migration-r1/lib/browser-entry.mjs. Default OFF: copied only when
// FUNDING_VENDOR_SRC is set, and only if its sha256 equals FUNDING_VENDOR_SHA256 (root-reviewed artifact).
if (process.env.FUNDING_VENDOR_SRC) {
  const bytes = fs.readFileSync(process.env.FUNDING_VENDOR_SRC);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== String(process.env.FUNDING_VENDOR_SHA256 || "")) throw new Error(`funding.js sha256 ${sha} is not FUNDING_VENDOR_SHA256`);
  fs.writeFileSync(path.join(OUT, "funding.js"), bytes);
  console.log(`[vendor] funding.js: ${bytes.length} bytes, sha256 ${sha.slice(0, 16)}… (reviewed) ✓`);
}

'''
HTML_EDITS = [("<title>Sessions · Enclave</title>", "<title>Funding · Enclave</title>"),
              ('<div id="ssBody" class="co-body"></div>', '<div id="fdBody" class="co-body"></div>')]

FILES = {"site/js/boot.js", "site/js/core/config.js", "scripts/build-vendor.mjs", "site/sessions.html"}


def once(text, anchor, name):
    if text.count(anchor) != 1:
        sys.exit(f"{name}: anchor occurs {text.count(anchor)} times; refusing")


def main():
    expect = json.loads((HERE / "prepare-expect.json").read_text())
    if set(expect) != FILES:
        sys.exit("prepare-expect.json must name exactly " + ", ".join(sorted(FILES)))
    orig = {}
    for rel in sorted(FILES):
        want = expect[rel]
        if not isinstance(want, str) or len(want) != 64:
            sys.exit(f"{rel}: no root-reviewed sha256 in prepare-expect.json; refusing")
        b = (SRC / rel).read_bytes()
        got = hashlib.sha256(b).hexdigest()
        if got != want:
            sys.exit(f"{rel}: sha256 {got} != expected {want}; refusing")
        orig[rel] = b.decode("utf-8")
    if OUT.exists():
        sys.exit("staging/ exists; refusing to overwrite (inspect or move it first)")

    boot = orig["site/js/boot.js"]
    once(boot, BOOT_ANCHOR, "boot.js")
    vendor = orig["scripts/build-vendor.mjs"]
    once(vendor, VENDOR_ANCHOR, "build-vendor.mjs")
    html = orig["site/sessions.html"]
    for a, _ in HTML_EDITS:
        once(html, a, "sessions.html")
    for a, b in HTML_EDITS:
        html = html.replace(a, b)

    out = {
        "site/js/boot.js": boot.replace(BOOT_ANCHOR, BOOT_ANCHOR + BOOT_ADD),
        "site/js/core/config.js": orig["site/js/core/config.js"] + CONFIG_ADD,
        "scripts/build-vendor.mjs": vendor.replace(VENDOR_ANCHOR, VENDOR_ADD + VENDOR_ANCHOR),
        "site/funding.html": html,
        "site/js/pages/funding.js": (HERE / "site-patch/js/pages/funding.js").read_text(),
    }
    for rel, text in out.items():
        if rel in orig and not all(line in text for line in orig[rel].splitlines()):
            sys.exit(f"{rel}: an original line was lost; refusing")
        p = OUT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    manifest = {rel: hashlib.sha256((OUT / rel).read_bytes()).hexdigest() for rel in out}
    (OUT / "STAGED-SHA256.json").write_text(json.dumps({"originals": expect, "staged": manifest}, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
