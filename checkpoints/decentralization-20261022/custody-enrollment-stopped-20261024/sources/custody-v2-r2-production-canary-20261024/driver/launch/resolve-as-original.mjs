// Module resolve hook for the canary host copy: every specifier imported BY the copy resolves exactly as it would from
// the original custody/v2/host.mjs (relative modules and the source repo's node_modules), so the copy runs the
// unchanged host-side modules. Every other module resolves normally.
let copy = null, original = null;
export function initialize(data) {
  if (!data || typeof data.copy !== "string" || typeof data.original !== "string") throw Error("canary resolve: copy and original URLs required");
  ({ copy, original } = data);
}
export async function resolve(specifier, context, next) {
  if (context.parentURL === copy) return next(specifier, { ...context, parentURL: original });
  return next(specifier, context);
}
