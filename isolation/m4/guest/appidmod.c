// SPDX-License-Identifier: GPL-2.0
/*
 * appidmod: the guest half of the M4b admission protocol.
 *
 * WHY A MODULE. An SVSM protocol can only be invoked from guest ring 0, so a userspace process cannot ask
 * the SVSM to admit anything. This module is the smallest ring-0 surface that lets the harness drive
 * admission, and it deliberately uses the ONE entry point a stock Linux guest exports to modules:
 *
 *     int snp_issue_svsm_attest_req(u64 call_id, struct svsm_call *call, struct svsm_attest_call *input)
 *
 * so no kernel patch is needed. That function passes call_id straight to RAX, copies the caller's buffer
 * into this CPU's SVSM calling area and puts its physical address in RCX - which is exactly why protocol 6
 * takes its arguments in a descriptor rather than in RDX and R8: the helper overwrites both with -1.
 *
 * WHAT IT DOES NOT DO. It does not decide anything. It cannot: the plane's identity, the digests its
 * artifacts must match and whether a report may be issued all live in the measured SVSM, and every call here
 * is refused unless that SVSM is satisfied. This module's only privileges are "ask" and "allocate a
 * physically contiguous buffer for the artifact".
 *
 * Interface, one file, deliberately crude because the harness is its only user:
 *
 *   /sys/kernel/appid/artifact   write:  the artifact's bytes (append into a vmalloc staging buffer)
 *   /sys/kernel/appid/admit      write:  "<kind>"  -> ADMIT the bytes written so far as that kind
 *   /sys/kernel/appid/status     read:   "admitted=0x%x required=0x%x vmpl=%d"
 *   /sys/kernel/appid/whoami     read:   the 32-byte app ID the SVSM names this plane, hex
 *   /sys/kernel/appid/report     write a 32-byte hex bind, then read the report, base64-free (hex)
 *   /sys/kernel/appid/poke       write:  "<offset> <byte>" -> try to WRITE the admitted artifact region,
 *                                        which must FAIL once the SVSM has frozen it. That failure is the
 *                                        hardware half of the evidence, so it needs a way to be attempted.
 */
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/kobject.h>
#include <linux/sysfs.h>
#include <linux/slab.h>
#include <linux/mm.h>
#include <linux/vmalloc.h>
#include <linux/io.h>
#include <linux/string.h>
#include <linux/kstrtox.h>
#include <linux/hex.h>
#include <asm/io.h>
#include <asm/sev.h>

#define APPID_PROTOCOL 6
#define APPID_CALL(n) ((((u64)APPID_PROTOCOL) << 32) | (n))
#define CALL_GET_REPORT APPID_CALL(0)
#define CALL_WHOAMI     APPID_CALL(1)
#define CALL_ADMIT      APPID_CALL(2)
#define CALL_STATUS     APPID_CALL(3)

/* the descriptor protocol 6 reads: three little-endian u64s, placed in the SVSM calling area for us */
struct appid_desc {
	u64 a;
	u64 b;
	u64 c;
	u8 pad[sizeof(struct svsm_attest_call) - 24];
} __packed;

/*
 * The artifact is staged in VMALLOC memory, not in contiguous pages, and the page list is what goes to the
 * SVSM. A runtime image is tens of megabytes (wasmtime 48.0.1 is 45,616,736 bytes) and __get_free_pages tops
 * out at 4 MiB, so physical contiguity is not a property a guest can supply at realistic sizes. The LIST is
 * contiguous and small: 8 bytes per page, so 88 KiB describes a 45 MiB artifact.
 */
#define ARTIFACT_CAP (64UL * 1024 * 1024)
#define LIST_ORDER 6                              /* 256 KiB: enough for 32768 pages = 128 MiB */
static void *artifact;
static size_t artifact_len;
static size_t artifact_cap;
static u64 *page_list;
static void *outbuf;                              /* one page for the SVSM's replies */
static u8 bind[32];
static u8 report[4096];
static size_t report_len;
static struct kobject *appid_kobj;

