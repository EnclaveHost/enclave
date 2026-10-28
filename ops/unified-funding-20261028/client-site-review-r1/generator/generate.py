#!/usr/bin/env python3
"""client-site-integration-r1 candidate generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 client-site-integration-r1/generator/generate.py

Reads ONLY the inputs pinned in generated/SOURCE-PINS.json (paths relative to unified-funding-20261028/; every value must
be a root-filled sha256, null or drift refuses), and writes ONLY client-site-integration-r1/candidate/ (refuses if it
exists). It never writes into source/, never runs a build, never touches the network.

Outputs (candidate/ mirrors the source repository root; INSTALL-MANIFEST.json lists target paths and hashes):
  sdk/funding/{util,v2-store,chain-proof,funding-client,migration,browser-entry,funding-codec}.mjs
      the proven core, BYTE-IDENTICAL except import specifiers: the staging viem path -> "viem" (resolved by the site's
      existing esbuild from node_modules), the staging codec path -> "./funding-codec.mjs". Each rewrite has an exact
      expected count, the target text must not pre-exist, the reverse rewrite must reproduce the original bytes, and no
      "../" or absolute import specifier may remain.
  sdk/funding/MANIFEST.json            sha256 of every sdk/funding file + the pinned source hashes they came from
  scripts/build-funding-vendor.mjs     new (authored)
  site/js/pages/funding.js             new (authored)
  site/js/funding/state.js             new (authored)
  site/funding.html                    new, derived from site/sessions.html by exact anchored replacements
  site/js/boot.js                      patched copy: ONE added PAGES line after the sessions line
  site/js/core/config.js               patched copy: three appended `= null` exports
  scripts/build-site.mjs               patched copy: "funding.html" added to PAGE_HTML and to the copied-HTML list
  site/_redirects                      patched copy: ONE added "/funding /funding.html 200" line (+ comment) after /grant
Every patched copy must reverse EXACTLY to its pinned source bytes (so the edits are purely additive).
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent          # client-site-integration-r1
UF = HERE.parent                                        # unified-funding-20261028
OUT = HERE / "candidate"

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
    "client-site-integration-r1/authored/scripts/build-funding-vendor.mjs": "scripts/build-funding-vendor.mjs",
    "client-site-integration-r1/authored/site/js/pages/funding.js": "site/js/pages/funding.js",
    "client-site-integration-r1/authored/site/js/funding/state.js": "site/js/funding/state.js",
}
SITE = [
    "../source/site/js/boot.js", "../source/site/js/core/config.js", "../source/site/sessions.html",
    "../source/scripts/build-site.mjs", "../source/site/_redirects",
]
# target -> (source, [(anchor, replacement)]); each anchor must occur exactly once in the source, and each replacement
# CONTAINS its anchor (only text is added around it)
PATCHES = {
    "site/js/boot.js": ("../source/site/js/boot.js", [(
        '  sessions:  () => import("./pages/sessions.js"),  // every session that can act for the wallet; owner controls\n',
        '  sessions:  () => import("./pages/sessions.js"),  // every session that can act for the wallet; owner controls\n'
        '  funding:   () => import("./pages/funding.js"),   // gas funding: owner controls + reviewed migration; offers nothing while FUNDING_RUNTIME is null\n')]),
    "scripts/build-site.mjs": ("../source/scripts/build-site.mjs", [
        ('grant: "grant.html", sessions: "sessions.html" };', 'grant: "grant.html", sessions: "sessions.html", funding: "funding.html" };'),
        ('"grant.html", "sessions.html", "404.html"', '"grant.html", "sessions.html", "funding.html", "404.html"')]),
    "site/_redirects": ("../source/site/_redirects", [(
        "/grant      /grant.html      200\n",
        "/grant      /grant.html      200\n"
        "# gas funding (owner controls + a reviewed migration; nothing is offered while FUNDING_RUNTIME is null)\n"
        "/funding    /funding.html    200\n")]),
}
CONFIG_ADD = '''
// ---- Successor funding (/funding). All null = nothing is offered. Set ONLY from deployment receipts and reviewed terms.
export const FUNDING_RUNTIME = null;              // { schema: "enclave-funding-browser-runtime-r1", ... } (sdk/funding parseRuntimePins)
export const FUNDING_MIGRATION_PROPOSAL = null;   // { schema: "enclave-funding-migration-proposal-r1", chainId, owner, oldSid, legacy6, gas: [...], deploymentIds: [...] }
export const FUNDING_MIGRATION_APPROVAL = null;   // { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash, owner, chainId, oldSid }
'''
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


def main():
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
    core_manifest = {"schema": "client-site-integration-r1-funding-core/v1", "source": {}, "files": {}}
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

    # ---- authored files, copied verbatim ----------------------------------------------------------------------------
    for rel, target in AUTHORED.items():
        outputs[target] = src[rel]
        kinds[target] = "new (authored)"

    # ---- additive site patches (each must reverse exactly to its pinned source) ---------------------------------
    for target, (orig, edits) in PATCHES.items():
        text = src[orig].decode("utf-8")
        if "funding.html" in text or "pages/funding.js" in text or "/funding " in text:
            die(f"{orig} already mentions the funding page")
        new = text
        for a, b in edits:
            if a not in b:
                die(f"{orig}: a replacement does not contain its anchor (not additive)")
            once(new, a, orig)
            new = new.replace(a, b)
        back = new
        for a, b in reversed(edits):
            once(back, b, target)
            back = back.replace(b, a)
        if back != text:
            die(f"{target}: the patch is not exactly reversible")
        outputs[target] = new.encode("utf-8")
        kinds[target] = "patched copy (additive)"
        replaces[target] = orig

    config = src["../source/site/js/core/config.js"].decode("utf-8")
    if re.search(r"\bFUNDING_(RUNTIME|MIGRATION_PROPOSAL|MIGRATION_APPROVAL)\b", config):
        die("config.js already defines a FUNDING_* export")
    new_config = config + ("" if config.endswith("\n") else "\n") + CONFIG_ADD
    if not new_config.startswith(config):
        die("config.js: the patch is not a pure append")
    outputs["site/js/core/config.js"] = new_config.encode("utf-8")
    kinds["site/js/core/config.js"] = "patched copy (appended null exports)"
    replaces["site/js/core/config.js"] = "../source/site/js/core/config.js"

    html = src["../source/site/sessions.html"].decode("utf-8")
    for a, b in HTML_EDITS:
        once(html, a, "sessions.html")
        html = html.replace(a, b)
    outputs["site/funding.html"] = html.encode("utf-8")
    kinds["site/funding.html"] = "new (derived from site/sessions.html)"

    for p, b in outputs.items():
        f = OUT / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    install = {
        "schema": "client-site-integration-r1-install/v1",
        "note": "Copy each output into the source repository root at `target` ONLY after root review; a patched file may "
                "replace its source file only while that file still has `replaces_sha256`. Nothing here activates funding: "
                "every FUNDING_* config value is null.",
        "inputs": pins,
        "outputs": {},
    }
    for p, b in sorted(outputs.items()):
        entry = {"target": p, "kind": kinds[p], "sha256": sha(b)}
        if p in replaces:
            entry["replaces_sha256"] = pins[replaces[p]]
        install["outputs"][p] = entry
    (OUT / "INSTALL-MANIFEST.json").write_text(json.dumps(install, indent=2) + "\n")
    print(json.dumps({p: v["sha256"] for p, v in install["outputs"].items()}, indent=2))


if __name__ == "__main__":
    main()
