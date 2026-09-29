/* Disposable guest-only diagnostic. Never install on a production image. */
#include <linux/module.h>
#include <linux/miscdevice.h>
#include <linux/mm.h>
#include <linux/ioport.h>
#include <linux/io.h>
#include <asm/processor.h>
static unsigned long pages;
static struct resource *ports;
static int map_pages(struct file *f, struct vm_area_struct *v)
{
 if (v->vm_pgoff || v->vm_end-v->vm_start != 2*PAGE_SIZE || !(v->vm_flags & VM_SHARED)) return -EINVAL;
 vm_flags_set(v, VM_DONTEXPAND | VM_DONTDUMP);
 return remap_pfn_range(v,v->vm_start,virt_to_phys((void*)pages)>>PAGE_SHIFT,2*PAGE_SIZE,v->vm_page_prot);
}
static const struct file_operations ops={.owner=THIS_MODULE,.mmap=map_pages};
static struct miscdevice dev={.minor=MISC_DYNAMIC_MINOR,.name="enclave-tpm-probe",.fops=&ops,.mode=0600};
static int __init start(void)
{
 unsigned a,b,c,d; int ret; void __iomem *crb;
 cpuid(0x40000000,&a,&b,&c,&d);
 if (a<0x4000000c || b!=0x7263694d || c!=0x666f736f || d!=0x76482074) return -ENODEV;
 cpuid(0x4000000c,&a,&b,&c,&d); if((b&15)!=1) return -ENODEV;
 crb=ioremap(0xfed40000,PAGE_SIZE); if(!crb)return -ENOMEM;
 ret=readl(crb+0x30)==0x4011?0:-ENODEV; iounmap(crb); if(ret)return ret;
 ports=request_region(0x1040,8,"enclave-tpm-probe"); if(!ports)return -EBUSY;
 pages=__get_free_pages(GFP_KERNEL|GFP_DMA32|__GFP_ZERO,1);
 if(!pages){release_region(0x1040,8);return -ENOMEM;}
 ret=misc_register(&dev); if(ret){free_pages(pages,1);release_region(0x1040,8);return ret;}
 outl(1,0x1040);outl((u32)virt_to_phys((void*)pages),0x1044);
 pr_info("TPMPROBE guest-only diagnostic transport installed\n");return 0;
}
static void __exit stop(void){misc_deregister(&dev);release_region(0x1040,8);free_pages(pages,1);}
module_init(start);module_exit(stop);MODULE_LICENSE("GPL");
