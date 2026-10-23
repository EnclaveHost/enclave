// SPDX-License-Identifier: GPL-2.0
/* OpenHCL x86 guest vTPM transport for the measured Linux direct-boot path.
 * The loader currently supplies no TPM2 ACPI table. Its standard CRB registers
 * exist, but the two guest-owned command pages must first be assigned through
 * the Hyper-V TPM I/O ports. This driver supplies the normal Linux TPM interface.
 * It never accesses the host TPM or marks memory shared with the host.
 * Interface: microsoft/openvmm a7b0bd4, vm/devices/tpm/tpm_device/src/lib.rs.
 */
#include <linux/module.h>
#include <linux/device.h>
#include <linux/mm.h>
#include <linux/io.h>
#include <linux/ioport.h>
#include <asm/processor.h>
#include <asm/unaligned.h>
#include "tpm.h"

#define TPM_PORT 0x1040
#define CRB_BASE 0xfed40000
#define CRB_LENGTH 0x70
static void __iomem *regs;
static unsigned long pages;
static struct device *parent;
static struct tpm_chip *chip;

static u8 status(struct tpm_chip *c)
{
 return (readl(regs + 0x4c) & 1) ? 0 : 1;
}
static bool canceled(struct tpm_chip *c, u8 s)
{
 return !!readl(regs + 0x48);
}
static void cancel(struct tpm_chip *c)
{
 writel(1, regs + 0x48);
}
static int send(struct tpm_chip *c, u8 *buf, size_t len)
{
 if (len < TPM_HEADER_SIZE || len > PAGE_SIZE || get_unaligned_be32(buf + 2) != len)
  return -EINVAL;
 if (readl(regs + 0x4c) & 1) return -EBUSY;
 if (readl(regs + 0x44) & 1) return -EIO;
 writel(0, regs + 0x48);
 memset((void *)pages, 0, 2 * PAGE_SIZE);
 memcpy((void *)pages, buf, len);
 /* Command data must be visible to the paravisor before CRB start. */
 wmb();
 writel(1, regs + 0x4c);
 return 0;
}
static int recv(struct tpm_chip *c, u8 *buf, size_t cap)
{
 u8 *response = (u8 *)pages + PAGE_SIZE;
 u32 len;
 if (cap < TPM_HEADER_SIZE || (readl(regs + 0x4c) & 1) || (readl(regs + 0x44) & 1))
  return -EIO;
 rmb();
 len = get_unaligned_be32(response + 2);
 if (len < TPM_HEADER_SIZE || len > PAGE_SIZE || len > cap) return -EIO;
 memcpy(buf, response, len);
 return len;
}
static const struct tpm_class_ops ops = {
 .flags = TPM_OPS_AUTO_STARTUP,
 .req_complete_mask = 1, .req_complete_val = 1,
 .status = status, .req_canceled = canceled, .cancel = cancel,
 .send = send, .recv = recv,
};

static int __init start(void)
{
 unsigned a, b, c, d;
 int ret;
 phys_addr_t pa;
 cpuid(0x40000000, &a, &b, &c, &d);
 if (a < 0x4000000c || b != 0x7263694d || c != 0x666f736f || d != 0x76482074)
  return -ENODEV;
 cpuid(0x4000000c, &a, &b, &c, &d);
 if ((b & 15) != 1) return -ENODEV;
 if (!request_mem_region(CRB_BASE, CRB_LENGTH, "enclave-openhcl-tpm")) return -EBUSY;
 regs = ioremap(CRB_BASE, CRB_LENGTH);
 if (!regs) { ret = -ENOMEM; goto free_region; }
 if (readl(regs + 0x30) != 0x4011) { ret = -ENODEV; goto unmap; }
 if (!request_region(TPM_PORT, 8, "enclave-openhcl-tpm")) { ret = -EBUSY; goto unmap; }
 pages = __get_free_pages(GFP_KERNEL | GFP_DMA32 | __GFP_ZERO, 1);
 if (!pages) { ret = -ENOMEM; goto free_ports; }
 pa = virt_to_phys((void *)pages);
 if (pa + 2 * PAGE_SIZE > (1ULL << 32)) { ret = -ERANGE; goto free_buffers; }
 outl(1, TPM_PORT); outl((u32)pa, TPM_PORT + 4);
 if (readl(regs + 0x58) != PAGE_SIZE || readl(regs + 0x64) != PAGE_SIZE ||
     readl(regs + 0x5c) != pa || readl(regs + 0x60) ||
     readl(regs + 0x68) != pa + PAGE_SIZE || readl(regs + 0x6c)) {
  ret = -EIO; goto free_buffers;
 }
 parent = root_device_register("enclave-openhcl-tpm");
 if (IS_ERR(parent)) { ret = PTR_ERR(parent); goto free_buffers; }
 chip = tpmm_chip_alloc(parent, &ops);
 if (IS_ERR(chip)) { ret = PTR_ERR(chip); goto free_parent; }
 chip->flags |= TPM_CHIP_FLAG_TPM2;
 ret = tpm_chip_bootstrap(chip);
 if (ret) goto free_parent;
 ret = tpm_chip_register(chip);
 if (ret) goto free_parent;
 pr_info("enclave-openhcl-tpm: guest CRB transport ready\n");
 return 0;
free_parent:
 root_device_unregister(parent);
free_buffers:
 outl(1, TPM_PORT); outl(0, TPM_PORT + 4);
 free_pages(pages, 1);
free_ports:
 release_region(TPM_PORT, 8);
unmap:
 iounmap(regs);
free_region:
 release_mem_region(CRB_BASE, CRB_LENGTH);
 return ret;
}
/* Lifetime is the VM's lifetime. Do not permit unloading while OpenHCL holds
 * physical command-buffer addresses or while TPM users retain device handles. */
module_init(start);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Enclave OpenHCL guest TPM CRB transport");
