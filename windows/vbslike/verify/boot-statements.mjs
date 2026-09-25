// boot-statements.mjs - the ONE table pairing a WMI partition's name with its guest-image kind (enclave-99's contract,
// main ae6e9147, "Launcher statements"; the signed report's names are canonical). Shared by the launcher that states the
// pair (manager/wmi-launcher.mjs), the judge that reads a report (verify/judge-hv.mjs) and the data plane that routes on
// the record (datapath/datapath.mjs), so none of them keeps its own copy to drift. It has no imports: judge-hv stays
// portable and separate from the launcher.
//
// Neither field is identity. Both are LAUNCHER STATEMENTS (the monitor-signed T0-hv tier, host_excluded=no). An image
// hash is only ever compared together with the statement that says what kind of hash it is, never alone: the same 64
// hex under the other partition or kind is a different claim and is refused.
export const BOOT_STATEMENTS = Object.freeze({
  "uefi-medium": Object.freeze({ partition: "wmi-openhcl-gen2", guestImageKind: "uefi-medium" }),
  "linux-direct": Object.freeze({ partition: "wmi-openhcl-gen2-igvm-linux", guestImageKind: "igvm-linux-direct" }),
});
/** The boot form a (partition, guestImageKind) pair states: EXACT equality with one row, else null. No prefixes. */
export function bootFormOfStatement(partition, guestImageKind) {
  for (const [form, st] of Object.entries(BOOT_STATEMENTS))
    if (partition === st.partition && guestImageKind === st.guestImageKind) return form;
  return null;
}
/** Is this a partition name the table knows? A report or record naming one is compared as a PAIR, never by image alone. */
export function isStatedPartition(partition) {
  return Object.values(BOOT_STATEMENTS).some((st) => st.partition === partition);
}
