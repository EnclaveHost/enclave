/* posix-stubs/linux/vm_sockets.h -- AF_VSOCK types so worker.cu compiles, and
 * so its EXISTING failure path does the right thing.
 *
 * AF_VSOCK is a Linux address family. Windows' equivalent is AF_HYPERV, which
 * is addressed by a (VmId, ServiceId) GUID pair rather than (cid, port) -- a
 * different model, not a rename. So rather than fake it, AF_VSOCK is defined to
 * the Linux value, which Winsock does not implement: socket(AF_VSOCK, ...)
 * fails with WSAEAFNOSUPPORT, win-compat.h maps that to EAFNOSUPPORT, and
 * worker.cu's own handler logs
 *
 *     vsock unavailable (...); TCP only
 *
 * which is exactly the correct outcome. The Windows low-latency path is a
 * separate AF_HYPERV listener (see win-compat.h), not this family.
 *
 * Note the guest needs no equivalent change: Linux backs AF_VSOCK with its
 * hv_sock transport over VMBus, so wasm/ggml-shielded/shielded-wire.c connects
 * with the same AF_VSOCK code on Hyper-V as on QEMU.
 */
#ifndef SHIELDED_STUB_LINUX_VM_SOCKETS_H
#define SHIELDED_STUB_LINUX_VM_SOCKETS_H
#include <winsock2.h>

#ifndef AF_VSOCK
#define AF_VSOCK 40                 /* Linux's value; unimplemented on Winsock */
#endif
#define VMADDR_CID_ANY  ((unsigned int)-1U)
#define VMADDR_CID_HOST 2U

struct sockaddr_vm {
    unsigned short svm_family;
    unsigned short svm_reserved1;
    unsigned int   svm_port;
    unsigned int   svm_cid;
    unsigned char  svm_zero[4];
};
#endif
