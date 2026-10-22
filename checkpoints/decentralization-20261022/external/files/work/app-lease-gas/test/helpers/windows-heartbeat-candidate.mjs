// Run the repository's unchanged actual-host heartbeat regression against the current isolated Windows candidate.
import { registerHooks } from "node:module";
const testUrl = new URL("../../../enclave/test/offchain-heartbeat-writers.test.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === testUrl && ["../windows/node/chain.mjs", "../windows/node/host.mjs"].includes(specifier)) {
      const url = new URL("../../shadow-win/" + specifier.slice(3), import.meta.url).href;
      console.log("[candidate-heartbeat] " + url);
      return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
