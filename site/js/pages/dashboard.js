/* ============================================================
   Dashboard page — the signed-in view: <c-terminal> (the deploy
   run log, live-following) over <c-deployments> (the My Apps
   panel). Both components are self-wiring; the page module only
   makes sure they're registered before the markup upgrades.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/terminal/terminal.js";
import "../../components/deployments/deployments.js";

export function boot() {}
