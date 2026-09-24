// SPDX-License-Identifier: GPL-2.0
/*
 * appidmod: the guest half of the M4b admission protocol.
 *
 * WHY A MODULE. An SVSM protocol can only be invoked from guest ring 0, so a userspace process cannot ask the
 * SVSM to admit anything. This is the smallest ring-0 surface that lets the harness drive admission, and it
 * deliberately uses the ONE entry point a stock Linux guest exports to modules:
 *
 *     int snp_issue_svsm_attest_req(u64 call_id, struct svsm_call *call, struct svsm_attest_call *input)
 *
 * so no kernel patch is needed. That helper passes call_id straight to RAX, copies the caller's buffer into
 * this CPU's SVSM calling area and puts its physical address in RCX - which is why protocol 6 takes its
 * arguments in a descriptor rather than in RDX and R8: the helper overwrites both with -1.
 *
 * WHAT IT DOES NOT DO. It decides nothing. The plane's identity, the digests its artifacts must match, and
 * whether a report may be issued all live in the measured SVSM, and every call here is refused unless that
 * SVSM is satisfied. Its only privileges are "ask" and "allocate pages".
 *
 * TWO CONSTRAINTS THAT COST A RUN IF GOT WRONG, both found by review before the first boot:
 *
 *   1. ONE STAGING BUFFER PER KIND. An admitted artifact's pages are frozen READ-ONLY to this plane, so
 *      staging a second artifact into the same buffer writes to frozen pages - and a write to a frozen page
 *      does NOT fault: KVM's RMP-fault handler traces and returns for a 4 KiB entry, the store re-executes
 *      forever, and the vCPU livelocks with the guest apparently up.
 *   2. SPLIT BEFORE STAGING. vzalloc pages sit inside 2 MiB RMP entries, where a 4 KiB RMPADJUST returns
 *      FAIL_SIZEMISMATCH, so they must be cycled private->shared->private to force 4 KiB entries. That cycle
 *      goes through the SVSM's PVALIDATE path, which ZEROES every page it validates ("Zero out a page when it
 *      is validated and before giving other VMPLs access to it"). Splitting after staging therefore wipes the
 *      artifact and the hash never matches - the exact misleading failure the split was meant to avoid.
 *
 * So the order is: allocate, split, prove the buffer still works (the canary), stage, admit.
 *
 * Interface, crude because the harness is its only user:
 *
 *   slot      write 0|1  select the staging buffer (0 bundle, 1 runtime) and empty it
 *   artifact  write      the artifact's bytes, in PAGE_SIZE chunks, into the active slot
 *   admit     write 0|1  ADMIT that slot as that kind
 *   status    read       "admitted=0x.. required=0x.. kinds=N vmpl=N"
 *   whoami    read       the 32-byte app ID the SVSM names this plane, hex
 *   bind      write      32 bytes of hex, the binding a verifier chose
 *   report    write any  fetch a report; read back as hex
 *   result    read       the SVSM's own return code for the last call, so a refusal can be scored by REASON
 *   thaw      write <n>  ask the SVSM to PVALIDATE(invalid) page n of the active slot, which it must REFUSE
 *   poke      write      "<offset> <byte>" - write into the active slot. Only meaningful where the pages were
 *                        NOT frozen (the tampered run); on frozen pages it livelocks, see above.
 */
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/kobject.h>
#include <linux/sysfs.h>
#include <linux/slab.h>
#include <linux/mm.h>
#include <linux/vmalloc.h>
#include <linux/set_memory.h>
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
/* the SVSM core protocol, for the thaw probe */
#define CORE_PVALIDATE  ((0ULL << 32) | 1)

#define KIND_BUNDLE 0
#define KIND_RUNTIME 1
#define KIND_COUNT 2
#define LIST_ORDER 6                              /* 256 KiB of GPAs: 32768 pages = 128 MiB */

/* the descriptor protocol 6 reads: three little-endian u64s, placed in the SVSM calling area for us */
struct appid_desc {
	u64 a;
	u64 b;
	u64 c;
	u8 pad[sizeof(struct svsm_attest_call) - 24];
} __packed;

/*
 * The core protocol's PVALIDATE request, byte for byte the kernel's own svsm_pvalidate_call (asm/sev.h): a
 * header then `entries` u64s in ONE page. Each entry is bits 0-1 page size (0 = 4K), bit 2 action (1 validate,
 * 0 invalidate), bit 3 ignore_cf, bits 12-63 the GPA.
 */
