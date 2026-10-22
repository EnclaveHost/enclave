#!/usr/bin/env python3
"""Integration patches for the default-independence candidate: one patch per concern, each against the EXACT base bytes
(base/, base-manifest.sha256). A file appears in exactly one concern. Also writes patches/INDEX.json with every file's
base and new sha256, its git state at snapshot, and the concern it ships in. Refuses if base/ drifted from its manifest."""
import hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE, TREE, OUT = os.path.join(HERE, "base"), os.path.join(HERE, "tree"), os.path.join(HERE, "patches")
CONCERNS = [
  ("01-default-profile-core", "packaged default profile: digest + authority checks at load, on-chain authority gate, startup, panel", [
    "site/js/core/sha256.js", "site/js/core/authority-profile.js", "site/js/core/default-authority.js", "site/js/core/default-startup.js",
    "site/js/gen/default-profile.js", "site/js/core/independent.js", "site/js/core/config.js", "site/js/boot.js", "site/js/core/wallet.js", "site/js/core/independent-ui.js", "site/components/wallet-button/wallet-button.js", "site/components/enclave-panel/enclave-panel.js", "site/components/live-verify/live-verify.js", "site/js/core/verify.js"]),
  ("02-discovery-capacity-policy", "service-index discovery, signed host capacity, host-owner veto scoped to its host, fleet from registry", [
    "site/js/core/service-discovery.js", "site/js/core/host-capacity.js", "site/js/core/host-policy.js", "site/js/core/independent-chain.js",
    "site/js/core/fleet-read.js", "site/js/core/enclave-network.js", "site/js/core/independent-management.js", "site/js/pages/apps.js",
    "site/js/pages/deploy.js", "site/js/pages/dashboard.js",
    "scripts/vendor/discovery-entry.mjs", "scripts/build-discovery-vendor.mjs", "site/vendor/discovery.js", "site/vendor/discovery.MANIFEST.json"]),
  ("03-existing-owners", "relay-era vault records listed and released, hosted-account notice, independent /sessions page, getEnclaves", [
    "site/js/core/api.js", "site/js/core/sessions.js", "site/components/deployments/deployments.js", "site/js/pages/sessions.js",
    "site/js/pages/checkout.js", "site/js/pages/link.js", "site/js/pages/sso-authorize.js"]),
  ("04-build-and-gate", "deterministic profile generation, verification, activation gate, build module; build-site --default-profile", [
    "scripts/network/default-profile.mjs", "scripts/build-site.mjs"]),
  ("05-tests", "unit + browser tests and fixtures", [
    "test/site-default-authority.test.mjs", "test/site-default-discovery.test.mjs", "test/site-default-independence.test.mjs",
    "test/helpers/default-site-fixture.mjs", "test/helpers/default-independence-rig.mjs"]),
  ("06-docs", "user/operator documentation", ["docs/network/default-independence.md"]),
]

def sha(p):
  with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()

def main():
  manifest = {}
  for line in open(os.path.join(HERE, "base-manifest.sha256")):
    h, p = line.rstrip("\n").split("  ", 1); manifest[p[2:] if p.startswith("./") else p] = h
  dirty = {}
  for line in open(os.path.join(HERE, "main-dirty-at-snapshot.txt")):
    if line.strip(): dirty[line[3:].rstrip("\n")] = line[:2]
  # every changed or new file in the tree must belong to exactly one concern (build output and node_modules excluded)
  changed = []
  for root, dirs, files in os.walk(TREE):
    dirs[:] = [d for d in dirs if d not in ("node_modules",) and not (root == os.path.join(TREE, "site") and d == "dist")]
    for f in files:
      rel = os.path.relpath(os.path.join(root, f), TREE)
      if os.path.islink(os.path.join(TREE, rel)): continue          # symlinks are not in the manifest (find -type f)
      if manifest.get(rel) != sha(os.path.join(TREE, rel)): changed.append(rel)
  listed = [f for _, _, fs in CONCERNS for f in fs]
  missing = sorted(set(changed) - set(listed)); stale = sorted(set(listed) - set(changed))
  if missing or stale: sys.exit("unassigned changes: %s; listed but unchanged: %s" % (missing, stale))
  for rel, h in manifest.items():
    p = os.path.join(BASE, rel)
    if os.path.exists(p) and rel in listed and sha(p) != h: sys.exit("base drifted from its manifest: " + rel)
  os.makedirs(OUT, exist_ok=True)
  index = {"base": open(os.path.join(HERE, "snapshot-head.txt")).read().strip(), "snapshot": open(os.path.join(HERE, "snapshot-time.txt")).read().strip(), "concerns": []}
  for name, title, files in CONCERNS:
    parts, entries = [], []
    for rel in files:
      b, t = os.path.join(BASE, rel), os.path.join(TREE, rel)
      before = manifest.get(rel)
      r = subprocess.run(["diff", "-u", "--label", "a/" + rel, "--label", "b/" + rel, b if before else "/dev/null", t], capture_output=True)
      if r.returncode not in (0, 1): sys.exit("diff failed for " + rel)
      if rel.endswith(".js") and rel.startswith("site/vendor/"):
        parts.append("Binary-equivalent vendor bundle %s: sha256 %s (rebuild with its builder; not inlined)\n" % (rel, sha(t)))
      else: parts.append(r.stdout.decode())
      entries.append({"path": rel, "baseSha256": before, "newSha256": sha(t), "gitAtSnapshot": dirty.get(rel, "clean" if before else "new")})
    text = "".join(parts)
    with open(os.path.join(OUT, name + ".patch"), "w") as f: f.write(text)
    index["concerns"].append({"name": name, "title": title, "patch": "patches/" + name + ".patch", "patchSha256": hashlib.sha256(text.encode()).hexdigest(), "files": entries})
  with open(os.path.join(OUT, "INDEX.json"), "w") as f: json.dump(index, f, indent=2); f.write("\n")
  print(json.dumps([(c["name"], len(c["files"]), c["patchSha256"][:16]) for c in index["concerns"]]))

if __name__ == "__main__": main()
