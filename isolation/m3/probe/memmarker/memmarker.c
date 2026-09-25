// SPDX-License-Identifier: GPL-2.0
/*
 * memmarker.ko - a PROBE, never part of a production medium: the guest half of the host memory-read experiment
 * (isolation/m3/VBS-ISOLATION.md section 3; the host half is enclave-d1's saved-state reader).
 *
 * It plants a run-unique random marker in two pages and says where they are, so a host-side reader can check
 * EXACT guest-physical addresses instead of searching for a string:
 *   private page  left as it is: on a VBS-isolated partition it stays host-private
 *   shared page   made host-visible with set_memory_decrypted(): on VBS this is hv_vtom_set_host_visibility, the
 *                 same call a VMBus ring uses; on an unisolated partition it is a no-op
 * A reader that finds the marker in BOTH pages on an unisolated partition passes its positive control. On a VBS
 * partition the SHARED page must still be found (the reader is reading THIS VM), and the PRIVATE page is the test.
 *
 * Each page is filled with repetitions of "ENCLAVE-MEMMARKER/1 <32 hex> PRIVATE " (or SHARED), so a partial or
 * offset read still carries the marker. The module stays loaded, and the pages stay resident, until it is removed.
 * Console: "MEMMARKER marker=<32 hex> private_gpa=0x... shared_gpa=0x... shared_visibility_rc=<n>".
 */
#include <linux/module.h>
#include <linux/gfp.h>
#include <linux/mm.h>
#include <linux/random.h>
#include <linux/set_memory.h>
#include <linux/string.h>
#include <asm/io.h>

static struct page *priv_page, *shared_page;
static int shared_rc = -1;

static void fill(u8 *p, const char *marker_hex, const char *kind)
{
	char unit[64];
	int n = scnprintf(unit, sizeof(unit), "ENCLAVE-MEMMARKER/1 %s %s ", marker_hex, kind), off;

	for (off = 0; off + n <= PAGE_SIZE; off += n)
		memcpy(p + off, unit, n);
}

static int __init memmarker_init(void)
{
	u8 raw[16];
	char hex[33];

	pr_crit("MEMMARKER probe: planting a run-unique marker in one private and one host-shared page (a probe image, not a production medium)\n");
	priv_page = alloc_page(GFP_KERNEL | __GFP_ZERO);
	shared_page = alloc_page(GFP_KERNEL | __GFP_ZERO);
	if (!priv_page || !shared_page) {
		pr_crit("MEMMARKER no memory\n");
		goto fail;
	}
	get_random_bytes(raw, sizeof(raw));
	bin2hex(hex, raw, sizeof(raw));
	hex[32] = 0;
	fill(page_address(priv_page), hex, "PRIVATE");
	fill(page_address(shared_page), hex, "SHARED");
	shared_rc = set_memory_decrypted((unsigned long)page_address(shared_page), 1);
	pr_crit("MEMMARKER marker=%s private_gpa=%#llx shared_gpa=%#llx shared_visibility_rc=%d\n", hex,
		(unsigned long long)page_to_phys(priv_page), (unsigned long long)page_to_phys(shared_page), shared_rc);
	return 0;
fail:
	if (priv_page)
		__free_page(priv_page);
	if (shared_page)
		__free_page(shared_page);
	return -ENOMEM;
}

static void __exit memmarker_exit(void)
{
	/* a page given back to the kernel must be private again, and must not carry the marker */
	if (shared_rc == 0 && set_memory_encrypted((unsigned long)page_address(shared_page), 1) != 0) {
		pr_crit("MEMMARKER could not make the shared page private again: leaking it\n");
		shared_page = NULL;
	}
	if (shared_page) {
		memset(page_address(shared_page), 0, PAGE_SIZE);
		__free_page(shared_page);
	}
	memset(page_address(priv_page), 0, PAGE_SIZE);
	__free_page(priv_page);
	pr_crit("MEMMARKER removed\n");
}

module_init(memmarker_init);
module_exit(memmarker_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("probe: a run-unique marker in one private and one host-shared page (Enclave isolation lane)");