static int appid_call(u64 call_id, struct appid_desc *desc)
{
	struct svsm_call call = {};
	int ret;

	BUILD_BUG_ON(sizeof(struct appid_desc) != sizeof(struct svsm_attest_call));
	ret = snp_issue_svsm_attest_req(call_id, &call, (struct svsm_attest_call *)desc);
	if (ret)
		pr_info("appid: call %llu -> %d (rax_out=%llu)\n", call_id & 0xffffffff, ret, call.rax_out);
	return ret;
}

static ssize_t artifact_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	if (!artifact)
		return -ENOMEM;
	if (artifact_len + n > artifact_cap)
		return -ENOSPC;
	memcpy((u8 *)artifact + artifact_len, buf, n);
	artifact_len += n;
	return n;
}

static ssize_t artifact_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	return sysfs_emit(buf, "len=%zu cap=%zu pages=%zu list_gpa=0x%llx\n", artifact_len, artifact_cap,
			  (artifact_len + PAGE_SIZE - 1) / PAGE_SIZE,
			  page_list ? (u64)virt_to_phys(page_list) : 0);
}

/* the artifact's pages, in order, as guest physical addresses: what protocol 6 reads */
static size_t build_page_list(void)
{
	size_t pages = (artifact_len + PAGE_SIZE - 1) / PAGE_SIZE;
	size_t i;

	for (i = 0; i < pages; i++)
		page_list[i] = (u64)vmalloc_to_pfn((u8 *)artifact + i * PAGE_SIZE) << PAGE_SHIFT;
	return pages;
}

/* "reset" empties the staging buffer so a test can try a second, different artifact */
static ssize_t reset_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	artifact_len = 0;
	return n;
}

static ssize_t admit_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct appid_desc desc = {};
	unsigned int kind;
	size_t pages;
	int ret;

	if (!artifact || !artifact_len)
		return -EINVAL;
	if (kstrtouint(buf, 0, &kind))
		return -EINVAL;
	pages = build_page_list();
	desc.a = virt_to_phys(page_list);
	desc.b = artifact_len;
	desc.c = kind;
	ret = appid_call(CALL_ADMIT, &desc);
	pr_info("appid: admit kind=%u pages=%zu len=%zu list_gpa=0x%llx -> %d\n",
		kind, pages, artifact_len, desc.a, ret);
	return ret ? -EACCES : n;
}

static ssize_t status_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	struct appid_desc desc = {};
	u8 *out = outbuf;
	int ret;

	memset(out, 0, 8);
	desc.a = virt_to_phys(outbuf);
	ret = appid_call(CALL_STATUS, &desc);
	if (ret)
		return sysfs_emit(buf, "error=%d\n", ret);
	return sysfs_emit(buf, "admitted=0x%02x required=0x%02x kinds=%u vmpl=%u\n",
			  out[0], out[1], out[2], out[3]);
}

static ssize_t whoami_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	struct appid_desc desc = {};
	int ret;

	memset(outbuf, 0, 32);
	desc.a = virt_to_phys(outbuf);
	ret = appid_call(CALL_WHOAMI, &desc);
	if (ret)
		return sysfs_emit(buf, "error=%d\n", ret);
	return sysfs_emit(buf, "%*phN\n", 32, (u8 *)outbuf);
}

static ssize_t bind_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	if (hex2bin(bind, buf, sizeof(bind)))
		return -EINVAL;
	return n;
}

static ssize_t report_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct appid_desc desc = {};
	int ret;

	memcpy(outbuf, bind, sizeof(bind));
	desc.a = virt_to_phys(outbuf);                  /* the 32-byte bind */
	desc.b = virt_to_phys(outbuf) + PAGE_SIZE;      /* the report buffer, the next page */
	desc.c = PAGE_SIZE;
	ret = appid_call(CALL_GET_REPORT, &desc);
	pr_info("appid: get_report -> %d, svsm says %llu bytes\n", ret, desc.c);
	if (ret)
		return -EACCES;
	report_len = min_t(size_t, desc.c, sizeof(report));
	memcpy(report, (u8 *)outbuf + PAGE_SIZE, report_len);
	return n;
}

static ssize_t report_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	size_t i, n = 0;

	for (i = 0; i < report_len && n + 2 < PAGE_SIZE; i++)
		n += sysfs_emit_at(buf, n, "%02x", report[i]);
	n += sysfs_emit_at(buf, n, "\n");
	return n;
}

