import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./isolation-lifecycle.mjs";

test("resume holds a partition sized for an old purchase instead of silently adopting it", async () => {
  for (const share of [.15, .5]) {
    let spawned = false;
    const r = await reconcile({ client: {
      findByName: async () => ({ id: "existing", status: "running", memory: { rule: "cpu-share", cpuShare: .25, appMiB: 16384 } }),
      spawn: async () => { spawned = true; throw Error("must not double start"); }
    }, deployment: { id: "deployment", body: { cpuShare: share } } });
    assert.equal(r.action, "held");
    assert.equal(r.leaseFree, false);
    assert.equal(spawned, false);
    assert.match(r.reason, /different RAM share/);
  }
});
