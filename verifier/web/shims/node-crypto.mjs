// The browser bundle's stand-in for node:crypto: the modules the web entry shares with Node (verifier/snp.mjs,
// verifier/tls-binding.mjs, relay/snp-verify.mjs) import it at the top, but the web path never calls it; anything that
// does throws, loudly, rather than compute a wrong answer.
const gone = (name) => function () { throw new Error(`node:crypto ${name} is not available in the browser build`); };
export const createHash = gone("createHash"), createVerify = gone("createVerify"), verify = gone("verify"), sign = gone("sign");
export const randomBytes = gone("randomBytes"), createPublicKey = gone("createPublicKey"), createPrivateKey = gone("createPrivateKey");
export const constants = Object.freeze({});
export class X509Certificate { constructor() { throw new Error("node:crypto X509Certificate is not available in the browser build"); } }
export default { createHash, createVerify, verify, sign, randomBytes, createPublicKey, createPrivateKey, constants, X509Certificate };
