// A Node module-customisation hook for ONE check: the superseded-policy refusal at request release cannot be reached
// black-box (it needs evidence that verifies), so when the owner's web/pvm-client.js imports ./pvm-verify.js, that ONE
// import is answered with test/helpers/pvm-verify-stub.mjs (handed the real module's URL), whose verifyPvmAppEvidence
// accepts the lab relay's fabricated envelope. Every other import, including gate.js's and trust.js's own imports of
// pvm-verify.js, resolves to the owner's real module. Registered by pvm-verify-stub-register.mjs via --import.
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (specifier === "./pvm-verify.js" && /\/web\/pvm-client\.js$/.test(context.parentURL || ""))
    return { url: new URL(`./pvm-verify-stub.mjs?real=${encodeURIComponent(r.url)}`, import.meta.url).href, shortCircuit: true, format: "module" };
  return r;
}
