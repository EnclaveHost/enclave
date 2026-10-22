// node --import (test processes only): point the ACTUAL supervisor candidate's lease-gas runtime import at the loopback
// fixture adapter (test/helpers/linux-runtime-fixture.mjs). Prints one marker line so a test can prove it was used.
import { registerHooks } from "node:module";
const host = new URL("../../shadow-b/supervisor.js", import.meta.url).href;
const fixture = new URL("./linux-runtime-fixture.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === host && specifier === "./network/lease-gas-runtime.mjs") {
      console.log("[fixture] lease-gas runtime import redirected to the loopback test adapter");
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
