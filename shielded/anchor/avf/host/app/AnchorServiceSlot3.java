/*
 * AnchorServiceSlot3 -- the same service in its own process (":slot3", AndroidManifest.xml), so one phone runs several protected VMs
 * at once, one per app (PVM-CPU.md "Slots by share"): every per-VM state in Main is per process, and the slot's files carry its
 * suffix (Main.slotSuffix).
 */
package host.enclave.anchor.avf;

public class AnchorServiceSlot3 extends AnchorService { }
