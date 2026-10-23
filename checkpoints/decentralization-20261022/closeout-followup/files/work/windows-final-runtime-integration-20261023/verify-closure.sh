#!/usr/bin/env bash
# The packaged node closure must stand alone: extracted into an empty directory, the committed deploy-files closure()
# walk rooted THERE (agent.mjs's whole import graph + EXTRA) must find every file, report zero problems and list exactly
# node-deploy-files.txt; every extracted byte must match node-deploy-files.sha256. Fails hard on any difference.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
TAR=${1:-$H/node-closure.tar}; X="$H/tmp/closure-verify"; rm -rf "$X"; mkdir -p "$X"; tar -xf "$TAR" -C "$X"
sha256sum "$TAR"; [ "$(find "$X" -type f | wc -l)" = "$(wc -l < "$H/node-deploy-files.txt")" ]
(cd "$X" && sha256sum -c --quiet "$H/node-deploy-files.sha256"); echo "extracted bytes match node-deploy-files.sha256"
cd "$H/candidate"
timeout -k 10 120 unshare -rn node -e '
  const [root, want] = process.argv.slice(1);
  import(process.cwd() + "/windows/node/deploy-files.mjs").then(({ closure }) => {
    const r = closure({ root }); const list = require("fs").readFileSync(want, "utf8").trim().split("\n");
    if (r.problems.length) { console.error("problems:", r.problems); process.exit(2); }
    if (JSON.stringify(r.files) !== JSON.stringify(list)) { console.error("closure differs from the list"); process.exit(3); }
    if (!r.files.includes("windows/node/origin-request.mjs")) process.exit(4);
    console.log("extracted package resolves agent.mjs import graph alone: " + r.files.length + " files, 0 problems, origin-request.mjs included");
  });' "$X" "$H/node-deploy-files.txt"