/*
 * poke: attempt a WRITE into the artifact region. Before admission it succeeds; after the SVSM has frozen
 * the pages with RMPADJUST it must not. This is the only way to show the hardware half from inside the
 * guest, and it is why the module exists rather than a userspace mmap of the same pages.
 */
static ssize_t poke_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	unsigned long off;
	unsigned int val;

	if (!artifact || sscanf(buf, "%lu %u", &off, &val) != 2)
		return -EINVAL;
	if (off >= artifact_cap)
		return -EINVAL;
	pr_info("appid: poke offset=%lu value=%u: writing to the artifact region NOW\n", off, val);
	WRITE_ONCE(((u8 *)artifact)[off], (u8)val);
	pr_info("appid: poke returned; byte now reads %u\n", READ_ONCE(((u8 *)artifact)[off]));
	return n;
}

static struct kobj_attribute artifact_attr = __ATTR(artifact, 0644, artifact_show, artifact_store);
static struct kobj_attribute reset_attr = __ATTR(reset, 0200, NULL, reset_store);
static struct kobj_attribute admit_attr = __ATTR(admit, 0200, NULL, admit_store);
static struct kobj_attribute status_attr = __ATTR(status, 0444, status_show, NULL);
static struct kobj_attribute whoami_attr = __ATTR(whoami, 0444, whoami_show, NULL);
static struct kobj_attribute bind_attr = __ATTR(bind, 0200, NULL, bind_store);
static struct kobj_attribute report_attr = __ATTR(report, 0644, report_show, report_store);
static struct kobj_attribute poke_attr = __ATTR(poke, 0200, NULL, poke_store);

static struct attribute *appid_attrs[] = {
	&artifact_attr.attr, &reset_attr.attr, &admit_attr.attr, &status_attr.attr,
	&whoami_attr.attr, &bind_attr.attr, &report_attr.attr, &poke_attr.attr, NULL,
};
ATTRIBUTE_GROUPS(appid);

static int __init appid_init(void)
{
	artifact_cap = ARTIFACT_CAP;
	artifact = vzalloc(artifact_cap);
	if (!artifact)
		return -ENOMEM;
	page_list = (u64 *)__get_free_pages(GFP_KERNEL | __GFP_ZERO, LIST_ORDER);
	if (!page_list) {
		vfree(artifact);
		return -ENOMEM;
	}
	if (artifact_cap / PAGE_SIZE > (PAGE_SIZE << LIST_ORDER) / sizeof(u64)) {
		pr_err("appid: the page list cannot describe a full staging buffer\n");
		free_pages((unsigned long)page_list, LIST_ORDER);
		vfree(artifact);
		return -EINVAL;
	}
	/* two pages: replies, and the report buffer immediately after */
	outbuf = (void *)__get_free_pages(GFP_KERNEL | __GFP_ZERO, 1);
	if (!outbuf) {
		free_pages((unsigned long)page_list, LIST_ORDER);
		vfree(artifact);
		return -ENOMEM;
	}
	appid_kobj = kobject_create_and_add("appid", kernel_kobj);
	if (!appid_kobj) {
		free_pages((unsigned long)outbuf, 1);
		return -ENOMEM;
	}
	if (sysfs_create_groups(appid_kobj, appid_groups)) {
		kobject_put(appid_kobj);
		free_pages((unsigned long)outbuf, 1);
		return -ENOMEM;
	}
	pr_info("appid: staging %zu bytes of vmalloc, page list at gpa 0x%llx, replies at 0x%llx\n",
		artifact_cap, (u64)virt_to_phys(page_list), (u64)virt_to_phys(outbuf));
	return 0;
}

/*
 * No exit path frees the artifact pages: once the SVSM has frozen them they are read-only to this plane for
 * the life of the guest, and handing them back to the page allocator would give the kernel memory it cannot
 * write. Leaking them on unload is the correct behaviour, and the module says so rather than hiding it.
 */
static void __exit appid_exit(void)
{
	sysfs_remove_groups(appid_kobj, appid_groups);
	kobject_put(appid_kobj);
	pr_info("appid: unloaded; the artifact pages stay allocated because they may be frozen read-only\n");
}

module_init(appid_init);
module_exit(appid_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Enclave M4b: ask the measured SVSM to admit this plane's artifacts");
