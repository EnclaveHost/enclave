#!/bin/bash
# composed/<scenario>.ps1 = harness/common-val.ps1 + the scenario minus its dot-source line: the EXACT text later sent as
# -EncodedCommand (execution policy applies to script files, not to commands; the machine policy is never changed).
set -euo pipefail
cd "$(dirname "$0")"; rm -rf composed; mkdir composed
for f in harness/w*.ps1; do n=$(basename "$f"); { cat harness/common-val.ps1; grep -v '^\. "\$PSScriptRoot\\common-val.ps1"$' "$f"; } > "composed/$n"
  grep -q 'common-val' "composed/$n" && { echo "compose failed: $n still dot-sources"; exit 1; }; done
(cd composed && sha256sum *.ps1)