struct pvalidate_req {
	u16 num_entries;
	u16 cur_index;
	u8 rsvd[4];
	u64 entry[1];
	u8 pad[sizeof(struct svsm_attest_call) - 16];
} __packed;

struct slot {
	void *mem;
	size_t len;
	size_t cap;
	u64 *list;
	bool split_ok;
};
static struct slot slots[KIND_COUNT];
static int active;
static const size_t slot_cap[KIND_COUNT] = {
	[KIND_BUNDLE] = 4UL * 1024 * 1024,        /* a contract bundle: tens of KiB in practice */
	[KIND_RUNTIME] = 64UL * 1024 * 1024,      /* the runtime image: wasmtime 48.0.1 is 45,616,736 bytes */
};

static void *outbuf;                              /* two pages: replies, then the report buffer */
static u8 bind_val[32];
static u8 report[4096];
static size_t report_len;
static struct kobject *appid_kobj;
static u64 last_rax_out;
static int last_ret;

static int svsm_call(u64 call_id, void *req)
{
	struct svsm_call call = {};
	int ret;

	ret = snp_issue_svsm_attest_req(call_id, &call, (struct svsm_attest_call *)req);
	last_rax_out = call.rax_out;
	last_ret = ret;
	if (ret)
		pr_info("appid: call 0x%llx -> %d (rax_out=0x%llx)\n", call_id, ret, call.rax_out);
	return ret;
}

static int appid_call(u64 call_id, struct appid_desc *desc)
{
	BUILD_BUG_ON(sizeof(struct appid_desc) != sizeof(struct svsm_attest_call));
	BUILD_BUG_ON(sizeof(struct pvalidate_req) != sizeof(struct svsm_attest_call));
	return svsm_call(call_id, desc);
}

/* force 4 KiB RMP granularity, then prove the buffer is still usable. The cycle zeroes the pages, which is
 * why this runs before staging; the canary makes "the buffer was wiped" its own diagnosis. */
static int slot_split(struct slot *sl)
{
	size_t pages = sl->cap / PAGE_SIZE;
	unsigned long addr = (unsigned long)sl->mem;
	u8 *p = sl->mem;
	int e;

	e = set_memory_decrypted(addr, pages);
	if (e) {
		pr_err("appid: set_memory_decrypted(%zu pages) = %d\n", pages, e);
		return e;
	}
	e = set_memory_encrypted(addr, pages);
	if (e) {
		pr_err("appid: set_memory_encrypted(%zu pages) = %d\n", pages, e);
		return e;
	}
	if (p[0] != 0 || p[sl->cap - 1] != 0) {
		pr_err("appid: canary: a just-validated page is not zero\n");
		return -EIO;
	}
	p[0] = 0xa5;
	p[sl->cap - 1] = 0x5a;
	if (READ_ONCE(p[0]) != 0xa5 || READ_ONCE(p[sl->cap - 1]) != 0x5a) {
		pr_err("appid: canary: the split buffer is not writable\n");
		return -EIO;
	}
	p[0] = 0;
	p[sl->cap - 1] = 0;
	sl->split_ok = true;
	pr_info("appid: slot %ld split: %zu pages at 4 KiB entries, canary ok\n", sl - slots, pages);
	return 0;
}

static ssize_t slot_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	struct slot *sl = &slots[active];

	return sysfs_emit(buf, "slot=%d len=%zu cap=%zu pages=%zu split=%d list_gpa=0x%llx\n",
			  active, sl->len, sl->cap, (sl->len + PAGE_SIZE - 1) / PAGE_SIZE,
			  sl->split_ok, (u64)virt_to_phys(sl->list));
}

static ssize_t slot_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	unsigned int which;

	if (kstrtouint(buf, 0, &which) || which >= KIND_COUNT)
		return -EINVAL;
	active = which;
	slots[active].len = 0;
	return n;
}

static ssize_t artifact_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct slot *sl = &slots[active];

	if (!sl->mem)
		return -ENOMEM;
	if (!sl->split_ok)
		return -EPERM;
	if (sl->len + n > sl->cap)
		return -ENOSPC;
	memcpy((u8 *)sl->mem + sl->len, buf, n);
	sl->len += n;
	return n;
}

static size_t build_page_list(struct slot *sl)
{
	size_t pages = (sl->len + PAGE_SIZE - 1) / PAGE_SIZE;
	size_t i;

	for (i = 0; i < pages; i++)
		sl->list[i] = (u64)vmalloc_to_pfn((u8 *)sl->mem + i * PAGE_SIZE) << PAGE_SHIFT;
	return pages;
}

