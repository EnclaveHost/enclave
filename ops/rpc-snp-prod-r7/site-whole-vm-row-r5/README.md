# Site release r5: no Open link on a whole-VM app's dashboard row

Status: **ACTIVE on all four edges** since 2026-11-12 06:38Z. Built 06:20Z; the operator ran `run-activate.py`
06:35Z to 06:38Z. It is the base for the next additive site release.

| edge | verified over HTTPS | result |
| --- | --- | --- |
| us-west | 06:36:01Z | apex-switched, 1570 files verified, 2 roots changed, r4 tree preserved |
| ca-east | 06:36:28Z | same |
| ap-southeast | 06:37:22Z | same |
| eu-central | 06:38:29Z | same |

`activation/` holds each edge's intent, result and served-file verification (87 files each: the 81 of the delta and
six preserved ones). Checked again from outside at 06:45Z: every edge address and public DNS serve a `js/boot.js`
that loads `js/boot-whole-vm-row-r5.js`, and r4's entry file is still served. In a signed-in browser the Enclave RPC
row shows "no app address · an API served on the VM's own attested certificate", no Open control, with no console
errors; the other rows keep their address and Open link.

The dashboard row for Enclave RPC (deployment `0x5ff56a4d…454f`) showed its Open control in pulsing amber. The
dashboard derives `https://5ff56a4d.app.enclave.host` for every running row and probes it; a whole-VM app (catalog
runtime `sev-snp-vm`) ends TLS on its own attested certificate and has no app-zone route, so the probe can never
answer. Main has the fix since c2b36aa62: such a row shows no address and no Open link, and says why.

The live site is not built from main. It is the additive composite r4
(`bafybeigpmrrdbibmlqiljg5v6a5bnstuv36ovixm7vbuxsala2hhhu2mea`, 1490 files), built from the reconstructed graph in
`ops/unified-funding-20261028/wallet-release-reader-site-r4/source/enclave`, and main's `site/` has since diverged
from it by far more than this fix. So this release repeats r4's method with one source file changed.

- `backport.py`, `backport.diff`: the change to `site/components/deployments/deployments.js` of the r4 source. Same
  logic as main; the note's style is inline because `css/site.css` is an existing file an additive release leaves alone.
  `backport-check.mjs` runs main's assertions for it against the backported file.
- `build.mjs`: r4's esbuild options and layout. Checked first: the unmodified r4 source rebuilds to r4's 98 output
  files byte for byte, so chunks the change does not reach are the ones already served. Result in `release.json`:
  CID `bafybeigmmbopfwmsafgquzaravml6xv66syrrp6hovtegubd5loi7slyaq`, 1570 files, 1489 of the base preserved, 80 new
  files, `js/boot.js` the only existing file replaced. Every module reachable from the new `js/boot.js` exists in the
  tree. `base-files.json` beside the script is the `files` map of r4's `release.json`.
- `capture-current.py` (read-only), `preflight.py` (local): all four edges serve exactly the r4 tree, with the active
  root named twice in the Caddy config and twice in the Caddyfile (captured 06:18Z). The captures hold edge
  configuration and are not in the repository.
- `edge-apply.py`, `apply-edge.py`, `verify-edge.py`: r4's activation, with a new journal directory
  (`/var/lib/enclave-whole-vm-row-site-r5`). Per edge: verify the live tree, copy it to the new CID's directory, add
  the 81 files, verify every hash, validate the candidate config, switch the two roots through the Caddy admin
  socket with `If-Match`, rewrite the Caddyfile to match. No service restart; the r4 tree stays in place.
- `run-activate.py`: the four edges in turn, each captured again, applied and verified over HTTPS; stops at the first
  failure and never retries an edge by itself.

The working copy with the build output, the composite tree and the captures is
`../unified-funding-20261028/whole-vm-row-site-r5` beside the source checkout (outside the repository). Activation was
`python3 run-activate.py` there; it skips an edge that already has its verification file.

Rollback of an edge: the journal directory holds `before.json` and `before.Caddyfile`; put the Caddyfile back and
PATCH `/config/` with `before.json` (the two roots point at the r4 tree again). Nothing of r4 is modified.
