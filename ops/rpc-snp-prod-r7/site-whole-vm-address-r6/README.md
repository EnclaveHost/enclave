# Site release r6: a whole-VM app's dashboard row shows its address once its version declares one

Status: **BUILT, NOT ACTIVATED** (built and preflighted 2026-11-12 08:23Z against the four edges serving r5).

r5 (`../site-whole-vm-row-r5/`) made the row of a whole-VM app (catalog runtime `sev-snp-vm`) show no address and no
Open link, because such an app had none. Enclave RPC r13 (`../release-r13/`) gives it one: its catalog version
declares `endpoints.web`, the VM holds a publicly trusted certificate for `<8 hex>.app.enclave.host`, and its host
routes the name. Main has the dashboard side since 154f4f458: a whole-VM row whose version declares a browser path
is an ordinary row; one that declares none keeps r5's note.

Same method as r5, on r5 as the base (`bafybeigmmbopfwmsafgquzaravml6xv66syrrp6hovtegubd5loi7slyaq`, 1570 files):

- `backport.py`, `backport.diff`: the change to `site/components/deployments/deployments.js` of the r5 source.
  `backport-check.mjs` runs main's assertions against the backported file with the r12 and r13 release configs:
  version 3 keeps the note, version 4 gets `https://5ff56a4d.app.enclave.host`, and an `endpoints.web` that is not
  a path on the app's own name counts as none.
- `build.mjs`: r4's esbuild options and layout. Result in `release.json`: CID
  `bafybeihcq2ckylienfbs3tg6smcucmagz3hcavl4sda44ogjmfz5dze5ia`, 1650 files, 1569 of the base preserved, 80 new
  files, `js/boot.js` the only existing file replaced.
- `capture-current.py` (read-only), `preflight.py` (local): all four edges serve exactly the r5 tree, with the
  active root named twice in the Caddy config and twice in the Caddyfile. The captures hold edge configuration and
  are not in the repository.
- `edge-apply.py`, `apply-edge.py`, `verify-edge.py`, `run-activate.py`: r5's activation with a new journal
  directory (`/var/lib/enclave-whole-vm-address-site-r6`). No service restart; the r5 tree stays in place.

The working copy with the build output, the composite tree and the captures is
`../unified-funding-20261028/whole-vm-address-site-r6` beside the source checkout (outside the repository).
Activation is `python3 run-activate.py` there, by the operator; `../release-r13/run-cutover.sh` runs it as its
second part. It may go live before or after the cutover: while the deployment is on version 3 the row reads as it
does under r5.

Rollback of an edge: the journal directory holds `before.json` and `before.Caddyfile`; put the Caddyfile back and
PATCH `/config/` with `before.json` (the two roots point at the r5 tree again). Nothing of r5 is modified.