static ssize_t admit_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct appid_desc desc = {};
	struct slot *sl;
	unsigned int kind;
	size_t pages;
	int ret;

	if (kstrtouint(buf, 0, &kind) || kind >= KIND_COUNT)
		return -EINVAL;
	sl = &slots[kind];
	if (!sl->mem || !sl->len || !sl->split_ok)
		return -EINVAL;
	pages = build_page_list(sl);
	desc.a = virt_to_phys(sl->list);
	desc.b = sl->len;
	desc.c = kind;
	ret = appid_call(CALL_ADMIT, &desc);
	pr_info("appid: admit kind=%u pages=%zu len=%zu -> %d\n", kind, pages, sl->len, ret);
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
		return sysfs_emit(buf, "error=%d rax_out=0x%llx\n", ret, last_rax_out);
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
		return sysfs_emit(buf, "error=%d rax_out=0x%llx\n", ret, last_rax_out);
	return sysfs_emit(buf, "%*phN\n", 32, (u8 *)outbuf);
}

static ssize_t bind_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	if (hex2bin(bind_val, buf, sizeof(bind_val)))
		return -EINVAL;
	return n;
}

static ssize_t report_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct appid_desc desc = {};
	int ret;

	memcpy(outbuf, bind_val, sizeof(bind_val));
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

static ssize_t result_show(struct kobject *k, struct kobj_attribute *a, char *buf)
{
	return sysfs_emit(buf, "ret=%d rax_out=0x%llx\n", last_ret, last_rax_out);
}

/*
 * thaw: ask the SVSM to PVALIDATE(invalid) one page of the active slot. For an ADMITTED page it must be
 * REFUSED - that is the non-hanging way to show the artifact cannot be thawed, unlike writing to a frozen
 * page, which livelocks the vCPU. Write "<page index> <0|1> [2m]": the second field is the action
 * (0 invalidate, 1 validate), and index -1 means "the first page past what was staged", which is how the
 * UNADMITTED control finds a page without assuming how large the artifact is.
 *
 * A 2 MiB entry is masked down to a 2 MiB boundary, because core_pvalidate_one checks alignment BEFORE the
 * admitted-region hook and returns INVALID_PARAMETER (0x80000005) for a 2 MiB entry that is only 4 KiB
 * aligned - which a vmalloc page almost always is. Without the mask the 2 MiB control printed "refused"
 * without the hook ever running, and a scorer reading "refused" would pass it vacuously.
 *
 * If the SVSM's admitted-region hook were missing, the invalidate would SUCCEED and the next read of that page
 * would crash the guest with a #VC - loud, and acceptable for a test.
 */
static ssize_t thaw_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct pvalidate_req req = {};
	struct slot *sl = &slots[active];
	long idx;
	unsigned int action;
	char size[8] = {0};
	bool huge;
	u64 gpa;
	int ret;

	if (!sl->mem || sscanf(buf, "%ld %u %7s", &idx, &action, size) < 2)
		return -EINVAL;
	if (action > 1)
		return -EINVAL;
	if (idx < 0) {
		/* the first page past what was staged: unadmitted whatever the artifact's size */
		idx = (sl->len + PAGE_SIZE - 1) / PAGE_SIZE;
		if ((size_t)idx >= sl->cap / PAGE_SIZE)
			return -ENOSPC;
	}
	if ((size_t)idx >= sl->cap / PAGE_SIZE)
		return -EINVAL;
	huge = strcmp(size, "2m") == 0;
	gpa = (u64)vmalloc_to_pfn((u8 *)sl->mem + idx * PAGE_SIZE) << PAGE_SHIFT;
	/* a 2 MiB entry must be 2 MiB aligned or the alignment check refuses it before the hook runs */
	gpa &= huge ? ~0x1fffffULL : ~0xfffULL;
	req.num_entries = 1;
	req.cur_index = 0;
	req.entry[0] = gpa | (action ? 4 : 0) | (huge ? 1 : 0);
	ret = svsm_call(CORE_PVALIDATE, &req);
	pr_info("appid: pvalidate idx=%ld gpa=0x%llx action=%u%s -> %d (rax_out=0x%llx, cur_index=%u)\n",
		idx, gpa, action, huge ? " 2m" : "", ret, last_rax_out, req.cur_index);
	return ret ? -EACCES : n;
}

