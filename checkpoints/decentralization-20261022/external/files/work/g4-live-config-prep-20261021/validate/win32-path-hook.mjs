// Resolve hook (node --import ./register.mjs): inside the two pinned CANDIDATE trees, `node:path` / `path` resolve to a
// module exporting path.win32, so the exact candidate validators judge the real Windows paths of the live config with
// Windows semantics on this Linux workstation. A module URL carrying "?posix" (and everything outside those trees) keeps
// the real POSIX path, used only to verify the local release files.
const TREES = [
  '/work/g4-network-composition-20261021/src/',
  '/work/challenge-host-tls-20261021/tree/',
];
const SHIM = 'data:text/javascript,' + encodeURIComponent(
  "import p from 'node:path'; const w = p.win32; export default w;" +
  " export const { sep, delimiter, basename, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, toNamespacedPath } = w;" +
  " export const posix = p.posix; export const win32 = w;");
export async function resolve(specifier, context, next) {
  const parent = context.parentURL || '';
  if ((specifier === 'node:path' || specifier === 'path') && TREES.some((t) => parent.includes(t)) && !parent.includes('?posix'))
    return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}
