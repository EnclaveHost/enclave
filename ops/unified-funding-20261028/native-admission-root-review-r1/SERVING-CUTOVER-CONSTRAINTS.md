# Existing controls are not a serving-preserving cutover

Root independently read the peer-identified frozen R4 source on October29 after the native build review. This is source evidence, not a new observation of resident Windows modules.

- `host.mjs:3318-3326`: `caps.paused === true` selects every occupied deployment in `dropPlan`. `enforceOff` at3350-3356 invokes the stop/give-up path for remaining deployments on each tick. **Hosting paused is not an admission-only pause. Do not use it to stage this migration while preserving serving apps.**
- `wmiserve-run.mjs:17-20`: the relay lives while its manager's stdin remains open; EOF/error ends it. The manager owns the live pipe and readiness state. Restarting that manager can interrupt service even if Hyper-V leaves the VM running.
- `server.mjs:258-293`: recovery restores ownership/inventory with `recovered:true`, `appReady:false`, `relay:null`, status `starting`; it does not restore the former relay or readiness. Restart plus recovery is not a serving handover.

The next functional proposal must retain the resident Manager and relay pipes or implement and qualify an actual ownership transfer of those resources. Existing backend launch indirection can be a source integration point for shared allocation, but does not prove that the installed process can receive it live. No live extension hook has been established. Keep new-work exclusion separate from stopping apps and from fenced per-app protocol migration. No control toggle, restart, native execution or production write was performed for this review.

Reviewed source SHA256 (full frozen R4 delivery already committed):

- `control/windows/node/host.mjs`: `1b8f94139be7117090105aa1662b188d9fa18abd03c9d6927031d2ac96c2a48a`

- `control/windows/vbslike/manager/wmiserve-run.mjs`: `9f6ea7ecf1f3bf28337f808c0f3bd49fe255a82199d4f8e14730904f500aaf14`

- `control/windows/vbslike/manager/server.mjs`: `09085ceecb8dedab1c569b67db4998b8c46e5d360fc8aa2f83425b835c0db0dc`
