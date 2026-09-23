/* Nested-virtualization test, run as PID 1 inside a guest: load KVM, create a VM whose only
 * instruction is HLT, and KVM_RUN it. KVM_EXIT_HLT means a hypervisor can really run inside this
 * guest (VMRUN works) -- which is what Windows needs to start its own Hyper-V, and so VBS. */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/reboot.h>
#include <linux/kvm.h>

static void insmod(const char *p, const char *args) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("NEST insmod %s: open failed\n", p); return; }
    long r = syscall(SYS_finit_module, fd, args, 4);
    printf("NEST insmod %s -> %ld%s%s\n", p, r, r ? " errno=" : "", r ? strerror(errno) : ""); close(fd);
}
int main(void) {
    mount("proc", "/proc", "proc", 0, 0); mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    insmod("/irqbypass.ko.zst", ""); insmod("/ccp.ko.zst", ""); insmod("/kvm.ko.zst", ""); insmod("/kvm-amd.ko.zst", "");
    char kl[4096]; int kfd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK); long r;
    if (kfd >= 0) { while ((r = read(kfd, kl, sizeof kl - 1)) > 0) { kl[r] = 0;
        if (strcasestr(kl, "kvm") || strcasestr(kl, "svm") || strcasestr(kl, "SNP running"))
            printf("NEST kmsg %s", strchr(kl, ';') ? strchr(kl, ';') + 1 : kl); } close(kfd); }
    int kvm = open("/dev/kvm", O_RDWR | O_CLOEXEC);
    printf("NEST open /dev/kvm -> %d%s%s\n", kvm, kvm < 0 ? " " : "", kvm < 0 ? strerror(errno) : "");
    if (kvm < 0) goto out;
    printf("NEST api version %d\n", ioctl(kvm, KVM_GET_API_VERSION, 0));
    int vm = ioctl(kvm, KVM_CREATE_VM, 0); printf("NEST create vm -> %d\n", vm); if (vm < 0) goto out;
    unsigned char *mem = mmap(0, 0x10000, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    mem[0x1000] = 0xf4;                                            /* hlt */
    struct kvm_userspace_memory_region reg = { .slot = 0, .guest_phys_addr = 0, .memory_size = 0x10000,
                                               .userspace_addr = (unsigned long)mem };
    printf("NEST set memory -> %d\n", ioctl(vm, KVM_SET_USER_MEMORY_REGION, &reg));
    int vcpu = ioctl(vm, KVM_CREATE_VCPU, 0); printf("NEST create vcpu -> %d\n", vcpu); if (vcpu < 0) goto out;
    int sz = ioctl(kvm, KVM_GET_VCPU_MMAP_SIZE, 0);
    struct kvm_run *run = mmap(0, sz, PROT_READ | PROT_WRITE, MAP_SHARED, vcpu, 0);
    struct kvm_sregs s; ioctl(vcpu, KVM_GET_SREGS, &s); s.cs.base = 0; s.cs.selector = 0; ioctl(vcpu, KVM_SET_SREGS, &s);
    struct kvm_regs g; memset(&g, 0, sizeof g); g.rip = 0x1000; g.rflags = 2; ioctl(vcpu, KVM_SET_REGS, &g);
    int rr = ioctl(vcpu, KVM_RUN, 0);
    printf("NEST KVM_RUN -> %d%s%s exit_reason=%u (%s)\n", rr, rr < 0 ? " errno=" : "", rr < 0 ? strerror(errno) : "",
           run->exit_reason, run->exit_reason == KVM_EXIT_HLT ? "HLT: NESTED VIRTUALIZATION WORKS" :
           run->exit_reason == KVM_EXIT_FAIL_ENTRY ? "FAIL_ENTRY" : run->exit_reason == KVM_EXIT_INTERNAL_ERROR ? "INTERNAL_ERROR" : "other");
    if (run->exit_reason == KVM_EXIT_FAIL_ENTRY)
        printf("NEST hardware_entry_failure_reason=0x%llx\n", (unsigned long long)run->fail_entry.hardware_entry_failure_reason);
out:
    kfd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK);
    if (kfd >= 0) { lseek(kfd, 0, SEEK_END); close(kfd); }
    fflush(stdout); sync(); reboot(RB_POWER_OFF); return 0;
}
