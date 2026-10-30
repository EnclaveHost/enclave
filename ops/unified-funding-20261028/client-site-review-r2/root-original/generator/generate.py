#!/usr/bin/env python3
"""client-site-repair-r2 candidate generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 client-site-repair-r2/generator/generate.py

Layout (all relative to this file): HERE = client-site-repair-r2/, UF = HERE/.., SOURCE = UF/../source.
Reads ONLY the inputs pinned in generated/SOURCE-PINS.json (paths relative to UF; every value must be a root-filled
sha256, null or drift refuses) and writes ONLY HERE/candidate/ (refuses if it exists). Never writes into source/, never
runs a build, never touches the network. Refuses when a NEW output's target already exists in SOURCE (no overwrite).

Outputs (candidate/ mirrors the source repository root):
  sdk/funding/*.mjs + MANIFEST.json   the r4 core + client-r1 codec, BYTE-IDENTICAL except import specifiers (exact
                                      counts; target text must not pre-exist; reverse rewrite == original bytes; no
                                      "../" or absolute specifier remains)
  scripts/build-funding-vendor.mjs, site/js/pages/funding.js, site/js/funding/{state,flows}.js   new (authored)
  site/funding.html                   new, derived from site/sessions.html by exact anchored replacements
  site/js/boot.js, scripts/build-site.mjs, site/_redirects     patched copies: INSERT-ONLY at anchors
  site/js/core/config.js, scripts/build-vendor.mjs             patched copies: APPEND-ONLY
  ROLLBACK/<target>                   the exact original bytes of every patched target
  INSTALL-MANIFEST.json               targets, hashes, replaces_sha256 / must_not_exist, rollback actions
Each insert-only patch is (anchor, anchor + inserted) or (anchor, inserted + anchor): the anchor occurs exactly once,
the replacement contains it, and replacing back yields the pinned source exactly.
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent          # client-site-repair-r2
UF = HERE.parent                                        # unified-funding-20261028
SOURCE = UF.parent / "source"
OUT = HERE / "candidate"
STAGE = "client-site-repair-r2"

VIEM_R4 = '"../../../source/node_modules/viem/_esm/index.js"'
VIEM_CODEC = '"../../source/node_modules/viem/_esm/index.js"'
CODEC_R4 = '"../../client-r1/funding-codec.mjs"'
VIEM = '"viem"'
CODEC = '"./funding-codec.mjs"'

# source -> (output name, [(from, to, exact count)])
CORE = {
    "client-repair-r4/lib/util.mjs": ("util.mjs", [(VIEM_R4, VIEM, 1)]),
    "client-repair-r4/lib/v2-store.mjs": ("v2-store.mjs", [(VIEM_R4, VIEM, 1), (CODEC_R4, CODEC, 1)]),
    "client-repair-r4/lib/chain-proof.mjs": ("chain-proof.mjs", [(VIEM_R4, VIEM, 1)]),
    "client-repair-r4/lib/funding-client.mjs": ("funding-client.mjs", [(VIEM_R4, VIEM, 1), (CODEC_R4, CODEC, 1)]),
    "client-repair-r4/lib/migration.mjs": ("migration.mjs", [(VIEM_R4, VIEM, 1), (CODEC_R4, CODEC, 1)]),
    "client-repair-r4/lib/browser-entry.mjs": ("browser-entry.mjs", []),
    "client-r1/funding-codec.mjs": ("funding-codec.mjs", [(VIEM_CODEC, VIEM, 1)]),
}
AUTHORED = {
    f"{STAGE}/authored/scripts/build-funding-vendor.mjs": "scripts/build-funding-vendor.mjs",
    f"{STAGE}/authored/site/js/pages/funding.js": "site/js/pages/funding.js",
    f"{STAGE}/authored/site/js/funding/state.js": "site/js/funding/state.js",
    f"{STAGE}/authored/site/js/funding/flows.js": "site/js/funding/flows.js",
}
SITE = [
    "../source/site/js/boot.js", "../source/site/js/core/config.js", "../source/site/sessions.html",
    "../source/scripts/build-site.mjs", "../source/scripts/build-vendor.mjs", "../source/site/_redirects",
]


def after(anchor, inserted):
    return (anchor, anchor + inserted)


BOOT_LINE = '  sessions:  () => import("./pages/sessions.js"),  // every session that can act for the wallet; owner controls\n'
VENDOR_COPY = '  fs.cpSync(path.join(SITE, d), path.join(DIST, d), { recursive: true });\n'
SITE_CHECK = '''// /funding needs site/vendor/funding.js built from THIS sdk/funding core (scripts/build-funding-vendor.mjs; client-site-repair-r2)
{
  const { createHash } = await import("node:crypto");
  const h = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const side = JSON.parse(fs.readFileSync(path.join(SITE, "vendor", "funding.manifest.json"), "utf8"));
  if (h(path.join(SITE, "vendor", "funding.js")) !== side.bundleSha256) throw new Error("site/vendor/funding.js differs from funding.manifest.json; run node scripts/build-funding-vendor.mjs");
  if (h(path.join(ROOT, "sdk", "funding", "MANIFEST.json")) !== side.coreManifestSha256) throw new Error("site/vendor/funding.js was built from another sdk/funding core; run node scripts/build-funding-vendor.mjs");
}
'''
# target -> (source, [(anchor, replacement)]): INSERT-ONLY (each replacement contains its anchor)
PATCHES = {
    "site/js/boot.js": ("../source/site/js/boot.js", [after(BOOT_LINE,
        '  funding:   () => import("./pages/funding.js"),   // gas funding: owner controls + reviewed migration; offers nothing while FUNDING_RUNTIME is null\n')]),
    "scripts/build-site.mjs": ("../source/scripts/build-site.mjs", [
        after('sessions: "sessions.html"', ', funding: "funding.html"'),
        after('"grant.html", "sessions.html"', ', "funding.html"'),
        after(VENDOR_COPY, SITE_CHECK)]),
    "site/_redirects": ("../source/site/_redirects", [after("/grant      /grant.html      200\n",
        "# gas funding (owner controls + a reviewed migration; nothing is offered while FUNDING_RUNTIME is null)\n"
        "/funding    /funding.html    200\n")]),
}
# target -> (source, appended text): APPEND-ONLY
APPENDS = {
    "site/js/core/config.js": ("../source/site/js/core/config.js", '''
// ---- Successor funding (/funding). All null = nothing is offered. Set ONLY from deployment receipts and reviewed terms.
export const FUNDING_RUNTIME = null;              // { schema: "enclave-funding-browser-runtime-r1", ... } (sdk/funding parseRuntimePins)
export const FUNDING_MIGRATION_PROPOSAL = null;   // { schema: "enclave-funding-migration-proposal-r1", chainId, owner, oldSid, legacy6, gas: [...], deploymentIds: [...] }
export const FUNDING_MIGRATION_APPROVAL = null;   // { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash, owner, chainId, oldSid }
'''),
    "scripts/build-vendor.mjs": ("../source/scripts/build-vendor.mjs", '''
// site/vendor/funding.js <- sdk/funding (client-site-repair-r2). This script emptied site/vendor/ above, so the funding
// bundle is rebuilt here too; build-funding-vendor.mjs validates everything before it writes (and writes nothing on refusal).
await import("./build-funding-vendor.mjs");
'''),
}
HTML_EDITS = [
    ("<title>Sessions · Enclave</title>", "<title>Gas funding · Enclave</title>"),
    ('<meta name="description" content="Every session that can act for your wallet: this browser, other devices and agents." />',
     '<meta name="description" content="Your gas funding: controls, and a reviewed migration of an original session." />'),
    ('<h1 class="sr-only">Sessions</h1>', '<h1 class="sr-only">Gas funding</h1>'),
    ('<section id="sessions" data-view="sessions" aria-label="Your sessions">',
     '<section id="funding" data-view="funding" aria-label="Your gas funding">'),
    ('<c-section-head eyebrow="Sessions" heading="Everything that can act for your wallet.">',
     '<c-section-head eyebrow="Funding" heading="Gas for your apps, under your control.">'),
    ("<p>This browser, your other devices and your agents. Each session can only do what its policy allows, only spend its own budget, and ends at its expiry. Terminate any of them here; unspent budget returns to your wallet.</p>",
     "<p>Nothing here signs or sends on its own: every wallet prompt follows your click, and a migration is offered only for an exactly reviewed plan. You can end, terminate or withdraw at any time.</p>"),
    ('<div id="ssBody" class="co-body"></div>', '<div id="fdBody" class="co-body"></div>'),
]


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def die(msg: str):
    sys.exit(f"generate.py: {msg}")


def once(text: str, anchor: str, what: str):
    n = text.count(anchor)
    if n != 1:
        die(f"{what}: anchor occurs {n} times (expected 1): {anchor[:60]!r}")


def insert_only(text: str, edits, what: str) -> str:
    new = text
    for a, b in edits:
        if a not in b or (not b.startswith(a) and not b.endswith(a)):
            die(f"{what}: a replacement is not its anchor plus inserted text")
        once(new, a, what)
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        once(back, b, what)
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: removing the insertions does not give back the pinned source exactly")
    return new


def main():
    if HERE.name != STAGE:
        die(f"this generator must live in {STAGE}/generator/ (found {HERE.name})")
    pins = json.loads((HERE / "generated" / "SOURCE-PINS.json").read_text())["inputs"]
    expected = set(CORE) | set(AUTHORED) | set(SITE)
    if set(pins) != expected:
        die(f"SOURCE-PINS.json must list exactly: {sorted(expected)}")
    src = {}
    for rel, want in pins.items():
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
            die(f"{rel}: no root-filled sha256 (refusing)")
        b = (UF / rel).read_bytes()
        if sha(b) != want:
            die(f"{rel}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[rel] = b
    if OUT.exists():
        die("candidate/ already exists; inspect or move it first")

    outputs, kinds, replaces = {}, {}, {}

    # ---- the proven core: import specifiers only ------------------------------------------------------------------
    core_manifest = {"schema": "client-site-repair-r2-funding-core/v1", "source": {}, "files": {}}
    for rel, (name, rules) in CORE.items():
        text = src[rel].decode("utf-8")
        new = text
        for frm, to, count in rules:
            if text.count(frm) != count:
                die(f"{rel}: {frm} occurs {text.count(frm)} times (expected {count})")
            if text.count(to) != 0:
                die(f"{rel}: {to} already occurs; the rewrite would not be reversible")
            new = new.replace(frm, to)
        back = new
        for frm, to, _ in rules:
            back = back.replace(to, frm)
        if back.encode("utf-8") != src[rel]:
            die(f"{rel}: the rewrite is not exactly reversible")
        if re.search(r'''(from|import)\s*\(?\s*["']\.\./''', new):
            die(f"{rel}: a ../ import specifier remains after rewriting")
        if re.search(r'''(from|import)\s*\(?\s*["'](/|[A-Za-z]:\\|file:)''', new):
            die(f"{rel}: an absolute import specifier remains")
        out_name = f"sdk/funding/{name}"
        outputs[out_name] = new.encode("utf-8")
        kinds[out_name] = "new (core, import specifiers rewritten only)"
        core_manifest["source"][name] = {"from": rel, "sha256": pins[rel]}
        core_manifest["files"][name] = sha(outputs[out_name])
    outputs["sdk/funding/MANIFEST.json"] = (json.dumps(core_manifest, indent=2) + "\n").encode("utf-8")
    kinds["sdk/funding/MANIFEST.json"] = "new"

    for rel, target in AUTHORED.items():
        outputs[target] = src[rel]
        kinds[target] = "new (authored)"

    # ---- additive site patches ----------------------------------------------------------------------------------------
    for target, (orig, edits) in PATCHES.items():
        text = src[orig].decode("utf-8")
        if "funding.html" in text or "pages/funding.js" in text or "funding.manifest.json" in text:
            die(f"{orig} already mentions the funding page")
        outputs[target] = insert_only(text, edits, orig).encode("utf-8")
        kinds[target] = "patched copy (insert-only)"
        replaces[target] = orig
    for target, (orig, add) in APPENDS.items():
        text = src[orig].decode("utf-8")
        if re.search(r"\bFUNDING_(RUNTIME|MIGRATION_PROPOSAL|MIGRATION_APPROVAL)\b", text) or "build-funding-vendor" in text:
            die(f"{orig} already defines the funding additions")
        new = text + ("" if text.endswith("\n") else "\n") + add
        if not new.startswith(text):
            die(f"{orig}: the patch is not a pure append")
        outputs[target] = new.encode("utf-8")
        kinds[target] = "patched copy (append-only)"
        replaces[target] = orig

    html = src["../source/site/sessions.html"].decode("utf-8")
    for a, b in HTML_EDITS:
        once(html, a, "sessions.html")
        html = html.replace(a, b)
    outputs["site/funding.html"] = html.encode("utf-8")
    kinds["site/funding.html"] = "new (derived from site/sessions.html)"

    for target in outputs:
        if target not in replaces and (SOURCE / target).exists():
            die(f"{target} already exists in the source checkout; refusing to overwrite it")

    files = dict(outputs)
    for target, orig in replaces.items():
        files[f"ROLLBACK/{target}"] = src[orig]
    for p, b in files.items():
        f = OUT / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    install = {
        "schema": "client-site-repair-r2-install/v1",
        "note": "Copy each output into the source repository root at `target` ONLY after root review. A patched target may "
                "be replaced only while it still has `replaces_sha256`; a new target only while it does not exist. "
                "Rollback: restore each patched target from ROLLBACK/<target> (sha256 = replaces_sha256) and delete each new "
                "target (plus site/vendor/funding.js and funding.manifest.json if built). Every FUNDING_* value is null.",
        "inputs": pins,
        "outputs": {},
        "rollback": [],
    }
    for p, b in sorted(outputs.items()):
        entry = {"target": p, "kind": kinds[p], "sha256": sha(b)}
        if p in replaces:
            entry["replaces_sha256"] = pins[replaces[p]]
            install["rollback"].append({"target": p, "action": "restore", "from": f"ROLLBACK/{p}", "sha256": pins[replaces[p]]})
        else:
            entry["must_not_exist"] = True
            install["rollback"].append({"target": p, "action": "delete"})
        install["outputs"][p] = entry
    for built in ("site/vendor/funding.js", "site/vendor/funding.manifest.json"):
        install["rollback"].append({"target": built, "action": "delete", "note": "built by scripts/build-funding-vendor.mjs"})
    (OUT / "INSTALL-MANIFEST.json").write_text(json.dumps(install, indent=2) + "\n")
    print(json.dumps({p: v["sha256"] for p, v in install["outputs"].items()}, indent=2))


if __name__ == "__main__":
    main()