static ssize_t poke_store(struct kobject *k, struct kobj_attribute *a, const char *buf, size_t n)
{
	struct slot *sl = &slots[active];
	unsigned long off;
	unsigned int val;

	if (!sl->mem || sscanf(buf, "%lu %u", &off, &val) != 2)
		return -EINVAL;
	if (off >= sl->cap)
		return -EINVAL;
	pr_info("appid: poke slot=%d offset=%lu value=%u: writing NOW\n", active, off, val);
	WRITE_ONCE(((u8 *)sl->mem)[off], (u8)val);
	pr_info("appid: poke returned; byte now reads %u\n", READ_ONCE(((u8 *)sl->mem)[off]));
	return n;
}

static struct kobj_attribute slot_attr = __ATTR(slot, 0644, slot_show, slot_store);
static struct kobj_attribute artifact_attr = __ATTR(artifact, 0644, slot_show, artifact_store);
static struct kobj_attribute admit_attr = __ATTR(admit, 0200, NULL, admit_store);
static struct kobj_attribute status_attr = __ATTR(status, 0444, status_show, NULL);
static struct kobj_attribute whoami_attr = __ATTR(whoami, 0444, whoami_show, NULL);
static struct kobj_attribute bind_attr = __ATTR(bind, 0200, NULL, bind_store);
static struct kobj_attribute report_attr = __ATTR(report, 0644, report_show, report_store);
static struct kobj_attribute result_attr = __ATTR(result, 0444, result_show, NULL);
static struct kobj_attribute thaw_attr = __ATTR(thaw, 0200, NULL, thaw_store);
static struct kobj_attribute poke_attr = __ATTR(poke, 0200, NULL, poke_store);

static struct attribute *appid_attrs[] = {
	&slot_attr.attr, &artifact_attr.attr, &admit_attr.attr, &status_attr.attr, &whoami_attr.attr,
	&bind_attr.attr, &report_attr.attr, &result_attr.attr, &thaw_attr.attr, &poke_attr.attr, NULL,
};
ATTRIBUTE_GROUPS(appid);

/*
 * slots[i].mem is deliberately never freed. Once the SVSM has frozen an artifact's pages they are read-only to
 * this plane for the life of the guest, and handing them back to the allocator would give the kernel memory it
 * cannot write. Leaking them is the correct behaviour, and saying so beats hiding it.
 */
static void appid_free_lists(void)
{
	int i;

	for (i = 0; i < KIND_COUNT; i++) {
		if (slots[i].list) {
			free_pages((unsigned long)slots[i].list, LIST_ORDER);
			slots[i].list = NULL;
		}
	}
}

static int __init appid_init(void)
{
	int i, e;

	for (i = 0; i < KIND_COUNT; i++) {
		slots[i].cap = slot_cap[i];
		slots[i].mem = vzalloc(slots[i].cap);
		if (!slots[i].mem) {
			appid_free_lists();
			return -ENOMEM;
		}
		slots[i].list = (u64 *)__get_free_pages(GFP_KERNEL | __GFP_ZERO, LIST_ORDER);
		if (!slots[i].list) {
			appid_free_lists();
			return -ENOMEM;
		}
		if (slots[i].cap / PAGE_SIZE > (PAGE_SIZE << LIST_ORDER) / sizeof(u64)) {
			pr_err("appid: the page list cannot describe slot %d\n", i);
			appid_free_lists();
			return -EINVAL;
		}
		e = slot_split(&slots[i]);      /* BEFORE staging: the cycle zeroes these pages */
		if (e) {
			appid_free_lists();
			return e;
		}
	}
	outbuf = (void *)__get_free_pages(GFP_KERNEL | __GFP_ZERO, 1);
	if (!outbuf) {
		appid_free_lists();
		return -ENOMEM;
	}
	appid_kobj = kobject_create_and_add("appid", kernel_kobj);
	if (!appid_kobj) {
		free_pages((unsigned long)outbuf, 1);
		appid_free_lists();
		return -ENOMEM;
	}
	if (sysfs_create_groups(appid_kobj, appid_groups)) {
		kobject_put(appid_kobj);
		free_pages((unsigned long)outbuf, 1);
		appid_free_lists();
		return -ENOMEM;
	}
	pr_info("appid: bundle slot %zu bytes, runtime slot %zu bytes, both split, replies at 0x%llx\n",
		slots[KIND_BUNDLE].cap, slots[KIND_RUNTIME].cap, (u64)virt_to_phys(outbuf));
	return 0;
}

static void __exit appid_exit(void)
{
	sysfs_remove_groups(appid_kobj, appid_groups);
	kobject_put(appid_kobj);
	pr_info("appid: unloaded; staging pages stay allocated because they may be frozen read-only\n");
}

module_init(appid_init);
module_exit(appid_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Enclave M4b: ask the measured SVSM to admit this plane's artifacts");
