// SPDX-License-Identifier: GPL-2.0
/*
 * g4panic.ko - a PROBE module, NEVER production (enclave-63's G4, measured on enclave-d1's request).
 *
 * The question it answers is Hyper-V's, not ours: what does a type-1 (VBS) partition under OpenHCL do when its VTL0
 * kernel requests a restart after a panic? That is what happens when the monitor, PID 1, dies. The kernel panics
 * ("Attempted to kill init!", kernel/exit.c), and this guest kernel has CONFIG_PANIC_TIMEOUT=-1
 * (IKCONFIG of 363b3553), so panic() calls emergency_restart() at once.
 *
 * So this module does not kill the monitor. It calls panic() itself, after a fixed delay, and reaches the SAME tail
 * (panic notifiers including Hyper-V's crash report, then emergency_restart). The production initrd and monitor carry
 * no exit path: this rides build-probe.sh's second archive as /probe.ko, which dominit loads once, after its guards,
 * announcing "MON PROBE IMAGE". A probe image's hash is never a production image's.
 *
 * The delay is FIXED (dominit passes no module parameters): long enough to load an app and see it serve first. Every
 * line goes to the console (COM1), where the run reads it.
 */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/workqueue.h>

#define G4_DELAY_S 120

static struct delayed_work g4_work;

static void g4_fire(struct work_struct *w)
{
	pr_emerg("MON PROBE G4: panicking ON PURPOSE after %d s: the path a dead PID 1 takes (panic, then panic_timeout)\n", G4_DELAY_S);
	panic("G4 probe: deliberate panic standing in for the monitor's death");
}

static int __init g4_init(void)
{
	INIT_DELAYED_WORK(&g4_work, g4_fire);
	schedule_delayed_work(&g4_work, G4_DELAY_S * HZ);
	pr_emerg("MON PROBE G4: armed, this guest will panic on purpose in %d s (panic_timeout=%d)\n", G4_DELAY_S, panic_timeout);
	return 0;
}
module_init(g4_init);
/* no module_exit: the probe cannot be unloaded, so it cannot be disarmed silently either */

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("PROBE ONLY: a deliberate panic after a fixed delay, to measure the host's handling of a VTL0 restart");
