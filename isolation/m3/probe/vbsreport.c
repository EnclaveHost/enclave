// SPDX-License-Identifier: GPL-2.0
/*
 * vbsreport.ko - a PROBE, never part of a production medium: ONE HvCallVbsVmCallReport (0xC001) from VTL0,
 * printed to the console, for the VBS report-chain experiment (isolation/m3/VBS-ISOLATION.md).
 *
 * The question it answers: in a VBS-isolated partition (Hyper-V GuestStateIsolationType 1), may VTL0 ask the
 * hypervisor for a VBS VM report, and what signs it? The report is printed as hex so the host can check its
 * signature against the keys the same boot's measured-boot log carries (windows/vbs/tools). The layout is
 * openvmm's hvdef::vbs::VbsReport (0x230 bytes; the hypercall's output page holds up to 2048).
 *
 * report_data (64 bytes) = "ENCLAVE-VBS-REPORT-PROBE/1" zero-padded, then the 32 bytes of the `nonce` parameter
 * (hex) if given: a fixed marker, so a report cannot be mistaken for anything this guest would ever serve.
 *
 * It does its one call at load and then refuses to stay loaded (returns -ENODEV), so nothing remains resident.
 */
#include <linux/module.h>
#include <linux/gfp.h>
#include <linux/string.h>
#include <linux/hex.h>
#include <asm/mshyperv.h>

#define HVCALL_VBS_VM_CALL_REPORT 0xC001
#define VBS_REPORT_DATA_SIZE 64
#define VBS_MAX_REPORT_SIZE 2048

/*
 * hv_do_hypercall()'s ordinary path, without its TDX branch: hv_tdx_hypercall is not exported to modules, and
 * neither the TDX nor the SNP-without-paravisor path applies to a VBS partition (they are refused below).
 */
static u64 vbs_hypercall(u64 control, void *input, void *output)
{
	u64 input_address = virt_to_phys(input);
	u64 output_address = virt_to_phys(output);
	u64 hv_status;

	if (!hv_hypercall_pg)
		return U64_MAX;
	__asm__ __volatile__("mov %4, %%r8\n"
			     CALL_NOSPEC
			     : "=a" (hv_status), ASM_CALL_CONSTRAINT,
			       "+c" (control), "+d" (input_address)
			     :  "r" (output_address),
				THUNK_TARGET(hv_hypercall_pg)
			     : "cc", "memory", "r8", "r9", "r10", "r11");
	return hv_status;
}

static char *nonce = "";
module_param(nonce, charp, 0);
MODULE_PARM_DESC(nonce, "32 bytes of hex placed in report_data[32:64]");

static int __init vbsreport_init(void)
{
	u8 *in, *out;
	u64 status;
	u32 len, i;

	pr_crit("VBSREPORT probe: one HvCallVbsVmCallReport from VTL0 (a probe image, not a production medium)\n");
	in = (u8 *)__get_free_page(GFP_KERNEL | __GFP_ZERO);
	out = (u8 *)__get_free_page(GFP_KERNEL | __GFP_ZERO);
	if (!in || !out) {
		pr_crit("VBSREPORT no memory\n");
		goto done;
	}
	memcpy(in, "ENCLAVE-VBS-REPORT-PROBE/1", 26);
	if (strlen(nonce) == 64 && hex2bin(in + 32, nonce, 32) != 0)
		pr_crit("VBSREPORT nonce is not 64 hex characters; report_data[32:64] left zero\n");
	if (hv_isolation_type_snp() || hv_isolation_type_tdx()) {
		pr_crit("VBSREPORT this partition is SNP- or TDX-isolated, not VBS: no call made\n");
		goto done;
	}
	status = vbs_hypercall(HVCALL_VBS_VM_CALL_REPORT, in, out);
	pr_crit("VBSREPORT status=%#llx (low 16 bits: 0 = success, 2 = invalid hypercall code, 3 = invalid input, 6 = access denied)\n", status);
	if (status == U64_MAX) {
		pr_crit("VBSREPORT no hypercall page: not running on Hyper-V\n");
		goto done;
	}
	if ((status & 0xffff) != 0)
		goto done;
	len = *(u32 *)out;             /* VbsReportPackageHeader.package_size */
	if (len == 0 || len > VBS_MAX_REPORT_SIZE)
		len = VBS_MAX_REPORT_SIZE;
	pr_crit("VBSREPORT package_size=%u version=%u signature_scheme=%u signature_size=%u\n",
		*(u32 *)out, *(u32 *)(out + 4), *(u32 *)(out + 8), *(u32 *)(out + 12));
	for (i = 0; i < len; i += 32)
		pr_crit("VBSREPORT %04x %*phN\n", i, (int)min_t(u32, 32, len - i), out + i);
	pr_crit("VBSREPORT end len=%u\n", len);
done:
	if (in)
		free_page((unsigned long)in);
	if (out)
		free_page((unsigned long)out);
	return -ENODEV;
}

module_init(vbsreport_init);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("probe: one VBS VM report from VTL0 (Enclave isolation lane)");
