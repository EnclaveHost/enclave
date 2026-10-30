// What a host may write to its OWN registry entry, and when (docs/network/host-liveness.md). ONE rule for the Linux
// supervisor (supervisor.js) and the Windows node (windows/node/host.mjs). No imports: the measured supervisor image and
// the Windows deploy closure ship it as is.
//
// No phase ever sends a liveness write: liveness is off-chain (network/host-liveness.mjs).
//   boot      the process starting (a CVM's proof key is new on every boot): it may (re-)register its own row
//   explicit  a deliberate act: an owner re-enabling hosting, or the address book moving the registry
//   timer     every routine pass: it may correct an ACTIVE row it operates (price, proof key), and nothing else.
//             An inactive row is the operator's deregistration: a timer reports it and never undoes it.
// A row registered to another operator is never written, in any phase.

export const PHASES = Object.freeze(["boot", "explicit", "timer"]);
const ZERO = /^0x0{40}$/i;
const lc = (a) => String(a || "").toLowerCase();
const absent = (row) => !row || !row.operator || ZERO.test(String(row.operator));

/**
 * registrationAction(row, { operator, proofKey }, phase) -> { register: boolean, reason }
 *   row: this host's registry entry as read ({ operator, active, cpuPricePerSec6, proofKey }), or null when it has none
 *   register: true when register() may be sent now (an initial registration, or a deliberate re-registration)
 */
export function registrationAction(row, { operator, proofKey } = {}, phase = "timer") {
  if (!PHASES.includes(phase)) throw new Error(`unknown registration phase ${phase}`);
  if (absent(row)) return { register: true, reason: "not registered yet: the initial registration" };
  if (lc(row.operator) !== lc(operator)) return { register: false, reason: `registered to another operator (${row.operator})` };
  if (row.active !== true)
    return phase === "timer" ? { register: false, reason: "deregistered on chain by the operator key: a routine pass does not re-activate it" }
                             : { register: true, reason: `re-registration on ${phase}` };
  if (!(Number(row.cpuPricePerSec6) > 0)) return { register: true, reason: "registered without a price" };
  if (proofKey !== undefined && lc(row.proofKey) !== lc(proofKey)) return { register: true, reason: "the published proof key is not this host's" };
  return { register: false, reason: "current" };
}

/** May a routine pass correct this row's configuration (price, proof key)? Not an observed inactive row, and not one
 *  that names another (or no) operator. A partial in-memory row (no `active` / `operator` read yet) is not refused. */
export function mayReconcile(row, operator) {
  if (!row || row.active === false) return false;
  return row.operator === undefined || (!ZERO.test(String(row.operator)) && lc(row.operator) === lc(operator));
}
