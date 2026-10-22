#!/bin/bash
# W9 local proof before minipc: (1) build a TEST stage with the isolated-root scripts into winval/v2/build-test (the final
# out/ archives are not touched); (2) fixture-world --install config passes the REAL runner `check` with no warnings.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
sha256sum out/enclave-host-services-hs2.tar out/enclave-host-services-hs2-windows.tar
step BUILD-TEST-STAGE node build-stage-r2.mjs --tree tree-final --app-static capture/app-static.json --out winval/v2/build-test >/dev/null
step FIXTURES env -C winval node build.mjs
T=$(mktemp -d); trap 'kill $(cat "$T/pid" 2>/dev/null) 2>/dev/null; rm -rf "$T"' EXIT
S=winval/v2/build-test/stage-r2/enclave-host-services-hs2-windows
mkdir -p "$T/inst/program" "$T/inst/root/state" "$T/inst/root/data"
cp -r "$S/packages" "$T/inst/program/packages"
node winval/dist/fixture-world.mjs --install "$T/fx" "$S/packages" capture/app-static.json "$T/inst/program/packages" "$T/inst/root/state" "$T/inst/root/data" & echo $! > "$T/pid"
for i in $(seq 1 100); do [ -f "$T/fx/world.json" ] && break; sleep 0.2; done
step FIXTURE-INSTALL-MODE test -f "$T/fx/host-services.json" -a -f "$T/fx/bootstrap-manifest.json" -a -d "$T/fx/artifacts" -a -d "$T/fx/policy-import"
step PATHS node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1] + "/fx/host-services.json"));
const b = c.services.find((s) => s.role === "bootstrap-replica").config;
const ok = c.packagesDir === process.argv[1] + "/inst/program/packages" && c.stateRoot === process.argv[1] + "/inst/root/state" && b.manifest === process.argv[1] + "/inst/root/data/bootstrap-manifest.json" && b.directory === process.argv[1] + "/inst/root/data/artifacts";
console.log(JSON.stringify({ packagesDir: c.packagesDir, stateRoot: c.stateRoot, manifest: b.manifest, artifacts: b.directory, importDir: c.platformHostPolicyCarriers.importDir })); process.exit(ok ? 0 : 1)' "$T"
check() { local out; out=$(node "$S/bin/host-services-runner.mjs" check "$T/fx/host-services.json"); local rc=$?; echo "$out"; [ $rc -eq 0 ] && echo "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.ok&&!(j.warnings||[]).length?0:1)})'; }
step RUNNER-CHECK-NO-WARNINGS check
grep -c 'InstallRoot' "$S/windows/"*.ps1
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
