// The browser bundle's stand-in for node:zlib (verifier/envelope.mjs imports gunzipSync for parseEnvelope, which the web
// entry does not call: it decodes with DecompressionStream).
const gone = (name) => function () { throw new Error(`node:zlib ${name} is not available in the browser build`); };
export const gunzipSync = gone("gunzipSync"), gzipSync = gone("gzipSync");
export default { gunzipSync, gzipSync };
